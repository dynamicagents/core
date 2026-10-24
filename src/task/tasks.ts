import { Task, TaskState } from "@a2a-js/sdk";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import { buildSubmittedTask } from "../a2a/notify.js";
import type { TurnPushContext } from "../a2a/push.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";
import { isTerminalState, type Sql, type Transaction } from "../ledger.js";

/**
 * The A2A task ledger, on the task host's own SQLite.
 *
 * **Every transition is a guarded write.** An `UPDATE … WHERE state IN (…)`
 * decides, and the rows it wrote are the verdict. A caller that reads the state
 * and then acts reopens the window in which a cancel lands and the gatekeeper
 * still gets a `completed`.
 *
 * Every side effect a transition owes — the callback, the settle hooks, the
 * answer's relay, stopping the run — is recorded **in the same statement** as
 * the transition, and cleared once it has happened. A host evicted in between
 * finds the record at its next start and finishes the job; see
 * `TaskHost.onStart`.
 *
 * `CREATE TABLE IF NOT EXISTS`, and storage outlives a deploy: a caller's host
 * keeps these rows across every version of this code. So the schema may only
 * grow in ways that statement already covers — a changed or added column needs
 * a versioned migration, as the Artifacts store keeps one
 * (`CURRENT_SCHEMA_VERSION` in `src/artifacts/store.ts`).
 */

/** The states a task can still move out of. */
const OPEN = ["submitted", "working", "input-required"];

/** The two states an open task moves between once it runs. */
const RUNNING = ["working", "input-required"];

/** A request one of the task's jobs asked, and where it stands. */
export interface RequestRow {
  requestId: string;
  taskId: string;
  /** The job that asked: what its answer is relayed to. */
  stepJobId: string;
  request: HitlRequestData;
  state: "pending" | "answered" | "expired";
}

/**
 * The callback slot for a task's state: one, and the latest wins, because a
 * `working` and an `input-required` delivered out of order would leave the
 * gatekeeper's clock reading the wrong one.
 */
export const STATE_KEY = "state";

/** One task row, less the blob. */
export interface TaskRow {
  taskId: string;
  messageId: string | null;
  contextId: string;
  state: string;
  push: TurnPushContext | null;
  identity: GatekeeperIdentity | null;
  /** Whether the task's workflow has been started and adopted. */
  bound: boolean;
  /**
   * The settled state's callback, still owed, or `null`. The callbacks an open
   * task owes (its questions, its state) are rows of their own: see
   * {@link A2ATasks.owe}.
   */
  deliveryKey: string | null;
  /** Whether the settle hooks are still owed. */
  hooksPending: boolean;
  /** Whether stopping the run — the instance and its jobs — is still owed. */
  stopPending: boolean;
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

interface StoredTask {
  task_id: string;
  message_id: string | null;
  context_id: string;
  state: string;
  task_json: string;
  push_json: string | null;
  identity_json: string | null;
  bound: number;
  delivery_key: string | null;
  hooks_pending: number;
  stop_pending: number;
}

export class A2ATasks {
  #ensured = false;

  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction
  ) {}

  /**
   * Run before the first statement rather than at construction: a host builds
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
      bound INTEGER NOT NULL DEFAULT 0,
      request_json TEXT,
      delivery_key TEXT,
      hooks_pending INTEGER NOT NULL DEFAULT 0,
      stop_pending INTEGER NOT NULL DEFAULT 0,
      answer_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // `request_json` and `answer_json` above are no longer written: a column
    // goes only with a migration, and these hold nothing but `NULL`.
    this.sql`CREATE TABLE IF NOT EXISTS da_a2a_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_job_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS da_a2a_requests_task
      ON da_a2a_requests (task_id, state)`;
    this.sql`CREATE TABLE IF NOT EXISTS da_a2a_deliveries (
      task_id TEXT NOT NULL,
      key TEXT NOT NULL,
      task_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, key)
    )`;
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

  /** Callbacks owed and not yet acknowledged: settled ones, and open ones. */
  pendingDeliveries(): { taskId: string; key: string }[] {
    this.#ensure();
    const settled = this.sql<{ task_id: string; delivery_key: string }>`
      SELECT task_id, delivery_key FROM da_a2a_tasks
      WHERE delivery_key IS NOT NULL`.map((r) => ({
      taskId: r.task_id,
      key: r.delivery_key
    }));
    const open = this.sql<{ task_id: string; key: string }>`
      SELECT task_id, key FROM da_a2a_deliveries ORDER BY created_at`.map(
      (r) => ({ taskId: r.task_id, key: r.key })
    );
    return [...settled, ...open];
  }

