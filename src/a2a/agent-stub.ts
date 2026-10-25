import type { Task, TaskState } from "@a2a-js/sdk";
import type { VerifiedCaller } from "./caller-scope.js";
import type { PlainTask } from "./task.js";
import type { HumanReply } from "./hitl.js";
import type { AcceptedTurn } from "./executor.js";

/**
 * The task-lifecycle surface core calls on a task host Durable Object, declared
 * structurally so core's edge never imports the host class.
 *
 * `TaskHost` implements it. A consumer's `DurableObjectStub<MyHost>` satisfies
 * it by construction: Cloudflare's RPC type mapping wraps each return in
 * `Promise<Serializable<T>>`, and every type below is already `Serializable` —
 * that is precisely why {@link PlainTask} exists (see {@link file://./task.ts}).
 */
export interface TaskAgent {
  /**
   * Record (or reuse) the `submitted` task for a message and start its
   * workflow. **Idempotent on `messageId`**: the gatekeeper retries dispatch,
   * and a task runs once.
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
   * Record a person's reply to a request one of this caller's Tasks asked, and
   * return whether this reply was taken: false for one naming no request the
   * Task still has open, which a reply arriving after the Task ended, or after
   * an earlier copy of it was taken, finds; `refused`, with why, for answers
   * that do not fit the questions asked. Idempotent on `messageId`, which the
   * gatekeeper derives from the request.
   */
  answerTask(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<boolean | { refused: string }>;

  /**
   * Record a message that joins one of this caller's open Tasks: the next
   * message of the same conversation, for the work already running. `closed`
   * when the Task has ended, or takes no such message now: the caller starts a
   * new Task with it instead. Idempotent on `messageId`.
   */
  joinTask(input: {
    taskId: string;
    messageId: string;
    text: string;
  }): Promise<"joined" | "closed">;
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
 * implementation keys one instance per `caller.scope`, which is what makes a
 * task unreachable from any other caller by construction: see
 * {@link file://./caller-scope.ts VerifiedCaller} for what that name binds, and
 * {@link file://../worker/define-agent.ts defineAgent} for the implementation
 * every agent here uses.
 */
export type AgentResolver = (caller: VerifiedCaller) => TaskAgent;
