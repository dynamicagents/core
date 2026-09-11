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
import { readHumanReply, type TurnWake } from "./hitl.js";

/**
 * Derive a deterministic workflow instance id for a turn. Keyed on the gatekeeper's
 * `messageId` (stable across dispatch retries), so re-creating it is a no-op —
 * the turn runs exactly once. Sanitized to the id charset.
 */
export function workflowIdForMessage(
  messageId: string,
  prefix = "turn"
): string {
  return `${prefix}-${messageId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * Everything the executor knows about an accepted turn, handed to the
 * consumer's {@link TurnStarter}.
 *
 * Core stops here deliberately: which workflow runs the turn, what else its
 * params carry, and which binding it is created on are all the agent's, so core
 * describes the turn and the agent starts it.
 */
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

/**
 * Start the durable turn. **Must be idempotent**: a dispatch retry calls it
 * again with the same {@link AcceptedTurn.messageId}, and the conventional
 * implementation swallows the workflow's "instance already exists" race — see
 * {@link workflowIdForMessage} and {@link ignoreAlreadyExists}.
 */
export type TurnStarter = (turn: AcceptedTurn) => Promise<void>;

/**
 * Wake the run a Task is parked in, once its question has an answer or can no
 * longer get one.
 *
 * **Must tolerate a wake nobody needed** — a retried answer, a question already
 * closed — because the run reads what happened from the Durable Object, never
 * from the event.
 */
export type TurnResumer = (wake: TurnWake) => Promise<void>;

export interface ExecutorConfig {
  identity: GatekeeperIdentity;
  /** This agent's card-signing JWKS URL — the callback JWT `jku`. */
  jku: string;
  resolveAgent: AgentResolver;
  startTurn: TurnStarter;
  /**
   * Wake a Task's run once a question it asked is answered. Absent on an agent
   * whose Tasks never ask, and the Worker refuses a message on one of them.
   */
  resumeTurn?: TurnResumer;
}

/**
 * Run `create` and swallow the "instance already exists" retry race, so a
 * {@link TurnStarter} is idempotent in the one way that actually happens.
 *
 * ```ts
 * startTurn: (turn) =>
 *   ignoreAlreadyExists(() =>
 *     env.HANDLE_TASK_WORKFLOW.create({
 *       id: workflowIdForMessage(turn.messageId),
 *       params: { ...turn }
 *     })
 *   )
 * ```
 */
export async function ignoreAlreadyExists(
  create: () => Promise<unknown>
): Promise<void> {
  try {
    await create();
  } catch (err) {
    if (err instanceof Error && /already exists|exist/i.test(err.message)) {
      return;
    }
    throw err;
  }
}

/**
 * A2A executor for the **async accept + notify** contract. On `SendMessage` it
 * does not block on generation: it records a `submitted` task in the caller's DO
 * (idempotent on `messageId`), hands the turn to a durable workflow, and
 * publishes the accepted task immediately as the response. The workflow
 * generates the reply and POSTs it to the gatekeeper's push-notification webhook
 * out of band.
 *
 * The verified caller identity comes from the config — the outer Worker builds
 * one executor per verified request. The push config comes from the request
 * itself: v1.0 hands the executor the whole `SendMessageRequest` via
 * {@link RequestContext.request}, so nothing has to be threaded around it.
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
    // asked — the Worker refuses any other kind before this runs. It resumes the
    // Task that is waiting, and must never begin a second one.
    if (requestContext.task) {
      await this.continueTask(requestContext, eventBus);
      return;
    }

    const text = textOf(requestContext.userMessage);
    const messageId = requestContext.userMessage.messageId;
    const contextId = requestContext.contextId;

    // `identity.key` is guaranteed non-null: the Worker rejects a keyless
    // identity (400) before constructing this executor.
    const stub = this.config.resolveAgent(this.config.identity);

    // Record (or reuse) the submitted task, then start the durable turn. Both
    // are idempotent, so a dispatch retry heals a crash between the two.
    const accepted = await stub.beginTask({
      messageId,
      taskId: requestContext.taskId,
      contextId
    });
    // Widened in one explicit step: DO-stub returns come back through
    // Cloudflare's RPC type mapping, and letting that mapped type flow into a
    // generic SDK call site instead exceeds TypeScript's instantiation depth on
    // the v1.0 (proto-generated) model.
    const task: Task = accepted;

    await this.config.startTurn({
      messageId,
      taskId: accepted.id,
      contextId,
      text,
      identity: this.config.identity,
      pushUrl: pushConfig.url,
      pushToken: pushConfig.token,
      jku: this.config.jku
    });

    // The accept ack: a `submitted` task, not a Message. Returned synchronously.
    eventBus.publish(AgentEvent.task(task));
    eventBus.finished();
  };

  /**
   * A reply onto a parked Task: record it, wake the run, and answer with the
   * Task as it now stands.
   *
   * Nothing here throws on purpose. The handler turns an executor throw into a
   * failed Task, which would end the Task a person was answering. A wake that
   * cannot be sent is logged instead: the answer is already recorded, so the run
   * finds it when its own wait runs out — late, and still correct.
   */
  private async continueTask(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    // Loaded by the handler from the Durable Object's own row.
    const parked: Task = requestContext.task as Task;
    const stub = this.config.resolveAgent(this.config.identity);
    const reply = readHumanReply(requestContext.userMessage);

    let current: Task = parked;
    // Refused at the Worker when either is missing; checked again because the
    // price of a throw here is the Task.
    if (reply && stub.answerTask && this.config.resumeTurn) {
      const answered = await stub.answerTask({
        taskId: parked.id,
        messageId: requestContext.userMessage.messageId,
        reply
      });
      if (answered.task) current = answered.task;
      if (answered.wake) {
        try {
          await this.config.resumeTurn(answered.wake);
        } catch (err) {
          console.error("[executor] could not wake the run a reply was for", {
            taskId: parked.id,
            err: String(err)
          });
        }
      }
    }

    eventBus.publish(AgentEvent.task(current));
    eventBus.finished();
  }

  /**
   * `CancelTask`: best-effort mark the task canceled in the DO and publish the
   * canceled task. The in-flight workflow's `notify` step skips a canceled task.
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
