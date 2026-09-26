import { Task, TaskState } from "@a2a-js/sdk";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import { buildSubmittedTask } from "../a2a/notify.js";
import type { TurnPushContext } from "../a2a/push.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";
import type { AcceptedTurn } from "../a2a/executor.js";
import type { TaskListPage, TaskListQuery } from "../a2a/agent-stub.js";

/**
 * The A2A task ledger, on the agent's own `ctx.storage.sql`.
 *
 * Two rules hold the whole lifecycle together, and both are the reason this is a
 * table and not a field:
 *
 *  - **Every transition is a guarded write.** The `UPDATE … WHERE state IN (…)`
 *    is what decides, and the rows it wrote are the verdict. A caller that reads
 *    the state first and acts second reopens the window in which a cancel lands
 *    and the gatekeeper still gets a `completed` callback.
 *  - **Open work keeps a task alive across turns.** A detached sub-agent run or
 *    a scheduled wake is a row in `da_a2a_work`, and settlement asks this table
 *    — not the model — whether the task is finished.
 *
 * The DDL is idempotent and hand-written. There is no migrator: this package and
 * a consumer's own tables share one Durable Object, and a migrator's journal is
 * a flat sequence over one shared table that two independently-versioned
 * packages would collide in.
 */

/** The states a task never leaves. */
const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

/**
 * The states a `working` or terminal write may be applied over.
 *
 * `input-required` is in it: a task parked on a question is waiting, not
 * finished, and a cancel is how it stops waiting.
 */
const OPEN = ["submitted", "working", "input-required"];

export function isTerminalState(state: string): boolean {
  return TERMINAL.has(state);
}

/**
 * What one row of `da_a2a_work` records.
 *
 * `awaited` is recorded and does **not** hold the task open: an awaited
 * sub-agent finishes inside the turn that dispatched it, so the turn's own
 * completion is what settles the task. The other two outlive their turn.
 */
export type WorkKind = "awaited" | "detached" | "wait";

export interface WorkRow {
  workId: string;
  taskId: string;
  kind: WorkKind;
  name: string;
  /** The schedule a `wait` row is waiting on, for the cancel path. */
  scheduleId: string | null;
  open: boolean;
}

/** One task row, less the blob — everything a caller needs to act on it. */
export interface TaskRow {
  taskId: string;
  messageId: string | null;
  contextId: string;
  state: string;
  text: string;
  push: TurnPushContext | null;
  identity: GatekeeperIdentity | null;
  submissionId: string | null;
  /** The question the task is parked on, or `null` when it is not parked. */
  request: HitlRequestData | null;
  pendingDelivery: boolean;
}

/** The tagged-template `sql` every `Agent` exposes. */
export type LedgerSql = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

interface StoredRow {
  task_id: string;
  message_id: string | null;
  context_id: string;
  state: string;
  task_json: string;
  text: string;
  push_json: string | null;
  identity_json: string | null;
  submission_id: string | null;
  request_json: string | null;
  pending_delivery: number;
  push_seq: number;
}

interface StoredWorkRow {
  work_id: string;
  task_id: string;
  kind: string;
  name: string;
  schedule_id: string | null;
  open: number;
}

/** What {@link A2ATasks.accept} found or created. */
export interface AcceptedRow {
  row: TaskRow;
  /** The `submitted` task to answer the caller with. */
  task: PlainTask;
}

export class A2ATasks {
  private ensured = false;

  constructor(private readonly sql: LedgerSql) {}

  /**
   * Idempotent DDL, run before the first statement rather than at construction:
   * an agent builds this handle in a field initializer, where there is no
   * storage to write to yet.
   */
  private ensure(): void {
    if (this.ensured) return;
    this.sql`CREATE TABLE IF NOT EXISTS da_a2a_tasks (
      task_id TEXT PRIMARY KEY,
      message_id TEXT UNIQUE,
      context_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      task_json TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      push_json TEXT,
      identity_json TEXT,
      submission_id TEXT,
      request_json TEXT,
      pending_delivery INTEGER NOT NULL DEFAULT 0,
      push_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_a2a_work (
      work_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      schedule_id TEXT,
      open INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`;
    this.ensured = true;
  }

  // --- reads ---------------------------------------------------------------

  private stored(taskId: string): StoredRow | null {
    this.ensure();
    const rows = this.sql<StoredRow>`
      SELECT * FROM da_a2a_tasks WHERE task_id = ${taskId}`;
    return rows[0] ?? null;
  }

  row(taskId: string): TaskRow | null {
    const row = this.stored(taskId);
    return row ? project(row) : null;
  }

  get(taskId: string): PlainTask | null {
    const row = this.stored(taskId);
    return row ? parse(row.task_json) : null;
  }