  /**
   * What an owed callback posts, or `null` once it is not owed: delivered,
   * superseded by a later state, or dropped when the task settled. A settled
   * task's own callback is the row's state.
   */
  owed(taskId: string, key: string): PlainTask | null {
    this.#ensure();
    const row = this.#stored(taskId);
    if (!row) return null;
    if (row.delivery_key === key) return parse(row.task_json);
    const json = this.sql<{ task_json: string }>`
      SELECT task_json FROM da_a2a_deliveries
      WHERE task_id = ${taskId} AND key = ${key}`[0]?.task_json;
    return json ? parse(json) : null;
  }

  /** Tasks whose settle hooks are owed. */
  pendingHooks(): string[] {
    this.#ensure();
    return this.sql<{ task_id: string }>`
      SELECT task_id FROM da_a2a_tasks WHERE hooks_pending = 1`.map(
      (r) => r.task_id
    );
  }

  /** Tasks whose run is still owed a stop. */
  pendingStops(): string[] {
    this.#ensure();
    return this.sql<{ task_id: string }>`
      SELECT task_id FROM da_a2a_tasks WHERE stop_pending = 1`.map(
      (r) => r.task_id
    );
  }

  /** Tasks accepted and never bound: a start an eviction cut short. */
  unbound(): string[] {
    this.#ensure();
    return this.sql<{ task_id: string }>`
      SELECT task_id FROM da_a2a_tasks
      WHERE state = 'submitted' AND bound = 0`.map((r) => r.task_id);
  }

  /** Open tasks whose workflow is running: what reconciliation reads. */
  openBound(): string[] {
    this.#ensure();
    return this.sql<{ task_id: string }>`
      SELECT task_id FROM da_a2a_tasks
      WHERE bound = 1
        AND state IN ('submitted', 'working', 'input-required')`.map(
      (r) => r.task_id
    );
  }

  // --- writes --------------------------------------------------------------

