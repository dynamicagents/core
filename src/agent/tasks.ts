import { Task, TaskState } from "@a2a-js/sdk";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import { buildSubmittedTask } from "../a2a/notify.js";
import type { TurnPushContext } from "../a2a/push.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";

/**
 * The A2A task ledger, on the object's own SQLite.
 *
 * Two rules hold the lifecycle together, and both live here:
 *
 *  - **Every transition is a guarded write.** An `UPDATE … WHERE state IN (…)`
 *    decides, and the rows it wrote are the verdict. A caller that reads the
 *    state and then acts reopens the window in which a cancel lands and the
 *    gatekeeper still gets a `completed`.
 *  - **Open work keeps a task alive across turns.** A detached sub-agent run or
 *    a scheduled wake is a `da_a2a_work` row, and settlement asks this table —
 *    not the model — whether the task is finished.
 *
 * Every side effect a transition owes — the callback, the settle hooks, a
 * follow-up turn, an answer's turn — is recorded **in the same statement** as
 * the transition, and
 * cleared once it has happened. An object evicted in between finds the record
 * at its next start and finishes the job; see `A2AAgent.onStart`.
 *
 * `CREATE TABLE IF NOT EXISTS`, and storage outlives a deploy: a caller's
 * object keeps these rows across every version of this code. So the schema may
 * only grow in ways that statement already covers — a changed or added column
 * needs a versioned migration, as the Artifacts store keeps one
 * (`CURRENT_SCHEMA_VERSION` in `src/artifacts/store.ts`).
 */

/** The states a task never leaves. */
const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

/** The states a task can still move out of. */
const OPEN = ["submitted", "working", "input-required"];

/** Rows older than this are swept by the retention task. */
export const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function isTerminalState(state: string): boolean {
  return TERMINAL.has(state);
}

/**
 * What a work row records. Every sub-agent run is one, so a run's progress can
 * be traced to its task; only `detached` and `wait` hold a task open.
 */
export type WorkKind = "awaited" | "detached" | "wait";

export interface WorkRow {
  workId: string;
  taskId: string;
  kind: WorkKind;
  /** The sub-agent class for a run, or `check_back` for a wait. */
  name: string;
  /** The schedule a `wait` is parked on. */
  scheduleId: string | null;
  /** What the spec's `prepare` returned for a run, for its `settle`. */
  runtime: Record<string, unknown> | undefined;
  open: boolean;
  /** Whether the run's `settle` has been claimed. */
  settled: boolean;
}

/** A follow-up turn a closed work row owes its task, until that turn has run. */
export interface FollowUp {
  /** The user message's id, and the submission's idempotency key. */
  id: string;
  text: string;
}

/** One task row, less the blob. */
export interface TaskRow {
  taskId: string;
  messageId: string | null;
  contextId: string;
  state: string;
  push: TurnPushContext | null;
  identity: GatekeeperIdentity | null;
  submissionId: string | null;
  /** The question the task is parked on, or `null` when it is not parked. */
  request: HitlRequestData | null;
  /**
   * The callback still owed, or `null`: the settled state, or
   * `input-required:<requestId>` for a question. Keyed on the event rather than
   * the state, so a delivery of an earlier question can never stand in for, or
   * clear, a later one.
   */
  deliveryKey: string | null;
  /** Whether the settle hooks are still owed. */
  hooksPending: boolean;
  /** An answer the task resumed on, whose turn is not yet submitted. */
  answer: FollowUp | null;
}

/** What {@link A2ATasks.list} is asked for — the `ListTasks` filters. */
export interface TaskListFilter {
  contextId?: string;
  state?: TaskState;
  updatedAfter?: number;
  includeArtifacts: boolean;
  historyLength?: number;
  limit: number;
  offset: number;
}

/** The tagged-template `sql` every `Agent` exposes. */
export type Sql = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

interface StoredTask {
  task_id: string;
  message_id: string | null;
  context_id: string;
  state: string;
  task_json: string;
  push_json: string | null;
  identity_json: string | null;
  submission_id: string | null;
  request_json: string | null;
  delivery_key: string | null;
  hooks_pending: number;
  answer_json: string | null;
}

