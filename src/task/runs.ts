import type { Sql } from "../ledger.js";
import type { NotedStepJob, TaskParams } from "../workflow/types.js";

/** The end-of-task notice, to one agent that ran a job for the task. */
export interface NoticeJob {
  taskId: string;
  binding: string;
  state: number;
}

/**
 * The host's own record of each task's workflow run: what it was started
 * with, so a start cut short can be run again; the step jobs its steps
 * started, so a cancel reaches them and the end of the task notifies them; the
 * notices not yet delivered, so one that ran out of retries is sent again at
 * the next start; and the questions already answered, so a replayed park never
 * asks one again.
 *
 * On the same SQLite as the task ledger (`./tasks.ts`), whose rows these
 * outlive only until the retention sweep.
 */
export class TaskRuns {
  #ensured = false;

  constructor(private readonly sql: Sql) {}

  #ensure(): void {
    if (this.#ensured) return;
    this.sql`CREATE TABLE IF NOT EXISTS da_task_runs (
      task_id TEXT PRIMARY KEY,
      params_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_task_step_jobs (
      task_id TEXT NOT NULL,
      step_job_id TEXT NOT NULL,
      binding TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, step_job_id)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_task_notices (
      task_id TEXT NOT NULL,
      binding TEXT NOT NULL,
      state INTEGER NOT NULL,
      PRIMARY KEY (task_id, binding)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_task_answered (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL
    )`;
    this.#ensured = true;
  }

  /** Recorded before the start, so a crash anywhere after it can resume. */
  record(params: TaskParams): void {
    this.#ensure();
    this
      .sql`INSERT OR IGNORE INTO da_task_runs (task_id, params_json, created_at)
      VALUES (${params.taskId}, ${JSON.stringify(params)}, ${Date.now()})`;
  }

  params(taskId: string): TaskParams | null {
    this.#ensure();
    const json = this.sql<{ params_json: string }>`
      SELECT params_json FROM da_task_runs WHERE task_id = ${taskId}`[0]
      ?.params_json;
    return json ? (JSON.parse(json) as TaskParams) : null;
  }

  note(taskId: string, job: NotedStepJob): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_task_step_jobs
      (task_id, step_job_id, binding, created_at)
      VALUES (${taskId}, ${job.stepJobId}, ${job.binding}, ${Date.now()})`;
  }

  jobs(taskId: string): NotedStepJob[] {
    this.#ensure();
    return this.sql<{ step_job_id: string; binding: string }>`
      SELECT step_job_id, binding FROM da_task_step_jobs
      WHERE task_id = ${taskId} ORDER BY created_at ASC`.map((r) => ({
      stepJobId: r.step_job_id,
      binding: r.binding
    }));
  }

  /** The agents that ran a job for the task, each once. */
  agents(taskId: string): string[] {
    return [...new Set(this.jobs(taskId).map((job) => job.binding))];
  }

  /** Owe each agent that ran a job for the task its notice; return them. */
  oweNotices(taskId: string, state: number): NoticeJob[] {
    for (const binding of this.agents(taskId)) {
      this.sql`INSERT OR IGNORE INTO da_task_notices (task_id, binding, state)
        VALUES (${taskId}, ${binding}, ${state})`;
    }
    return this.owedNotices().filter((notice) => notice.taskId === taskId);
  }

  /** Every notice not yet delivered. */
  owedNotices(): NoticeJob[] {
    this.#ensure();
    return this.sql<{ task_id: string; binding: string; state: number }>`
      SELECT task_id, binding, state FROM da_task_notices
      ORDER BY task_id, binding`.map((r) => ({
      taskId: r.task_id,
      binding: r.binding,
      state: r.state
    }));
  }

  /** A notice the agent took. */
  noticed(taskId: string, binding: string): void {
    this.#ensure();
    this.sql`DELETE FROM da_task_notices
      WHERE task_id = ${taskId} AND binding = ${binding}`;
  }

  /** A question the caller answered. Never asked again. */
  answered(taskId: string, requestId: string): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_task_answered (request_id, task_id)
      VALUES (${requestId}, ${taskId})`;
  }

  wasAnswered(requestId: string): boolean {
    this.#ensure();
    return (
      this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM da_task_answered
        WHERE request_id = ${requestId}`[0]?.n === 1
    );
  }

  /** Everything recorded for a task the ledger no longer holds. */
  sweep(): void {
    this.#ensure();
    this.sql`DELETE FROM da_task_runs
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_step_jobs
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_notices
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_answered
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
  }
}