  /**
   * Record (or reuse) the `submitted` task for a turn, with everything the
   * task will need to call back. Idempotent on `messageId`: the gatekeeper
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

  /** The task's workflow is started and adopted. */
  bind(taskId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET bound = 1 WHERE task_id = ${taskId}`;
  }

  /**
   * The a2a-js `TaskStore` write. Upserts by id, preserving what `accept`
   * recorded, and answers whether the write applied.
   *
   * Refused, each for a race that is reachable:
   *  - anything over a terminal state but that same state. The request handler
   *    re-saves the task it loaded for a reply, and the answered task can have
   *    settled by then — a real answer is never rewritten, as `working` or as a
   *    failure;
   *  - `canceled` over a task that already finished;
   *  - `submitted` over a task that moved past it. The request handler re-saves
   *    the accepted task it published, and by then the run may be going;
   *  - `working` and `input-required` over each other. The handler re-saves a
   *    task it loaded for a reply, and its workflow can move it either way
   *    before the handler saves; only {@link A2ATasks.setState} moves it.
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
    if (isTerminalState(current) && incoming !== current) return false;
    if (incoming === "submitted" && current !== "submitted") return false;
    if (
      RUNNING.includes(incoming) &&
      RUNNING.includes(current) &&
      incoming !== current
    ) {
      return false;
    }
    this.#write(task.id, incoming, task);
    return true;
  }

  /**
   * Move a task to `working`. `"canceled"` is the caller's signal to stop;
   * anything else — an unknown row, or one already past `submitted` — is
   * `"ok"`, because a start run again finds the task working already.
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
   * message). Owes the stop and the settle hooks, and no callback.
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
    const canceledHere = this.transaction(() => {
      const rows = this.sql<{ task_id: string }>`
        UPDATE da_a2a_tasks
        SET state = 'canceled', task_json = ${serialize(canceled)},
            delivery_key = NULL, hooks_pending = 1, stop_pending = 1,
            updated_at = ${Date.now()}
        WHERE task_id = ${taskId}
          AND state IN ('submitted', 'working', 'input-required')
        RETURNING task_id`;
      if (rows.length > 0) this.#dropOwed(taskId);
      return rows.length > 0;
    });
    return canceledHere ? canceled : null;
  }

  /**
   * Record a request a job asked, and owe its callback in the same write: the
   * task as it is, carrying the request. Any number may be open. One already
   * recorded owes nothing twice, so a park step run again posts nothing more.
   */
  ask(
    taskId: string,
    stepJobId: string,
    request: HitlRequestData,
    asking: Task
  ): "parked" | "closed" {
    this.#ensure();
    return this.transaction(() => {
      const row = this.#stored(taskId);
      if (!row || !OPEN.includes(row.state)) return "closed";
      const rows = this.sql<{ request_id: string }>`
        INSERT OR IGNORE INTO da_a2a_requests
          (request_id, task_id, step_job_id, request_json, state, created_at)
        VALUES (${request.requestId}, ${taskId}, ${stepJobId},
                ${JSON.stringify(request)}, 'pending', ${Date.now()})
        RETURNING request_id`;
      if (rows.length > 0)
        this.owe(taskId, questionKey(request.requestId), asking);
      return "parked";
    });
  }

  /** A request of this task, whatever its state, or `null`. */
  request(taskId: string, requestId: string): RequestRow | null {
    this.#ensure();
    const row = this.sql<StoredRequest>`
      SELECT * FROM da_a2a_requests
      WHERE request_id = ${requestId} AND task_id = ${taskId}`[0];
    return row ? projectRequest(row) : null;
  }

  /** The requests the task still waits on, oldest first. */
  openRequests(taskId: string): RequestRow[] {
    this.#ensure();
    return this.sql<StoredRequest>`
      SELECT * FROM da_a2a_requests
      WHERE task_id = ${taskId} AND state = 'pending'
      ORDER BY created_at ASC, request_id ASC`.map(projectRequest);
  }

  /**
   * Close a pending request on its answer or its expiry, answering whether
   * this call closed it, and drop its callback if it has not gone yet: a retry
   * still queued would post an answered question again.
   */
  closeRequest(
    taskId: string,
    requestId: string,
    state: "answered" | "expired"
  ): boolean {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ request_id: string }>`
        UPDATE da_a2a_requests SET state = ${state}
        WHERE request_id = ${requestId} AND task_id = ${taskId}
          AND state = 'pending'
        RETURNING request_id`;
      if (rows.length === 0) return false;
      this.sql`DELETE FROM da_a2a_deliveries
        WHERE task_id = ${taskId} AND key = ${questionKey(requestId)}`;
      return true;
    });
  }

  /**
   * Move a running task to `working` or `input-required`, owing the state's
   * callback in the same write. Answers whether the state changed: a step run
   * again finds it there already, and owes nothing twice.
   */
  setState(
    taskId: string,
    state: "working" | "input-required",
    task: Task
  ): boolean {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ task_id: string }>`
        UPDATE da_a2a_tasks
        SET state = ${state}, task_json = ${serialize(task)},
            updated_at = ${Date.now()}
        WHERE task_id = ${taskId}
          AND state IN ('working', 'input-required') AND state <> ${state}
        RETURNING task_id`;
      if (rows.length === 0) return false;
      this.owe(taskId, STATE_KEY, task);
      return true;
    });
  }

  /**
   * Owe one callback of an open task, keyed on what it reports. A repeat under
   * the same key replaces what it would post: the latest state is the one owed.
   */
  owe(taskId: string, key: string, task: Task): void {
    this.#ensure();
    this.sql`INSERT INTO da_a2a_deliveries (task_id, key, task_json, created_at)
      VALUES (${taskId}, ${key}, ${serialize(task)}, ${Date.now()})
      ON CONFLICT (task_id, key) DO UPDATE SET task_json = excluded.task_json`;
  }

  /** Every callback an open task still owes: a settled task owes none of them. */
  #dropOwed(taskId: string): void {
    this.sql`DELETE FROM da_a2a_deliveries WHERE task_id = ${taskId}`;
  }

  /**
   * The one terminal transition. Guarded on the source state, and owes the
   * callback and the settle hooks in the same statement — so a crash between
   * settling and either leaves a row the start-up sweep can act on. `stop`
   * owes stopping the run too, for a task the host settles while its workflow
   * is still going.
   */
  settle(task: Task, options: { stop?: boolean } = {}): boolean {
    this.#ensure();
    const state = stateLabelOf(task);
    const stop = options.stop ? 1 : 0;
    return this.transaction(() => {
      const rows = this.sql<{ task_id: string }>`
        UPDATE da_a2a_tasks
        SET state = ${state}, task_json = ${serialize(task)},
            delivery_key = ${state}, hooks_pending = 1, stop_pending = ${stop},
            updated_at = ${Date.now()}
        WHERE task_id = ${task.id}
          AND state IN ('submitted', 'working', 'input-required')
        RETURNING task_id`;
      if (rows.length > 0) this.#dropOwed(task.id);
      return rows.length > 0;
    });
  }

  /**
   * Acknowledge the callback that was posted, `sent`. `false`, and nothing
   * acknowledged, when another replaced it under the same key while it
   * posted: that one is still owed.
   */
  delivered(taskId: string, key: string, sent: PlainTask): boolean {
    this.#ensure();
    return this.transaction(() => {
      const now = this.owed(taskId, key);
      if (now && JSON.stringify(now) !== JSON.stringify(sent)) return false;
      this.sql`UPDATE da_a2a_tasks SET delivery_key = NULL
        WHERE task_id = ${taskId} AND delivery_key = ${key}`;
      this.sql`DELETE FROM da_a2a_deliveries
        WHERE task_id = ${taskId} AND key = ${key}`;
      return true;
    });
  }

  /** The settle hooks ran. */
  hooksRan(taskId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET hooks_pending = 0
      WHERE task_id = ${taskId}`;
  }