interface StoredWork {
  work_id: string;
  task_id: string;
  kind: string;
  name: string;
  schedule_id: string | null;
  runtime_json: string | null;
  follow_up_json: string | null;
  open: number;
  settled: number;
}

export class A2ATasks {
  #ensured = false;

  constructor(private readonly sql: Sql) {}

  /**
   * Run before the first statement rather than at construction: an agent builds
   * this in a field initializer, before its storage is usable.
   */
  #ensure(): void {
    if (this.#ensured) return;
    this.sql`CREATE TABLE IF NOT EXISTS da_a2a_tasks (
      task_id TEXT PRIMARY KEY,
      message_id TEXT UNIQUE,
      context_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      task_json TEXT NOT NULL,
      push_json TEXT,
      identity_json TEXT,
      submission_id TEXT,
      request_json TEXT,
      delivery_key TEXT,
      hooks_pending INTEGER NOT NULL DEFAULT 0,
      answer_json TEXT,
      push_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_a2a_work (
      work_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      schedule_id TEXT,
      runtime_json TEXT,
      follow_up_json TEXT,
      open INTEGER NOT NULL DEFAULT 1,
      settled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS da_a2a_work_task
      ON da_a2a_work (task_id, open)`;
    this.#ensured = true;
  }

  // --- reads ---------------------------------------------------------------

