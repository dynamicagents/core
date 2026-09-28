import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import { isTerminalState, type Sql, type Transaction } from "../ledger.js";
import type { StepJob, StepJobReport } from "../workflow/types.js";

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
 *    sweep sends what is unsent. Reports are numbered, because the workflow
 *    waits for report `n` under an event type of its own.
 *  - **A closed job's reports wait for its work to stop.** The workflow
 *    retries a failed step as soon as its report lands, and the retry would
 *    otherwise run beside a run or a wake the stop missed.
 *  - **Open work keeps a job alive across turns.** A detached sub-agent run or
 *    a scheduled wake is a work row, and settlement asks this table — not the
 *    model — whether the job is finished.
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

/** A turn a job owes — a follow-up, or an answer — until it is submitted. */
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
  /** The question the job is parked on, or `null` when it is not parked. */
  request: HitlRequestData | null;
  /** An answer the job resumed on, whose turn is not yet submitted. */
  answer: FollowUp | null;
}

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
   * Move a job to `working`. `"closed"` is the caller's signal to stop the
   * turn: the job has ended, so nothing its turn does can count. Anything else
   * is `"ok"`, because a recovered submission reports `running` again.
   */
  markWorking(stepJobId: string): "ok" | "closed" {
    this.#ensure();
    this.sql`UPDATE da_step_jobs
      SET state = 'working', updated_at = ${Date.now()}
      WHERE step_job_id = ${stepJobId} AND state = 'submitted'`;
    const row = this.#stored(stepJobId);
    return row && isTerminalState(row.state) ? "closed" : "ok";
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
        SET state = 'canceled', request_json = NULL, answer_json = NULL,
            updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId}
          AND state IN ('submitted', 'working', 'input-required')
        RETURNING step_job_id`;
      this.sql`UPDATE da_step_job_reports SET sent = 1
        WHERE step_job_id = ${stepJobId}`;
      return rows.length > 0;
    });
  }

  /**
   * Park a working job on its question, and owe the question's report in the
   * same write. Only from `working`: a job asks again only after an answer has
   * resumed it, so a park run twice finds it parked and owes nothing twice.
   */
  park(stepJobId: string, request: HitlRequestData): number | null {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs
        SET state = 'input-required', request_json = ${JSON.stringify(request)},
            updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId} AND state = 'working'
        RETURNING step_job_id`;
      if (rows.length === 0) return null;
      return this.#addReport(stepJobId, { state: "input-required", request });
    });
  }

  /**
   * Take a parked job back to `working` on `answer`, answering whether this
   * call did. Owes the answer's turn in the same statement, so a submit that
   * fails or an eviction before it leaves the turn to be sent rather than a job
   * `working` with no question left to answer.
   */
  resume(stepJobId: string, answer: FollowUp): boolean {
    this.#ensure();
    return (
      this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs
        SET state = 'working', request_json = NULL,
            answer_json = ${JSON.stringify(answer)}, updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId} AND state = 'input-required'
        RETURNING step_job_id`.length > 0
    );
  }

  /** The answer's turn was submitted. */
  answered(stepJobId: string, id: string): void {
    this.#ensure();
    this.sql`UPDATE da_step_jobs SET answer_json = NULL
      WHERE step_job_id = ${stepJobId}
        AND json_extract(answer_json, '$.id') = ${id}`;
  }

  /**
   * The one terminal transition, and the report it owes, in one write. Answers
   * the report's number, or `null` when the job had already ended.
   */
  settle(
    stepJobId: string,
    report: Extract<StepJobReport, { state: "completed" | "failed" }>
  ): number | null {
    this.#ensure();
    return this.transaction(() => {
      const rows = this.sql<{ step_job_id: string }>`
        UPDATE da_step_jobs
        SET state = ${report.state}, request_json = NULL, answer_json = NULL,
            updated_at = ${Date.now()}
        WHERE step_job_id = ${stepJobId}
          AND state IN ('submitted', 'working', 'input-required')
        RETURNING step_job_id`;
      if (rows.length === 0) return null;
      return this.#addReport(stepJobId, report);
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
      WHERE state IN ('submitted', 'working', 'input-required')
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
        AND state IN ('submitted', 'working', 'input-required')`.map(
      (r) => r.step_job_id
    );
  }

  /** Jobs owing an answer's turn. */
  pendingAnswers(): string[] {
    this.#ensure();
    return this.sql<{ step_job_id: string }>`
      SELECT step_job_id FROM da_step_jobs WHERE answer_json IS NOT NULL`.map(
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

  /** Every report of a job, sent or not: what a restarted instance waits for. */
  numbers(stepJobId: string): number[] {
    this.#ensure();
    return this.sql<{ n: number }>`SELECT n FROM da_step_job_reports
      WHERE step_job_id = ${stepJobId} ORDER BY n`.map((r) => r.n);
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
          AND j.state NOT IN ('submitted', 'working', 'input-required'))
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
        AND j.state NOT IN ('submitted', 'working', 'input-required')`.map(
      (r) => r.step_job_id
    );
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
        AND state NOT IN ('submitted', 'working', 'input-required')`;
    this.sql`DELETE FROM da_step_job_reports
      WHERE step_job_id NOT IN (SELECT step_job_id FROM da_step_jobs)`;
    this.sql`DELETE FROM da_step_work
      WHERE created_at < ${before}
        AND step_job_id NOT IN (SELECT step_job_id FROM da_step_jobs)`;
  }
}

function projectJob(row: StoredJob): JobRow {
  return {
    stepJobId: row.step_job_id,
    taskId: row.task_id,
    contextId: row.context_id,
    state: row.state,
    job: row.job_json ? (JSON.parse(row.job_json) as StepJob) : null,
    submissionId: row.submission_id,
    request: row.request_json
      ? (JSON.parse(row.request_json) as HitlRequestData)
      : null,
    answer: row.answer_json ? (JSON.parse(row.answer_json) as FollowUp) : null
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