  list(query: TaskListQuery): TaskListPage {
    this.ensure();
    const contextId = query.contextId ?? "";
    const state = query.state === undefined ? "" : taskStateLabel(query.state);
    const updatedAfter = query.updatedAfter ?? 0;
    // One statement with neutral sentinels rather than a built-up WHERE: the
    // tagged template takes values, not fragments.
    const rows = this.sql<StoredRow>`
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

  /** Tasks whose callback has not been acknowledged as delivered. */
  pendingDeliveries(): { taskId: string; state: string }[] {
    this.ensure();
    return this.sql<{ taskId: string; state: string }>`
      SELECT task_id AS taskId, state FROM da_a2a_tasks
      WHERE pending_delivery = 1`;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Record (or find) the `submitted` task for a turn, with everything the turn
   * will need later: where to call back, and who called.
   *
   * Idempotent on `messageId` — the gatekeeper retries dispatch, and the whole
   * accept-and-notify contract rests on that retry recording once. The caller
   * decides whether to start a submission from {@link AcceptedRow.row}, whose
   * `submissionId` is set only once one has been bound.
   */
  accept(turn: AcceptedTurn): AcceptedRow {
    this.ensure();
    const existing = this.sql<StoredRow>`
      SELECT * FROM da_a2a_tasks WHERE message_id = ${turn.messageId}`;
    if (existing[0]) {
      return { row: project(existing[0]), task: parse(existing[0].task_json) };
    }

    const task = buildSubmittedTask(turn.taskId, turn.contextId);
    const push: TurnPushContext = {
      taskId: turn.taskId,
      contextId: turn.contextId,
      pushUrl: turn.pushUrl,
      pushToken: turn.pushToken,
      jku: turn.jku
    };
    const now = Date.now();
    this.sql`INSERT INTO da_a2a_tasks
      (task_id, message_id, context_id, state, task_json, text,
       push_json, identity_json, created_at, updated_at)
      VALUES (${task.id}, ${turn.messageId}, ${task.contextId},
              ${taskStateLabel(task.status.state)}, ${serialize(task)},
              ${turn.text}, ${JSON.stringify(push)},
              ${JSON.stringify(turn.identity)}, ${now}, ${now})`;
    return { row: project(this.stored(task.id)!), task };
  }

  /**
   * Bind the durable submission running this task's first turn.
   *
   * Guarded on the column being unset, so a dispatch retry that raced past
   * `accept` cannot overwrite the submission the first one started.
   */
  bindSubmission(taskId: string, submissionId: string): void {
    this.ensure();
    this.sql`UPDATE da_a2a_tasks SET submission_id = ${submissionId}
      WHERE task_id = ${taskId} AND submission_id IS NULL`;
  }

  /**
   * The next notification key for this task.
   *
   * Derived from a durable counter rather than a clock or the content: the
   * gatekeeper dedupes on `${taskId}:${key}`, so the key has to be stable
   * across a redelivery and distinct between two progress posts.
   */
  nextPushKey(taskId: string, prefix: string): string {
    this.ensure();
    const rows = this.sql<{ push_seq: number }>`
      UPDATE da_a2a_tasks SET push_seq = push_seq + 1
      WHERE task_id = ${taskId} RETURNING push_seq`;
    return `${prefix}:${rows[0]?.push_seq ?? 0}`;
  }

  /**
   * Upsert a task by id, preserving `message_id`. Returns whether the write
   * applied.
   *
   * This is the a2a-js `TaskStore.save` path, so what it guards against is
   * whatever the SDK hands it, in whatever order:
   *
   *  - **Nothing overwrites `canceled`.** Once the row is canceled, no
   *    `completed` or `failed` callback can be built from it.
   *  - **`canceled` is only written over a task still running or parked.** The
   *    reverse of the above, and it closes the window where a cancel lands
   *    between a terminal write and its delivery: the delivery would post the
   *    completed task it had already built onto a row that now says canceled.
   *  - **One terminal state is never replaced by a different one.** The two
   *    rules above are both about cancellation, and between them leave
   *    `completed → failed` wide open — which is how a real answer gets
   *    overwritten by a generic failure when a callback is flaky. Re-writing the
   *    *same* terminal state stays allowed: a redelivery legitimately re-saves
   *    what it already saved.
   *  - **A `submitted` snapshot never lands on a task that has moved past it.**
   *    The request handler re-saves the accepted task it published while the
   *    turn is already running in the object.
   */
  save(task: Task): boolean {
    this.ensure();
    const incoming = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    const existing = this.stored(task.id);
    if (!existing) {
      const now = Date.now();
      this.sql`INSERT INTO da_a2a_tasks
        (task_id, context_id, state, task_json, created_at, updated_at)
        VALUES (${task.id}, ${task.contextId}, ${incoming}, ${serialize(task)},
                ${now}, ${now})`;
      return true;
    }
    const current = existing.state;
    if (current === "canceled" && incoming !== "canceled") return false;
    if (
      incoming === "canceled" &&
      !OPEN.includes(current) &&
      current !== "canceled"
    ) {
      return false;
    }
    if (
      isTerminalState(current) &&
      isTerminalState(incoming) &&
      incoming !== current
    ) {
      return false;
    }
    if (incoming === "submitted" && current !== "submitted") return false;
    this.write(task.id, incoming, task);
    return true;
  }

  /**
   * Move a task to `working`. `"canceled"` is the caller's signal to stop;
   * every other outcome — unknown row, or one already past `submitted` — is a
   * no-op reported as `"ok"`, because a recovered submission re-runs this.
   */
  markWorking(taskId: string): "ok" | "canceled" {
    const row = this.stored(taskId);
    if (!row) return "ok";
    if (row.state === "canceled") return "canceled";
    if (row.state !== "submitted") return "ok";
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      message: task.status?.message,
      timestamp: new Date().toISOString()
    };
    this.write(taskId, "working", task);
    return "ok";
  }

  /**
   * Flip the task to `canceled` and return it, or `null` when the row is not
   * eligible — unknown, or already finished.
   *
   * The source state is guarded, not only the destination: without it a cancel
   * landing after a terminal write but before its delivery would rewrite a
   * result the gatekeeper is about to be told about.
   */
  cancel(taskId: string): PlainTask | null {
    const row = this.stored(taskId);
    if (!row || !OPEN.includes(row.state)) return null;
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_CANCELED,
      message: task.status?.message,
      timestamp: new Date().toISOString()
    };
    this.write(taskId, "canceled", task);
    return task;
  }

  /**
   * Park a running task on a question, and mark the question for delivery.
   *
   * Only from `working`, or from `input-required` itself — the same park re-run.
   * A task that is canceled or finished has nobody left to take the answer, and
   * one still `submitted` has run no turn that could have asked.
   */
  park(task: Task, request: HitlRequestData): boolean {
    this.ensure();
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = 'input-required', task_json = ${serialize(task)},
          request_json = ${JSON.stringify(request)}, pending_delivery = 1,
          updated_at = ${Date.now()}
      WHERE task_id = ${task.id} AND state IN ('working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0;
  }

  /**
   * Take a parked task back to `working`, and return it — or `null` when it is
   * not parked, which is what a retried answer finds after the first resumed it.
   *
   * The question leaves with the state: the task handed back says only that the
   * agent is working again, and the question was already shown.
   */
  resume(taskId: string): PlainTask | null {
    const row = this.stored(taskId);
    if (!row || row.state !== "input-required") return null;
    const task = parse(row.task_json);
    task.status = {
      state: TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: new Date().toISOString()
    };
    this.ensure();
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = 'working', task_json = ${serialize(task)},
          request_json = NULL, updated_at = ${Date.now()}
      WHERE task_id = ${taskId} AND state = 'input-required'
      RETURNING task_id`;
    return rows.length > 0 ? task : null;
  }