  #stored(taskId: string): StoredTask | null {
    this.#ensure();
    return (
      this.sql<StoredTask>`
        SELECT * FROM da_a2a_tasks WHERE task_id = ${taskId}`[0] ?? null
    );
  }

  row(taskId: string): TaskRow | null {
    const row = this.#stored(taskId);
    return row ? project(row) : null;
  }

  get(taskId: string): PlainTask | null {
    const row = this.#stored(taskId);
    return row ? parse(row.task_json) : null;
  }

  list(query: TaskListFilter): { tasks: PlainTask[]; totalSize: number } {
    this.#ensure();
    const contextId = query.contextId ?? "";
    const state = query.state === undefined ? "" : taskStateLabel(query.state);
    const updatedAfter = query.updatedAfter ?? 0;
    // Neutral sentinels rather than a built-up WHERE: the tagged template takes
    // values, not fragments.
    const rows = this.sql<StoredTask>`
      SELECT * FROM da_a2a_tasks
      WHERE (${contextId} = '' OR context_id = ${contextId})
        AND (${state} = '' OR state = ${state})
        AND updated_at >= ${updatedAfter}
      ORDER BY created_at DESC
      LIMIT ${query.limit} OFFSET ${query.offset}`;
    const total = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM da_a2a_tasks
      WHERE (${contextId} = '' OR context_id = ${contextId})
        AND (${state} = '' OR state = ${state})
        AND updated_at >= ${updatedAfter}`;
    return {
      tasks: rows.map((r) => shape(parse(r.task_json), query)),
      totalSize: total[0]?.n ?? 0
    };
  }

  /** Callbacks owed and not yet acknowledged. */
  pendingDeliveries(): { taskId: string; key: string }[] {
    this.#ensure();
    return this.sql<{ task_id: string; delivery_key: string }>`
      SELECT task_id, delivery_key FROM da_a2a_tasks
      WHERE delivery_key IS NOT NULL`.map((r) => ({
      taskId: r.task_id,
      key: r.delivery_key
    }));
  }

  /** Tasks owing an answer's turn. */
  pendingAnswers(): string[] {
    this.#ensure();
    return this.sql<{ task_id: string }>`
      SELECT task_id FROM da_a2a_tasks WHERE answer_json IS NOT NULL`.map(
      (r) => r.task_id
    );
  }

  /** Tasks whose settle hooks are owed. */
  pendingHooks(): string[] {
    this.#ensure();
    return this.sql<{ task_id: string }>`
      SELECT task_id FROM da_a2a_tasks WHERE hooks_pending = 1`.map(
      (r) => r.task_id
    );
  }

  // --- writes --------------------------------------------------------------

  /**
   * Record (or reuse) the `submitted` task for a turn, with everything the
   * turn will need to call back. Idempotent on `messageId`: the gatekeeper
   * retries dispatch, and a retry must land on the task the first one made.
   */
  accept(input: {
    messageId: string;
    taskId: string;
    contextId: string;
    push: TurnPushContext;
    identity: GatekeeperIdentity;
  }): TaskRow {
    this.#ensure();
    const existing = this.sql<StoredTask>`
      SELECT * FROM da_a2a_tasks WHERE message_id = ${input.messageId}`[0];
    if (existing) return project(existing);

    const task = buildSubmittedTask(input.taskId, input.contextId);
    const now = Date.now();
    this.sql`INSERT INTO da_a2a_tasks
      (task_id, message_id, context_id, state, task_json, push_json,
       identity_json, created_at, updated_at)
      VALUES (${task.id}, ${input.messageId}, ${task.contextId},
              ${taskStateLabel(task.status.state)}, ${serialize(task)},
              ${JSON.stringify(input.push)}, ${JSON.stringify(input.identity)},
              ${now}, ${now})`;
    return project(this.#stored(task.id)!);
  }

  bindSubmission(taskId: string, submissionId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET submission_id = ${submissionId}
      WHERE task_id = ${taskId} AND submission_id IS NULL`;
  }

  /**
   * The next progress key for a task.
   *
   * A durable counter rather than a clock or the content: the gatekeeper
   * dedupes on `${taskId}:${key}`, so a key must be distinct between two posts
   * and never reused by a later one.
   */
  nextPushKey(taskId: string, prefix: string): string {
    this.#ensure();
    const rows = this.sql<{ push_seq: number }>`
      UPDATE da_a2a_tasks SET push_seq = push_seq + 1
      WHERE task_id = ${taskId} RETURNING push_seq`;
    return `${prefix}:${rows[0]?.push_seq ?? 0}`;
  }

  /**
   * The a2a-js `TaskStore` write. Upserts by id, preserving what `accept`
   * recorded, and answers whether the write applied.
   *
   * Refused, each for a race that is reachable:
   *  - anything over a terminal state but that same state. The request handler
   *    re-saves the task it loaded for a reply, and the answered turn can have
   *    settled it by then — a real answer is never rewritten, as `working` or
   *    as a failure;
   *  - `canceled` over a task that already finished;
   *  - `submitted` over a task that moved past it. The request handler re-saves
   *    the accepted task it published, and by then the turn may be running;
   *  - `working` over a task parked on a question. The handler loads a task an
   *    answer just resumed, and the answer's turn can park on the next question
   *    before the handler saves; only `resume` leaves a question.
   */
  save(task: Task): boolean {
    this.#ensure();
    const incoming = stateLabelOf(task);
    const existing = this.#stored(task.id);
    if (!existing) {
      const now = Date.now();
      this.sql`INSERT INTO da_a2a_tasks
        (task_id, context_id, state, task_json, created_at, updated_at)
        VALUES (${task.id}, ${task.contextId}, ${incoming}, ${serialize(task)},
                ${now}, ${now})`;
      return true;
    }
    const current = existing.state;
    if (TERMINAL.has(current) && incoming !== current) return false;
    if (incoming === "submitted" && current !== "submitted") return false;
    if (incoming === "working" && current === "input-required") return false;
    this.#write(task.id, incoming, task);
    return true;
  }

  /**
   * Move a task to `working`. `"canceled"` is the caller's signal to stop;
   * anything else — an unknown row, or one already past `submitted` — is
   * `"ok"`, because a recovered submission reports `running` again.
   */
  markWorking(taskId: string): "ok" | "canceled" {
    const row = this.#stored(taskId);
    if (!row) return "ok";
    if (row.state === "canceled") return "canceled";
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      message: task.status?.message,
      timestamp: new Date().toISOString()
    };
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = 'working', task_json = ${serialize(task)},
          updated_at = ${Date.now()}
      WHERE task_id = ${taskId} AND state = 'submitted'
      RETURNING task_id`;
    if (rows.length > 0) return "ok";
    return this.#stored(taskId)?.state === "canceled" ? "canceled" : "ok";
  }

  /**
   * Flip a task to `canceled` and return it, or `null` when this call did not
   * — an unknown task, or one already settled. A task parked on a question is
   * eligible: a cancel is how it stops waiting. `task` is the canceled task a
   * caller already built (the request handler's carries its own status
   * message). Owes the settle hooks, and no callback.
   */
  cancel(taskId: string, task?: Task): PlainTask | null {
    const row = this.#stored(taskId);
    if (!row || !OPEN.includes(row.state)) return null;
    const canceled = task ? (task as PlainTask) : parse(row.task_json);
    if (!task) {
      canceled.status = {
        state: TaskState.TASK_STATE_CANCELED,
        message: canceled.status?.message,
        timestamp: new Date().toISOString()
      };
    }
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = 'canceled', task_json = ${serialize(canceled)},
          request_json = NULL, delivery_key = NULL, answer_json = NULL,
          hooks_pending = 1, updated_at = ${Date.now()}
      WHERE task_id = ${taskId}
        AND state IN ('submitted', 'working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0 ? canceled : null;
  }

  /**
   * Park a running task on a question, and owe its callback in the same
   * statement. Only from `working`, or from `input-required` — the same park
   * re-run.
   */
  park(task: Task, request: HitlRequestData): boolean {
    this.#ensure();
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = 'input-required', task_json = ${serialize(task)},
          request_json = ${JSON.stringify(request)},
          delivery_key = ${questionKey(request.requestId)},
          updated_at = ${Date.now()}
      WHERE task_id = ${task.id} AND state IN ('working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0;
  }

  /**
   * Take a parked task back to `working` on `answer`, and return it — or
   * `null` when it is not parked, which is what a retried answer finds after
   * the first resumed it.
   *
   * Owes the answer's turn in the same statement, so a submit that fails or an
   * eviction before it leaves the turn to be sent rather than a task `working`
   * with no question left to answer. Drops the question's callback too: once
   * answered, a retry still queued would post it again.
   */
  resume(taskId: string, answer: FollowUp): PlainTask | null {
    const row = this.#stored(taskId);
    if (!row || row.state !== "input-required") return null;
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: new Date().toISOString()
    };
    const request = row.request_json
      ? (JSON.parse(row.request_json) as HitlRequestData)
      : null;
    const asked = request ? questionKey(request.requestId) : "";
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = 'working', task_json = ${serialize(task)},
          request_json = NULL, answer_json = ${JSON.stringify(answer)},
          delivery_key = CASE WHEN delivery_key = ${asked}
                         THEN NULL ELSE delivery_key END,
          updated_at = ${Date.now()}
      WHERE task_id = ${taskId} AND state = 'input-required'
      RETURNING task_id`;
    return rows.length > 0 ? task : null;
  }

  /** The answer's turn was submitted. */
  answered(taskId: string, id: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET answer_json = NULL
      WHERE task_id = ${taskId} AND json_extract(answer_json, '$.id') = ${id}`;
  }

  /**
   * The one terminal transition. Guarded on the source state, and owes the
   * callback and the settle hooks in the same statement — so a crash between
   * settling and either leaves a row the start-up sweep can act on.
   */
  settle(task: Task): boolean {
    this.#ensure();
    const state = stateLabelOf(task);
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          delivery_key = ${state}, hooks_pending = 1, request_json = NULL,
          answer_json = NULL, updated_at = ${Date.now()}
      WHERE task_id = ${task.id}
        AND state IN ('submitted', 'working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0;
  }

  /** Acknowledge one callback — only if it is still the one owed. */
  delivered(taskId: string, key: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET delivery_key = NULL
      WHERE task_id = ${taskId} AND delivery_key = ${key}`;
  }

  /** The settle hooks ran. */
  hooksRan(taskId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET hooks_pending = 0
      WHERE task_id = ${taskId}`;
  }

  #write(taskId: string, state: string, task: Task): void {
    this.sql`UPDATE da_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          context_id = ${task.contextId}, updated_at = ${Date.now()}
      WHERE task_id = ${taskId}`;
  }

  // --- work ----------------------------------------------------------------

  /**
   * Record work for a task. Written **before** what it records is started: a
   * crash between the two leaves an open row the gatekeeper's hour closes,
   * while the other order leaves a run nothing waits for and a task that
   * settles early.
   */
  addWork(input: {
    workId: string;
    taskId: string;
    kind: WorkKind;
    name: string;
    scheduleId?: string | null;
    runtime?: Record<string, unknown>;
  }): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_a2a_work
      (work_id, task_id, kind, name, schedule_id, runtime_json, open,
       created_at)
      VALUES (${input.workId}, ${input.taskId}, ${input.kind}, ${input.name},
              ${input.scheduleId ?? null},
              ${input.runtime ? JSON.stringify(input.runtime) : null}, 1,
              ${Date.now()})`;
  }

  setWorkSchedule(workId: string, scheduleId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_work SET schedule_id = ${scheduleId}
      WHERE work_id = ${workId}`;
  }

  /**
   * Close one work row, answering whether **this** call closed it. Detached
   * delivery is at-least-once, so the answer is what makes a follow-up turn
   * fire once per run rather than once per delivery.
   */
  closeWork(workId: string): boolean {
    this.#ensure();
    return (
      this.sql<{ work_id: string }>`
        UPDATE da_a2a_work SET open = 0
        WHERE work_id = ${workId} AND open = 1 RETURNING work_id`.length > 0
    );
  }

  /**
   * Claim a run's `settle`, answering whether **this** call claimed it. The
   * finish hook fires again for a soft interruption followed by the real
   * result, and again on a redelivery; a resource is released once.
   */
  claimSettle(workId: string): boolean {
    this.#ensure();
    return (
      this.sql<{ work_id: string }>`
        UPDATE da_a2a_work SET settled = 1
        WHERE work_id = ${workId} AND settled = 0 RETURNING work_id`.length > 0
    );
  }

  /**
   * Close a work row and owe its task the follow-up turn, in one statement,
   * answering whether **this** call closed it. Owed in the same write, so a
   * crash before the submit leaves the follow-up to be sent rather than a task
   * `working` with nothing left to answer it.
   *
   * The row still holds its task open until {@link endFollowUp}: two results
   * that land before the first follow-up turn has run must not let that turn
   * settle the task, or the second arrives to a closed one.
   */
  beginFollowUp(workId: string, followUp: FollowUp): boolean {
    this.#ensure();
    return (
      this.sql<{ work_id: string }>`
        UPDATE da_a2a_work SET open = 0, follow_up_json = ${JSON.stringify(followUp)}
        WHERE work_id = ${workId} AND open = 1 RETURNING work_id`.length > 0
    );
  }

  /** The follow-up a work row still owes, or `null`. */
  followUp(workId: string): FollowUp | null {
    this.#ensure();
    const json = this.sql<{ follow_up_json: string | null }>`
      SELECT follow_up_json FROM da_a2a_work WHERE work_id = ${workId}`[0]
      ?.follow_up_json;
    return json ? (JSON.parse(json) as FollowUp) : null;
  }

  /** The follow-up's turn has run, or its task closed without it. */
  endFollowUp(workId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_work SET follow_up_json = NULL
      WHERE work_id = ${workId}`;
  }

  /**
   * Work rows whose follow-up turn has not run. Submitting one again is safe:
   * the submission is idempotent on the follow-up's id.
   */
  pendingFollowUps(): string[] {
    this.#ensure();
    return this.sql<{ work_id: string }>`
      SELECT work_id FROM da_a2a_work WHERE follow_up_json IS NOT NULL`.map(
      (r) => r.work_id
    );
  }

  /**
   * How much work holds a task `working`: a run or wait still going, or one
   * whose follow-up turn has not run. The settlement check.
   */
  openWork(taskId: string): number {
    this.#ensure();
    return (
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM da_a2a_work
        WHERE task_id = ${taskId} AND kind IN ('detached', 'wait')
          AND (open = 1 OR follow_up_json IS NOT NULL)`[0]?.n ?? 0
    );
  }

  /** Every open row of a task, awaited runs included — what a cancel stops. */
  openWorkRows(taskId: string): WorkRow[] {
    this.#ensure();
    return this.sql<StoredWork>`
      SELECT * FROM da_a2a_work
      WHERE task_id = ${taskId} AND open = 1`.map(projectWork);
  }

  work(workId: string): WorkRow | null {
    this.#ensure();
    const row = this.sql<StoredWork>`
      SELECT * FROM da_a2a_work WHERE work_id = ${workId}`[0];
    return row ? projectWork(row) : null;
  }

  /** Every row of a task, closed ones included, oldest first. */
  workRows(taskId: string): WorkRow[] {
    this.#ensure();
    return this.sql<StoredWork>`
      SELECT * FROM da_a2a_work WHERE task_id = ${taskId}
      ORDER BY created_at ASC`.map(projectWork);
  }

  // --- retention -----------------------------------------------------------

  /** Delete settled tasks, and all work, older than `before` (epoch ms). */
  sweep(before: number): void {
    this.#ensure();
    this.sql`DELETE FROM da_a2a_tasks
      WHERE created_at < ${before}
        AND state NOT IN ('submitted', 'working', 'input-required')`;
    this.sql`DELETE FROM da_a2a_work
      WHERE created_at < ${before}
        AND task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
  }
}

