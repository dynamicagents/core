import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import { isTerminalState, type Sql, type Transaction } from "../ledger.js";
import type {
  CompleteOutcome,
  JobEvent,
  StepJob,
  StepJobReport
} from "../workflow/types.js";

/**
 * A step agent's job ledger, on the object's own SQLite: the jobs task
 * workflows started here, the reports each owes its workflow, and the work
 * that keeps a job open across turns.
 *
 * These rules hold it together:
 *
 *  - **Every transition is a guarded write.** An `UPDATE … WHERE state IN (…)`
 *    decides, and the rows it wrote are the verdict. A caller that reads the
 *    state and then acts reopens the window in which a cancel lands and the
 *    workflow still hears `completed`.
 *  - **A transition and the report it owes are one write.** Both commit in one
 *    transaction, so a failure leaves either neither or both, and the start-up
 *    sweep sends what is unsent. Reports are numbered from 0: the workflow
 *    reads them in that order beside the host's inputs, under one event type,
 *    and pulls a number it has not seen.
 *  - **A job asks as often as it needs.** Each request is a row of its own,
 *    open until answered or expired, and none holds anything else back: a
 *    result, an answer and a joined message each get their turn in Think's
 *    order, whatever else is open.
 *  - **A job finishes when its workflow says so.** It reports `idle` once
 *    nothing runs for it; only the workflow knows whether an input is already
 *    on its way, so it asks for {@link StepJobs.complete}, which holds only
 *    while the job is still idle with nothing open.
 *  - **A closed job's reports wait for its work to stop,** and so does its
 *    task's settle hook. The workflow retries a failed step as soon as its
 *    report lands, and the retry would otherwise run beside a run or a wake
 *    the stop missed; the hook releases what that work runs in.
 *  - **Open work keeps a job alive across turns.** A detached sub-agent run or
 *    a scheduled wake is a work row, and settlement asks this table, not the
 *    model, whether the job is idle.
 *
 * `CREATE TABLE IF NOT EXISTS`, and storage outlives a deploy: a caller's
 * object keeps these rows across every version of this code. So the schema may
 * only grow in ways that statement already covers — a changed or added column
 * needs a versioned migration, as the Artifacts store keeps one
 * (`CURRENT_SCHEMA_VERSION` in `src/artifacts/store.ts`).
 */

/**
 * What a work row records. Every sub-agent run is one, so a run's progress can
 * be traced to its job; only `detached` and `wait` hold a job open.
 */
export type WorkKind = "awaited" | "detached" | "wait";

export interface WorkRow {
  workId: string;
  stepJobId: string;
  kind: WorkKind;
  /** The sub-agent class for a run, or what scheduled a wait. */
  name: string;
  /** The schedule a `wait` is parked on. */
  scheduleId: string | null;
  /** What the spec's `prepare` returned for a run, for its `settle`. */
  runtime: Record<string, unknown> | undefined;
  open: boolean;
  /** Whether the run's `settle` has been claimed. */
  settled: boolean;
}

/** A follow-up turn a job owes until it is submitted. */
export interface FollowUp {
  /** The user message's id, and the submission's idempotency key. */
  id: string;
  text: string;
}

/** One job's row. */
export interface JobRow {
  stepJobId: string;
  /** The A2A task the job runs for. */
  taskId: string;
  contextId: string;
  state: string;
  /** What the workflow started it with, or `null` for a job stopped unstarted. */
  job: StepJob | null;
  submissionId: string | null;
}

/** Where a request stands: waiting, or closed by its answer or its expiry. */
export type RequestState = "pending" | "answered" | "expired";

interface StoredJob {
  step_job_id: string;
  task_id: string;
  context_id: string;
  state: string;
  job_json: string | null;
  submission_id: string | null;
  request_json: string | null;
  answer_json: string | null;
}

interface StoredWork {
  work_id: string;
  step_job_id: string;
  kind: string;
  name: string;
  schedule_id: string | null;
  runtime_json: string | null;
  follow_up_json: string | null;
  open: number;
  settled: number;
}