  /**
   * The one terminal transition, guarded on the source state and marking the
   * callback for delivery in the same statement — so a crash between settling
   * and queueing leaves evidence the sweep at start can act on.
   */
  settle(task: Task): boolean {
    this.ensure();
    const state = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    const rows = this.sql<{ task_id: string }>`
      UPDATE da_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          pending_delivery = 1, request_json = NULL, updated_at = ${Date.now()}
      WHERE task_id = ${task.id}
        AND state IN ('submitted', 'working', 'input-required')
      RETURNING task_id`;
    return rows.length > 0;
  }

  clearPendingDelivery(taskId: string): void {
    this.ensure();
    this.sql`UPDATE da_a2a_tasks SET pending_delivery = 0
      WHERE task_id = ${taskId}`;
  }

  private write(taskId: string, state: string, task: Task): void {
    this.sql`UPDATE da_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          context_id = ${task.contextId}, updated_at = ${Date.now()}
      WHERE task_id = ${taskId}`;
  }

  // --- the work ledger -----------------------------------------------------

  addWork(
    workId: string,
    taskId: string,
    kind: WorkKind,
    name: string,
    scheduleId: string | null = null
  ): void {
    this.ensure();
    this.sql`INSERT OR IGNORE INTO da_a2a_work
      (work_id, task_id, kind, name, schedule_id, open, created_at)
      VALUES (${workId}, ${taskId}, ${kind}, ${name}, ${scheduleId}, 1,
              ${Date.now()})`;
  }

