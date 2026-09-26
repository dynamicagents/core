import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import type { Task } from "@a2a-js/sdk";
import type { GatekeeperIdentity } from "./verify.js";
import type { AgentResolver } from "./agent-stub.js";
import { textOf } from "./parts.js";

/** Everything the executor knows about an accepted turn. */
export interface AcceptedTurn {
  /** The gatekeeper's message id — the idempotency key for the whole turn. */
  messageId: string;
  taskId: string;
  contextId: string;
  /** The caller's message, flattened to text. */
  text: string;
  identity: GatekeeperIdentity;
  /** Webhook the terminal task is POSTed to. */
  pushUrl: string;
  /** Per-task validation token echoed on the callback. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku`. */
  jku: string;
}

export interface ExecutorConfig {
  identity: GatekeeperIdentity;
  /** This agent's card-signing JWKS URL — the callback JWT `jku`. */
  jku: string;
  resolveAgent: AgentResolver;
}

/**
 * A2A executor for the **async accept + notify** contract. On `SendMessage` it
 * does not block on generation: one `acceptTask` call records the `submitted`
 * task in the caller's object and submits its turn durably, both idempotent on
 * `messageId`, and the accepted task is published at once as the response. The
 * reply is POSTed to the gatekeeper's push webhook out of band.
 *
 * The verified caller identity comes from the config — the outer Worker builds
 * one executor per verified request. The push config comes from the request
 * itself: v1.0 hands the executor the whole `SendMessageRequest` via
 * {@link RequestContext.request}.
 */
export class A2AExecutor implements AgentExecutor {
  constructor(private readonly config: ExecutorConfig) {}

  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const pushConfig =
      requestContext.request.configuration?.taskPushNotificationConfig;
    // Defensive: the Worker validates url + token before the executor runs, and
    // must keep doing so — a throw here is turned into a `failed` task by the
    // request handler, not into the JSON-RPC error the caller needs to see.
    if (!pushConfig?.url || !pushConfig.token) {
      throw new Error("taskPushNotificationConfig url and token are required");
    }

    // A message naming a Task that exists is a reply to a question the Task
    // asked. The Worker records it before the handler runs — a throw here
    // fails the Task the person was answering — so what is left is to answer
    // with the Task as the handler loaded it. It must never begin a second one.
    if (requestContext.task) {
      eventBus.publish(AgentEvent.task(requestContext.task));
      eventBus.finished();
      return;
    }

    // `identity.key` is guaranteed non-null: the Worker rejects a keyless
    // identity (400) before constructing this executor.
    const accepted = await this.config
      .resolveAgent(this.config.identity)
      .acceptTask({
        messageId: requestContext.userMessage.messageId,
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        text: textOf(requestContext.userMessage),
        identity: this.config.identity,
        pushUrl: pushConfig.url,
        pushToken: pushConfig.token,
        jku: this.config.jku
      });
    // Widened in one explicit step: DO-stub returns come back through
    // Cloudflare's RPC type mapping, and letting that mapped type flow into a
    // generic SDK call site exceeds TypeScript's instantiation depth on the
    // v1.0 (proto-generated) model.
    const task: Task = accepted;

    // The accept ack: a `submitted` task, not a Message. Returned synchronously.
    eventBus.publish(AgentEvent.task(task));
    eventBus.finished();
  };

  /**
   * `CancelTask`: mark the task canceled in the object, which stops its work,
   * and publish the canceled task.
   */
  cancelTask = async (
    taskId: string,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const task = await this.config
      .resolveAgent(this.config.identity)
      .cancelTask(taskId);
    if (task) eventBus.publish(AgentEvent.task(task));
    eventBus.finished();
  };
}