// --- encoding ---------------------------------------------------------------

/**
 * Rows hold the task in its **A2A wire form**: under v1.0 enums are numbers in
 * memory and `SCREAMING_SNAKE` strings on the wire, and `Part.content` is a
 * `{ $case, value }` wrapper in memory and a bare key on the wire, so a plain
 * `JSON.stringify` would persist a shape that is neither valid A2A JSON nor
 * stable across SDK versions.
 */
function serialize(task: Task): string {
  return JSON.stringify(Task.toJSON(task));
}

function parse(json: string): PlainTask {
  return Task.fromJSON(JSON.parse(json)) as PlainTask;
}

/** The delivery key of a question's callback. */
export function questionKey(requestId: string): string {
  return `input-required:${requestId}`;
}

function stateLabelOf(task: Task): string {
  return taskStateLabel(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
}

function project(row: StoredTask): TaskRow {
  return {
    taskId: row.task_id,
    messageId: row.message_id,
    contextId: row.context_id,
    state: row.state,
    push: row.push_json ? (JSON.parse(row.push_json) as TurnPushContext) : null,
    identity: row.identity_json
      ? (JSON.parse(row.identity_json) as GatekeeperIdentity)
      : null,
    submissionId: row.submission_id,
    request: row.request_json
      ? (JSON.parse(row.request_json) as HitlRequestData)
      : null,
    deliveryKey: row.delivery_key,
    hooksPending: row.hooks_pending === 1,
    answer: row.answer_json ? (JSON.parse(row.answer_json) as FollowUp) : null
  };
}

function projectWork(row: StoredWork): WorkRow {
  return {
    workId: row.work_id,
    taskId: row.task_id,
    kind: row.kind as WorkKind,
    name: row.name,
    scheduleId: row.schedule_id,
    runtime: row.runtime_json
      ? (JSON.parse(row.runtime_json) as Record<string, unknown>)
      : undefined,
    open: row.open === 1,
    settled: row.settled === 1
  };
}

/** Apply the `ListTasks` response-shaping options to one stored task. */
function shape(task: PlainTask, query: TaskListFilter): PlainTask {
  const history = task.history ?? [];
  return {
    ...task,
    artifacts: query.includeArtifacts ? (task.artifacts ?? []) : [],
    history:
      query.historyLength === undefined
        ? history
        : history.slice(Math.max(0, history.length - query.historyLength))
  };
}