  /**
   * Close one open work row, answering whether *this* call closed it.
   *
   * Guarded because detached delivery is at-least-once under a crash: the
   * boolean is what makes the follow-up turn fire once per run rather than once
   * per delivery.
   */
  closeWork(workId: string): boolean {
    this.ensure();
    const rows = this.sql<{ work_id: string }>`
      UPDATE da_a2a_work SET open = 0
      WHERE work_id = ${workId} AND open = 1 RETURNING work_id`;
    return rows.length > 0;
  }

  /**
   * How much open work still holds this task `working`.
   *
   * `awaited` rows are excluded: an awaited run is finished by the time the turn
   * that dispatched it ends, so counting one would leave the task open for ever
   * if the turn ended before the finish hook cleared it.
   */
  openWork(taskId: string): number {
    this.ensure();
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM da_a2a_work
      WHERE task_id = ${taskId} AND open = 1 AND kind IN ('detached', 'wait')`;
    return rows[0]?.n ?? 0;
  }

  /** Every open row of a task, `awaited` included — the cancel path's view. */
  openWorkRows(taskId: string): WorkRow[] {
    this.ensure();
    return this.sql<StoredWorkRow>`
      SELECT work_id, task_id, kind, name, schedule_id, open FROM da_a2a_work
      WHERE task_id = ${taskId} AND open = 1
      ORDER BY created_at ASC`.map(projectWork);
  }

  /** Every work row of a task, closed ones included. */
  workRows(taskId: string): WorkRow[] {
    this.ensure();
    return this.sql<StoredWorkRow>`
      SELECT work_id, task_id, kind, name, schedule_id, open FROM da_a2a_work
      WHERE task_id = ${taskId} ORDER BY created_at ASC`.map(projectWork);
  }

  work(workId: string): WorkRow | null {
    this.ensure();
    const rows = this.sql<StoredWorkRow>`
      SELECT work_id, task_id, kind, name, schedule_id, open FROM da_a2a_work
      WHERE work_id = ${workId}`;
    return rows[0] ? projectWork(rows[0]) : null;
  }

  /**
   * The task a run or a wake belongs to.
   *
   * How a detached run finds its task at all: it reports with no active turn, so
   * there is no `activeTurnMetadata` to read it from.
   */
  taskOfWork(workId: string): string | null {
    return this.work(workId)?.taskId ?? null;
  }

  // --- retention -----------------------------------------------------------

  /** Delete tasks, and their work, last touched before `cutoff` (epoch ms). */
  sweep(cutoff: number): void {
    this.ensure();
    this.sql`DELETE FROM da_a2a_work WHERE task_id IN (
      SELECT task_id FROM da_a2a_tasks WHERE created_at < ${cutoff})`;
    this.sql`DELETE FROM da_a2a_tasks WHERE created_at < ${cutoff}`;
  }
}

// --- encoding ---------------------------------------------------------------

/**
 * Rows hold the task in its **A2A wire form**, not the in-memory protobuf
 * shape: under v1.0 enums are numbers in memory and `SCREAMING_SNAKE` strings
 * on the wire, and `Part.content` is a `{ $case, value }` wrapper in memory and
 * a bare named key on the wire. A plain `JSON.stringify` would persist a shape
 * that is neither valid A2A JSON nor stable across SDK versions — and what is
 * stored is then exactly what goes on the wire.
 */
function serialize(task: Task): string {
  return JSON.stringify(Task.toJSON(task));
}

function parse(json: string): PlainTask {
  return Task.fromJSON(JSON.parse(json)) as PlainTask;
}

function projectWork(row: StoredWorkRow): WorkRow {
  return {
    workId: row.work_id,
    taskId: row.task_id,
    kind: row.kind as WorkKind,
    name: row.name,
    scheduleId: row.schedule_id,
    open: row.open === 1
  };
}

function project(row: StoredRow): TaskRow {
  return {
    taskId: row.task_id,
    messageId: row.message_id,
    contextId: row.context_id,
    state: row.state,
    text: row.text,
    push: row.push_json ? (JSON.parse(row.push_json) as TurnPushContext) : null,
    identity: row.identity_json
      ? (JSON.parse(row.identity_json) as GatekeeperIdentity)
      : null,
    submissionId: row.submission_id,
    request: row.request_json
      ? (JSON.parse(row.request_json) as HitlRequestData)
      : null,
    pendingDelivery: row.pending_delivery === 1
  };
}

/** Apply the `ListTasks` response-shaping options to one stored task. */
function shape(task: PlainTask, query: TaskListQuery): PlainTask {
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
