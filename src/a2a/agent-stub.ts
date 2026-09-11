import type { Task, TaskState } from "@a2a-js/sdk";
import type { GatekeeperIdentity } from "./verify.js";
import type { PlainTask } from "./task.js";
import type { HumanReply, TurnWake } from "./hitl.js";

/**
 * The task-lifecycle surface core calls on an agent Durable Object, declared
 * structurally so core never imports a consumer's DO class.
 *
 * A consumer's `DurableObjectStub<MyAgent>` satisfies this by construction:
 * Cloudflare's RPC type mapping wraps each return in `Promise<Serializable<T>>`,
 * and every type below is already `Serializable` — that is precisely why
 * {@link PlainTask} exists (see {@link file://./task.ts}).
 *
 * `listTasks` is optional. `ListTasks` is new in A2A v1.0 and an agent that does
 * not keep a queryable task history simply omits it; {@link DurableTaskStore}
 * then answers the RPC with `UnsupportedOperationError` instead of failing at
 * the binding. Everything else is mandatory — they are the accept-and-notify
 * contract.
 */
export interface TaskAgent {
  /**
   * Record (or reuse) the `submitted` task for a turn. **Must be idempotent on
   * `messageId`**: the gatekeeper retries dispatch, and the executor relies on this
   * plus a deterministic workflow id to make a turn run exactly once.
   */
  beginTask(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): Promise<PlainTask>;

  getTask(taskId: string): Promise<PlainTask | null>;

  /** Returns false when the write was refused (e.g. the task is already terminal). */
  saveTask(task: Task): Promise<boolean>;

  /** Marks the task canceled and returns it, or null when there is no such task. */
  cancelTask(taskId: string): Promise<PlainTask | null>;

  listTasks?(query: TaskListQuery): Promise<TaskListPage>;

  /**
   * Record a person's reply to a question one of this caller's Tasks asked, and
   * say which run to wake. Idempotent on `messageId`: the gatekeeper retries a
   * continuation like any other message.
   *
   * Optional, like `listTasks`. An agent whose Tasks never ask leaves it out.
   */
  answerTask?(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<AnsweredTask>;

  /**
   * The run to wake for a Task canceled while it waited on a question, or `null`
   * when it was not waiting. Optional for the same reason as `answerTask`.
   */
  humanWake?(taskId: string): Promise<TurnWake | null>;
}

/** What recording a reply did, for the executor to act on. */
export interface AnsweredTask {
  /** The Task as it now stands — what the continuation is answered with. */
  task: PlainTask | null;
  /** The run to wake, or `null` when the reply named no question of this Task. */
  wake: TurnWake | null;
}

export interface TaskListQuery {
  contextId?: string;
  state?: TaskState;
  /** Epoch ms; matches the `updated_at` column stamped on every status write. */
  updatedAfter?: number;
  includeArtifacts: boolean;
  historyLength?: number;
  limit: number;
  offset: number;
}

export interface TaskListPage {
  tasks: Task[];
  /** Total matching rows, ignoring `limit`/`offset` — drives `nextPageToken`. */
  totalSize: number;
}

/**
 * Resolve the agent DO stub for a verified caller.
 *
 * Supplied by the consumer because addressing is theirs: core does not know the
 * binding name, and the identity→instance mapping is a product decision. The
 * conventional implementation keys one DO instance per `identity.key`, which is
 * what makes a task unreachable from any other caller by construction.
 */
export type AgentResolver = (identity: GatekeeperIdentity) => TaskAgent;
