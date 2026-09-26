import type { Task, TaskState } from "@a2a-js/sdk";
import type { GatekeeperIdentity } from "./verify.js";
import type { PlainTask } from "./task.js";
import type { HumanReply } from "./hitl.js";
import type { AcceptedTurn } from "./executor.js";

/**
 * The task-lifecycle surface core calls on an agent Durable Object, declared
 * structurally so core's edge never imports the agent class.
 *
 * `A2AAgent` implements it. A consumer's `DurableObjectStub<MyAgent>` satisfies
 * it by construction: Cloudflare's RPC type mapping wraps each return in
 * `Promise<Serializable<T>>`, and every type below is already `Serializable` —
 * that is precisely why {@link PlainTask} exists (see {@link file://./task.ts}).
 */
export interface TaskAgent {
  /**
   * Record (or reuse) the `submitted` task for a turn and submit the turn.
   * **Idempotent on `messageId`**: the gatekeeper retries dispatch, and a turn
   * runs once.
   */
  acceptTask(turn: AcceptedTurn): Promise<PlainTask>;

  getTask(taskId: string): Promise<PlainTask | null>;

  /** Returns false when the write was refused (e.g. the task is already terminal). */
  saveTask(task: Task): Promise<boolean>;

  /** Marks the task canceled and returns it, or null when it could not be. */
  cancelTask(taskId: string): Promise<PlainTask | null>;

  /**
   * `ListTasks` is new in A2A v1.0; {@link DurableTaskStore} answers the RPC
   * with `UnsupportedOperationError` for an agent that omits it.
   */
  listTasks?(query: TaskListQuery): Promise<TaskListPage>;

  /**
   * Record a person's reply to a question one of this caller's Tasks asked, and
   * return the Task as it now stands. Idempotent on `messageId`, which the
   * gatekeeper derives from the question.
   */
  answerTask(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<PlainTask | null>;
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
 * Resolve the agent DO stub for a verified caller. The conventional
 * implementation keys one instance per `identity.key`, which is what makes a
 * task unreachable from any other caller by construction.
 */
export type AgentResolver = (identity: GatekeeperIdentity) => TaskAgent;