  /** The run is stopped. */
  stopped(taskId: string): void {
    this.#ensure();
    this.sql`UPDATE da_a2a_tasks SET stop_pending = 0
      WHERE task_id = ${taskId}`;
  }

  #write(taskId: string, state: string, task: Task): void {
    this.sql`UPDATE da_a2a_tasks
      SET state = ${state}, task_json = ${serialize(task)},
          context_id = ${task.contextId}, updated_at = ${Date.now()}
      WHERE task_id = ${taskId}`;
  }

  // --- retention -----------------------------------------------------------

  /** Delete settled tasks older than `before` (epoch ms). */
  sweep(before: number): void {
    this.#ensure();
    this.sql`DELETE FROM da_a2a_tasks
      WHERE created_at < ${before}
        AND state NOT IN ('submitted', 'working', 'input-required')`;
    this.sql`DELETE FROM da_a2a_requests
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_a2a_deliveries
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
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
    bound: row.bound === 1,
    deliveryKey: row.delivery_key,
    hooksPending: row.hooks_pending === 1,
    stopPending: row.stop_pending === 1
  };
}

interface StoredRequest {
  request_id: string;
  task_id: string;
  step_job_id: string;
  request_json: string;
  state: string;
}

function projectRequest(row: StoredRequest): RequestRow {
  return {
    requestId: row.request_id,
    taskId: row.task_id,
    stepJobId: row.step_job_id,
    request: JSON.parse(row.request_json) as HitlRequestData,
    state: row.state as RequestRow["state"]
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