export class StepJobs {
  #ensured = false;

  constructor(
    private readonly sql: Sql,
    private readonly transaction: Transaction
  ) {}

  /**
   * Run before the first statement rather than at construction: an agent builds
   * this in a field initializer, before its storage is usable.
   */
  #ensure(): void {
    if (this.#ensured) return;
    this.sql`CREATE TABLE IF NOT EXISTS da_step_jobs (
      step_job_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL DEFAULT '',
      context_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      job_json TEXT,
      submission_id TEXT,
      request_json TEXT,
      answer_json TEXT,
      push_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS da_step_jobs_task
      ON da_step_jobs (task_id, state)`;
    this.sql`CREATE TABLE IF NOT EXISTS da_step_job_reports (
      step_job_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (step_job_id, n)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_step_work (
      work_id TEXT PRIMARY KEY,
      step_job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      schedule_id TEXT,
      runtime_json TEXT,
      follow_up_json TEXT,
      open INTEGER NOT NULL DEFAULT 1,
      settled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS da_step_work_job
      ON da_step_work (step_job_id, open)`;
    this.sql`CREATE TABLE IF NOT EXISTS da_step_job_requests (
      request_id TEXT PRIMARY KEY,
      step_job_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS da_step_job_requests_job
      ON da_step_job_requests (step_job_id, state)`;
    this.sql`CREATE TABLE IF NOT EXISTS da_step_job_joins (
      step_job_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ran INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (step_job_id, message_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_step_task_hooks (
      task_id TEXT PRIMARY KEY,
      state INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.#ensured = true;
  }

  // --- jobs ----------------------------------------------------------------

  #stored(stepJobId: string): StoredJob | null {
    this.#ensure();
    return (
      this.sql<StoredJob>`
        SELECT * FROM da_step_jobs WHERE step_job_id = ${stepJobId}`[0] ?? null
    );
  }

  row(stepJobId: string): JobRow | null {
    const row = this.#stored(stepJobId);
    return row ? projectJob(row) : null;
  }

  /** The job as the workflow started it, or `null`. */
  job(stepJobId: string): StepJob | null {
    return this.row(stepJobId)?.job ?? null;
  }

  /** Whether a job is gone or settled — past starting anything for. */
  closed(stepJobId: string): boolean {
    const row = this.#stored(stepJobId);
    return !row || isTerminalState(row.state);
  }

  /** Record a job the workflow started. Idempotent on its id. */
  accept(job: StepJob): JobRow {
    this.#ensure();
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO da_step_jobs
      (step_job_id, task_id, context_id, state, job_json, created_at,
       updated_at)
      VALUES (${job.stepJobId}, ${job.taskId}, ${job.contextId}, 'submitted',
              ${JSON.stringify(job)}, ${now}, ${now})`;
    return projectJob(this.#stored(job.stepJobId)!);
  }

  /**
   * A canceled row for a job never started: a cancel that lands before the
   * start leaves this, and the start then finds it and starts nothing.
   */
  tombstone(stepJobId: string): void {
    this.#ensure();
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO da_step_jobs
      (step_job_id, state, created_at, updated_at)
      VALUES (${stepJobId}, 'canceled', ${now}, ${now})`;
  }

  bindSubmission(stepJobId: string, submissionId: string): void {
    this.#ensure();
    this.sql`UPDATE da_step_jobs SET submission_id = ${submissionId}
      WHERE step_job_id = ${stepJobId} AND submission_id IS NULL`;
  }

  /**
   * A turn of the job is running. `closed` is the caller's signal to stop it:
   * the job has ended, so nothing its turn does can count. A job that was idle
   * goes back to work and owes a `working` report in the same write, whose
   * number is `report`; a recovered submission reports `running` again, and
   * finds the job working already.
   */
  markWorking(stepJobId: string): { closed: boolean; report: number | null } {
    this.#ensure();
    return this.transaction(() => {
      const woke = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs SET state = 'working', updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId} AND state = 'idle'
        RETURNING step_job_id`;
      if (woke.length > 0) {
        return {
          closed: false,
          report: this.#addReport(stepJobId, { kind: "working" })
        };
      }
      this.sql`UPDATE da_step_jobs
        SET state = 'working', updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId} AND state = 'submitted'`;
      const row = this.#stored(stepJobId);
      return { closed: !row || isTerminalState(row.state), report: null };
    });
  }

  /**
   * Flip a job to `canceled`, answering whether this call did. It owes no
   * report — the host that stopped it has settled the task — so any report not
   * yet sent is dropped in the same write.
   */
  cancel(stepJobId: string): boolean {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs
        SET state = 'canceled', updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId}
          AND state IN ('submitted', 'working', 'idle')
        RETURNING step_job_id`;
      this.sql`UPDATE da_step_job_reports SET sent = 1
        WHERE step_job_id = ${stepJobId}`;
      return rows.length > 0;
    });
  }

  /**
   * Record a request a turn asked, and owe its `asked` report in the same
   * write, answering the report's number. A request already recorded owes
   * nothing twice: a turn's settlement runs again after an eviction.
   */
  ask(stepJobId: string, request: HitlRequestData): number | null {
    this.#ensure();
    return this.transaction(() => {
      if (this.closed(stepJobId)) return null;
      const rows = this.sql<{ request_id: string }>`
        INSERT OR IGNORE INTO da_step_job_requests
          (request_id, step_job_id, request_json, state, created_at)
        VALUES (${request.requestId}, ${stepJobId}, ${JSON.stringify(request)},
                'pending', ${Date.now()})
        RETURNING request_id`;
      if (rows.length === 0) return null;
      return this.#addReport(stepJobId, { kind: "asked", request });
    });
  }

  /**
   * Nothing runs for a working job any more: move it to `idle`, owing the
   * report that says so, with the requests still open and what it would end
   * on. Answers the report's number, or `null` for a job not working.
   */
  idle(stepJobId: string, reply: string): number | null {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs SET state = 'idle', updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId} AND state = 'working'
        RETURNING step_job_id`;
      if (rows.length === 0) return null;
      return this.#addReport(stepJobId, {
        kind: "idle",
        open: this.openRequests(stepJobId),
        reply
      });
    });
  }

  /**
   * Finish an idle job, on its workflow's word that no input is on its way.
   * Holds only while the job is still idle with no request and no work open:
   * anything that woke it since keeps it going, and the workflow reads the
   * report that says so. The reply is the one its last `idle` report carried.
   */
  complete(stepJobId: string): CompleteOutcome {
    this.#ensure();
    return this.transaction(() => {
      if (this.openRequests(stepJobId).length > 0) return { done: false };
      if (this.openWork(stepJobId) > 0) return { done: false };
      const rows = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs SET state = 'completed', updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId} AND state = 'idle'
        RETURNING step_job_id`;
      if (rows.length === 0) return { done: false };
      return { done: true, reply: this.lastReply(stepJobId) };
    });
  }

  /** What the job's last `idle` report said it would end on. */
  lastReply(stepJobId: string): string {
    for (const { report } of this.reports(stepJobId, 0).reverse()) {
      if (report.kind === "idle") return report.reply;
    }
    return "";
  }

  /**
   * Close a pending request on its answer or its expiry, and return it, or
   * `null` when it is not pending: a relay run again finds it closed.
   */
  closeRequest(
    stepJobId: string,
    requestId: string,
    state: Exclude<RequestState, "pending">
  ): HitlRequestData | null {
    this.#ensure();
    const row = this.sql<{ request_json: string }>`
      UPDATE da_step_job_requests SET state = ${state}
      WHERE request_id = ${requestId} AND step_job_id = ${stepJobId}
        AND state = 'pending'
      RETURNING request_json`[0];
    return row ? (JSON.parse(row.request_json) as HitlRequestData) : null;
  }

  /** A request this job asked, whatever its state, or `null`. */
  request(
    stepJobId: string,
    requestId: string
  ): { request: HitlRequestData; state: RequestState } | null {
    this.#ensure();
    const row = this.sql<{ request_json: string; state: string }>`
      SELECT request_json, state FROM da_step_job_requests
      WHERE request_id = ${requestId} AND step_job_id = ${stepJobId}`[0];
    return row
      ? {
          request: JSON.parse(row.request_json) as HitlRequestData,
          state: row.state as RequestState
        }
      : null;
  }

  /** A joined message the workflow handed the job, whether or not it runs. */
  handedJoin(stepJobId: string, messageId: string): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_step_job_joins (step_job_id, message_id)
      VALUES (${stepJobId}, ${messageId})`;
  }

  /** A joined message's turn ran: its message is in the session. */
  ranJoin(stepJobId: string, messageId: string): void {
    this.#ensure();
    this.sql`UPDATE da_step_job_joins SET ran = 1
      WHERE step_job_id = ${stepJobId} AND message_id = ${messageId}`;
  }

  /**
   * The joined messages handed to a job whose turns never ran: dropped on a
   * job already ended, or still queued behind the turn that ended it.
   */
  unrunJoins(stepJobId: string): string[] {
    this.#ensure();
    return this.sql<{ message_id: string }>`
      SELECT message_id FROM da_step_job_joins
      WHERE step_job_id = ${stepJobId} AND ran = 0`.map((r) => r.message_id);
  }

  /** The ids of the requests a job still waits on, oldest first. */
  openRequests(stepJobId: string): string[] {
    this.#ensure();
    return this.sql<{ request_id: string }>`
      SELECT request_id FROM da_step_job_requests
      WHERE step_job_id = ${stepJobId} AND state = 'pending'
      ORDER BY created_at ASC, request_id ASC`.map((r) => r.request_id);
  }

  /**
   * Fail a job, owing its `failed` report in the same write. Answers the
   * report's number, or `null` when the job had already ended.
   */
  fail(stepJobId: string, error: string): number | null {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs SET state = 'failed', updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId}
          AND state IN ('submitted', 'working', 'idle')
        RETURNING step_job_id`;
      if (rows.length === 0) return null;
      return this.#addReport(stepJobId, { kind: "failed", error });
    });
  }

  /**
   * The next progress key for a job.
   *
   * A durable counter rather than a clock or the content: the gatekeeper
   * dedupes on `${taskId}:${key}`, so a key must be distinct between two posts
   * and never reused by a later one.
   */
  nextPushKey(stepJobId: string, prefix: string): string {
    this.#ensure();
    const rows = this.sql<{ push_seq: number }>`
      UPDATE da_step_jobs SET push_seq = push_seq + 1
      WHERE step_job_id = ${stepJobId} RETURNING push_seq`;
    return `${prefix}:${rows[0]?.push_seq ?? 0}`;
  }

  /** Every job still open, each as the workflow started it. */
  openJobs(): StepJob[] {
    this.#ensure();
    return this.sql<StoredJob>`
      SELECT * FROM da_step_jobs
      WHERE state IN ('submitted', 'working', 'idle')
        AND job_json IS NOT NULL`
      .map(projectJob)
      .flatMap((row) => (row.job ? [row.job] : []));
  }

  /** The jobs of one A2A task still open. */
  openJobsOf(taskId: string): string[] {
    this.#ensure();
    return this.sql<{ step_job_id: string }>`
      SELECT step_job_id FROM da_step_jobs
      WHERE task_id = ${taskId}
        AND state IN ('submitted', 'working', 'idle')`.map(
      (r) => r.step_job_id
    );
  }

  // --- reports -------------------------------------------------------------

  #addReport(stepJobId: string, report: StepJobReport): number {
    const n =
      this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM da_step_job_reports
        WHERE step_job_id = ${stepJobId}`[0]?.n ?? 0;
    this.sql`INSERT INTO da_step_job_reports (step_job_id, n, report_json)
      VALUES (${stepJobId}, ${n}, ${JSON.stringify(report)})`;
    return n;
  }

  report(
    stepJobId: string,
    n: number
  ): { report: StepJobReport; sent: boolean } | null {
    this.#ensure();
    const row = this.sql<{ report_json: string; sent: number }>`
      SELECT report_json, sent FROM da_step_job_reports
      WHERE step_job_id = ${stepJobId} AND n = ${n}`[0];
    return row
      ? {
          report: JSON.parse(row.report_json) as StepJobReport,
          sent: row.sent === 1
        }
      : null;
  }

  sent(stepJobId: string, n: number): void {
    this.#ensure();
    this.sql`UPDATE da_step_job_reports SET sent = 1
      WHERE step_job_id = ${stepJobId} AND n = ${n}`;
  }

  /**
   * A job's reports from number `from` on, as the events they are sent as:
   * what the workflow pulls when one it waits for has not arrived.
   */
  reports(
    stepJobId: string,
    from: number
  ): Extract<JobEvent, { from: "agent" }>[] {
    this.#ensure();
    return this.sql<{ n: number; report_json: string }>`
      SELECT n, report_json FROM da_step_job_reports
      WHERE step_job_id = ${stepJobId} AND n >= ${from}
      ORDER BY n`.map((r) => ({
      from: "agent" as const,
      seq: r.n,
      report: JSON.parse(r.report_json) as StepJobReport
    }));
  }

  /** Every report of a job, sent or not. */
  numbers(stepJobId: string): number[] {
    this.#ensure();
    return this.sql<{ n: number }>`SELECT n FROM da_step_job_reports
      WHERE step_job_id = ${stepJobId} ORDER BY n`.map((r) => r.n);
  }

  /**
   * The reports a restarted instance waits for that may go now: every one,
   * save those still waiting on the job's stop ({@link unsent}).
   */
  resendable(stepJobId: string): number[] {
    this.#ensure();
    return this.sql<{ n: number }>`SELECT n FROM da_step_job_reports r
      WHERE step_job_id = ${stepJobId} AND (sent = 1 OR NOT EXISTS (
        SELECT 1 FROM da_step_work w
        JOIN da_step_jobs j ON j.step_job_id = w.step_job_id
        WHERE w.step_job_id = r.step_job_id AND w.open = 1
          AND j.state NOT IN ('submitted', 'working', 'idle')))
      ORDER BY n`.map((r) => r.n);
  }

  /** Reports not yet sent, save those waiting on a stop ({@link unstopped}). */
  unsent(): { stepJobId: string; n: number }[] {
    this.#ensure();
    return this.sql<{ step_job_id: string; n: number }>`
      SELECT step_job_id, n FROM da_step_job_reports
      WHERE sent = 0 AND step_job_id NOT IN (
        SELECT w.step_job_id FROM da_step_work w
        JOIN da_step_jobs j ON j.step_job_id = w.step_job_id
        WHERE w.open = 1
          AND j.state NOT IN ('submitted', 'working', 'idle'))
      ORDER BY step_job_id, n`.map((r) => ({
      stepJobId: r.step_job_id,
      n: r.n
    }));
  }

  /** One job's reports not yet sent. */
  unsentOf(stepJobId: string): number[] {
    this.#ensure();
    return this.sql<{ n: number }>`SELECT n FROM da_step_job_reports
      WHERE step_job_id = ${stepJobId} AND sent = 0 ORDER BY n`.map((r) => r.n);
  }

  /** Closed jobs with work still open: a stop that has not held yet. */
  unstopped(): string[] {
    this.#ensure();
    return this.sql<{ step_job_id: string }>`
      SELECT DISTINCT w.step_job_id FROM da_step_work w
      JOIN da_step_jobs j ON j.step_job_id = w.step_job_id
      WHERE w.open = 1
        AND j.state NOT IN ('submitted', 'working', 'idle')`.map(
      (r) => r.step_job_id
    );
  }

  // --- the end of a task -----------------------------------------------------

  /** A task ended: its settle hook is owed. Recorded once, whatever repeats. */
  oweTaskHook(taskId: string, state: number): void {
    this.#ensure();
    this
      .sql`INSERT OR IGNORE INTO da_step_task_hooks (task_id, state, created_at)
      VALUES (${taskId}, ${state}, ${Date.now()})`;
  }

  /** Owed settle hooks whose task has no job with work still open. */
  dueTaskHooks(): { taskId: string; state: number }[] {
    this.#ensure();
    return this.sql<{ task_id: string; state: number }>`
      SELECT task_id, state FROM da_step_task_hooks h
      WHERE NOT EXISTS (
        SELECT 1 FROM da_step_work w
        JOIN da_step_jobs j ON j.step_job_id = w.step_job_id
        WHERE j.task_id = h.task_id AND w.open = 1)`.map((r) => ({
      taskId: r.task_id,
      state: r.state
    }));
  }

  taskHookRan(taskId: string): void {
    this.#ensure();
    this.sql`DELETE FROM da_step_task_hooks WHERE task_id = ${taskId}`;
  }

  // --- work ----------------------------------------------------------------

  /**
   * Record work for a job. Written **before** what it records is started: a
   * crash between the two leaves an open row the task's own bounds close,
   * while the other order leaves a run nothing waits for and a job that
   * settles early.
   */
  addWork(input: {
    workId: string;
    stepJobId: string;
    kind: WorkKind;
    name: string;
    scheduleId?: string | null;
    runtime?: Record<string, unknown>;
  }): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_step_work
      (work_id, step_job_id, kind, name, schedule_id, runtime_json, open,
       created_at)
      VALUES (${input.workId}, ${input.stepJobId}, ${input.kind}, ${input.name},
              ${input.scheduleId ?? null},
              ${input.runtime ? JSON.stringify(input.runtime) : null}, 1,
              ${Date.now()})`;
  }

  /** Attach a wait's schedule, answering whether the wait was still open. */
  setWorkSchedule(workId: string, scheduleId: string): boolean {
    this.#ensure();
    return (
      this.sql<{ work_id: string }>`
        UPDATE da_step_work SET schedule_id = ${scheduleId}
        WHERE work_id = ${workId} AND open = 1 RETURNING work_id`.length > 0
    );
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
        UPDATE da_step_work SET open = 0
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
        UPDATE da_step_work SET settled = 1
        WHERE work_id = ${workId} AND settled = 0 RETURNING work_id`.length > 0
    );
  }

  /**
   * Close a work row and owe its job the follow-up turn, in one statement,
   * answering whether **this** call closed it. Owed in the same write, so a
   * crash before the submit leaves the follow-up to be sent rather than a job
   * `working` with nothing left to answer it.
   *
   * The row still holds its job open until {@link endFollowUp}: two results
   * that land before the first follow-up turn has run must not let that turn
   * settle the job, or the second arrives to a closed one.
   */
  beginFollowUp(workId: string, followUp: FollowUp): boolean {
    this.#ensure();
    return (
      this.sql<{ work_id: string }>`
        UPDATE da_step_work SET open = 0, follow_up_json = ${JSON.stringify(followUp)}
        WHERE work_id = ${workId} AND open = 1 RETURNING work_id`.length > 0
    );
  }

  /** The follow-up a work row still owes, or `null`. */
  followUp(workId: string): FollowUp | null {
    this.#ensure();
    const json = this.sql<{ follow_up_json: string | null }>`
      SELECT follow_up_json FROM da_step_work WHERE work_id = ${workId}`[0]
      ?.follow_up_json;
    return json ? (JSON.parse(json) as FollowUp) : null;
  }

  /** The follow-up's turn has run, or its job closed without it. */
  endFollowUp(workId: string): void {
    this.#ensure();
    this.sql`UPDATE da_step_work SET follow_up_json = NULL
      WHERE work_id = ${workId}`;
  }

  /**
   * Work rows whose follow-up turn has not run. Submitting one again is safe:
   * the submission is idempotent on the follow-up's id.
   */
  pendingFollowUps(): string[] {
    this.#ensure();
    return this.sql<{ work_id: string }>`
      SELECT work_id FROM da_step_work WHERE follow_up_json IS NOT NULL`.map(
      (r) => r.work_id
    );
  }

  /** One job's work rows whose follow-up turn has not run, oldest first. */
  owedFollowUps(stepJobId: string): string[] {
    this.#ensure();
    return this.sql<{ work_id: string }>`
      SELECT work_id FROM da_step_work
      WHERE step_job_id = ${stepJobId} AND follow_up_json IS NOT NULL
      ORDER BY created_at ASC`.map((r) => r.work_id);
  }

  /**
   * How much work holds a job `working`: a run or wait still going, or one
   * whose follow-up turn has not run. The settlement check.
   */
  openWork(stepJobId: string): number {
    this.#ensure();
    return (
      this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM da_step_work
        WHERE step_job_id = ${stepJobId} AND kind IN ('detached', 'wait')
          AND (open = 1 OR follow_up_json IS NOT NULL)`[0]?.n ?? 0
    );
  }

  /** Every open row of a job, awaited runs included — what a cancel stops. */
  openWorkRows(stepJobId: string): WorkRow[] {
    this.#ensure();
    return this.sql<StoredWork>`
      SELECT * FROM da_step_work
      WHERE step_job_id = ${stepJobId} AND open = 1`.map(projectWork);
  }

  work(workId: string): WorkRow | null {
    this.#ensure();
    const row = this.sql<StoredWork>`
      SELECT * FROM da_step_work WHERE work_id = ${workId}`[0];
    return row ? projectWork(row) : null;
  }

  /** Every row of a job, closed ones included, oldest first. */
  workRows(stepJobId: string): WorkRow[] {
    this.#ensure();
    return this.sql<StoredWork>`
      SELECT * FROM da_step_work WHERE step_job_id = ${stepJobId}
      ORDER BY created_at ASC`.map(projectWork);
  }

  // --- retention -----------------------------------------------------------

  /** Delete settled jobs older than `before` (epoch ms), and all they owned. */
  sweep(before: number): void {
    this.#ensure();
    this.sql`DELETE FROM da_step_jobs
      WHERE created_at < ${before}
        AND state NOT IN ('submitted', 'working', 'idle')`;
    this.sql`DELETE FROM da_step_job_reports
      WHERE step_job_id NOT IN (SELECT step_job_id FROM da_step_jobs)`;
    this.sql`DELETE FROM da_step_job_requests
      WHERE step_job_id NOT IN (SELECT step_job_id FROM da_step_jobs)`;
    this.sql`DELETE FROM da_step_job_joins
      WHERE step_job_id NOT IN (SELECT step_job_id FROM da_step_jobs)`;
    this.sql`DELETE FROM da_step_work
      WHERE created_at < ${before}
        AND step_job_id NOT IN (SELECT step_job_id FROM da_step_jobs)`;
    this.sql`DELETE FROM da_step_task_hooks WHERE created_at < ${before}`;
  }
}

function projectJob(row: StoredJob): JobRow {
  return {
    stepJobId: row.step_job_id,
    taskId: row.task_id,
    contextId: row.context_id,
    state: row.state,
    job: row.job_json ? (JSON.parse(row.job_json) as StepJob) : null,
    submissionId: row.submission_id
  };
}

function projectWork(row: StoredWork): WorkRow {
  return {
    workId: row.work_id,
    stepJobId: row.step_job_id,
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
