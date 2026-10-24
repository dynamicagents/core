import type { Sql } from "../ledger.js";
import type {
  JobEvent,
  NotedStepJob,
  StepInput,
  TaskParams
} from "../workflow/types.js";

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
 * the next start; which job takes the messages that join the task; the
 * inputs relayed to each job, numbered, so the workflow can put them in order
 * and pull one that is late; and which of the task's branches wait on the
 * person, which is what its A2A state is read from.
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
    this.sql`CREATE TABLE IF NOT EXISTS da_task_joins (
      task_id TEXT PRIMARY KEY,
      step_job_id TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_task_inputs (
      task_id TEXT NOT NULL,
      step_job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      input_json TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (step_job_id, seq)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS da_task_branches (
      task_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      waiting INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (task_id, branch_id)
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

  /**
   * Record a job a step started. One that takes joined messages becomes the
   * task's join target, in place of any before it: a retry's job carries on
   * the conversation its failed attempt was having.
   */
  note(taskId: string, job: NotedStepJob): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_task_step_jobs
      (task_id, step_job_id, binding, created_at)
      VALUES (${taskId}, ${job.stepJobId}, ${job.binding}, ${Date.now()})`;
    this.openBranch(taskId, job.stepJobId);
    if (job.joins) {
      this.sql`INSERT INTO da_task_joins (task_id, step_job_id, closed)
        VALUES (${taskId}, ${job.stepJobId}, 0)
        ON CONFLICT (task_id) DO UPDATE
        SET step_job_id = excluded.step_job_id, closed = 0`;
    }
  }

  /** The job a joined message goes to, or `null` when none takes them now. */
  joinTarget(taskId: string): string | null {
    this.#ensure();
    return (
      this.sql<{ step_job_id: string }>`
        SELECT step_job_id FROM da_task_joins
        WHERE task_id = ${taskId} AND closed = 0`[0]?.step_job_id ?? null
    );
  }

  /** Stop, or start again, taking joined messages for a job. */
  setJoins(taskId: string, stepJobId: string, open: boolean): void {
    this.#ensure();
    this.sql`UPDATE da_task_joins SET closed = ${open ? 0 : 1}
      WHERE task_id = ${taskId} AND step_job_id = ${stepJobId}`;
  }

  /** Whether this task already took the input `messageId` names. */
  hasInput(taskId: string, messageId: string): boolean {
    this.#ensure();
    return (
      (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM da_task_inputs
        WHERE task_id = ${taskId} AND message_id = ${messageId}`[0]?.n ?? 0) > 0
    );
  }

  /**
   * Give a failed job's joined messages to the job retrying it: those it
   * never ran (from number `from` on, which its workflow never handed it, and
   * those named in `unrun`), renumbered after the retry's own, and every
   * message that joins after. Answers stay: they answer questions only the
   * failed job asked. Returns the numbers the retry now owes.
   */
  handOverJoins(
    taskId: string,
    stepJobId: string,
    to: string,
    unread: { from: number; unrun: string[] }
  ): number[] {
    this.#ensure();
    if (this.joinTarget(taskId) !== stepJobId) return [];
    const unrun = new Set(unread.unrun);
    const owed = this.inputs(taskId, stepJobId, 0).filter(
      (event) =>
        event.input.kind === "join" &&
        (event.seq >= unread.from || unrun.has(event.input.messageId))
    );
    let next = this.#nextSeq(to);
    const moved: number[] = [];
    for (const event of owed) {
      this.sql`UPDATE da_task_inputs
        SET step_job_id = ${to}, seq = ${next}, sent = 0
        WHERE step_job_id = ${stepJobId} AND seq = ${event.seq}`;
      moved.push(next++);
    }
    this.sql`UPDATE da_task_joins SET step_job_id = ${to}, closed = 0
      WHERE task_id = ${taskId}`;
    return moved;
  }

  /**
   * Record one input for a job, numbered after its last, and answer its
   * number, or `null` for a `messageId` already recorded: the gatekeeper sends
   * an answer again, and the input it already gave counts once.
   */
  addInput(
    taskId: string,
    stepJobId: string,
    messageId: string,
    input: StepInput
  ): number | null {
    this.#ensure();
    const seen = this.sql<{ seq: number }>`
      SELECT seq FROM da_task_inputs WHERE message_id = ${messageId}`[0];
    if (seen) return null;
    const seq = this.#nextSeq(stepJobId);
    this.sql`INSERT INTO da_task_inputs
      (task_id, step_job_id, seq, message_id, input_json, created_at)
      VALUES (${taskId}, ${stepJobId}, ${seq}, ${messageId},
              ${JSON.stringify(input)}, ${Date.now()})`;
    return seq;
  }

  /**
   * A job's next input number: past its highest, not its count, since a
   * hand-over takes inputs out of the middle of a failed job's numbers.
   */
  #nextSeq(stepJobId: string): number {
    const top = this.sql<{ top: number | null }>`
      SELECT MAX(seq) AS top FROM da_task_inputs
      WHERE step_job_id = ${stepJobId}`[0]?.top;
    return top === null || top === undefined ? 0 : top + 1;
  }

  /** One input, as the event it is sent as, or `null`. */
  input(
    stepJobId: string,
    seq: number
  ): Extract<JobEvent, { from: "host" }> | null {
    this.#ensure();
    const json = this.sql<{ input_json: string }>`
      SELECT input_json FROM da_task_inputs
      WHERE step_job_id = ${stepJobId} AND seq = ${seq}`[0]?.input_json;
    return json
      ? { from: "host", seq, input: JSON.parse(json) as StepInput }
      : null;
  }

  /** A job of this task's inputs from number `from` on: what its workflow pulls. */
  inputs(
    taskId: string,
    stepJobId: string,
    from: number
  ): Extract<JobEvent, { from: "host" }>[] {
    this.#ensure();
    return this.sql<{ seq: number; input_json: string }>`
      SELECT seq, input_json FROM da_task_inputs
      WHERE task_id = ${taskId} AND step_job_id = ${stepJobId}
        AND seq >= ${from}
      ORDER BY seq`.map((r) => ({
      from: "host" as const,
      seq: r.seq,
      input: JSON.parse(r.input_json) as StepInput
    }));
  }

  inputSent(stepJobId: string, seq: number): void {
    this.#ensure();
    this.sql`UPDATE da_task_inputs SET sent = 1
      WHERE step_job_id = ${stepJobId} AND seq = ${seq}`;
  }

  /** Inputs not yet sent, oldest first: what the start-up sweep relays. */
  unsentInputs(): { taskId: string; stepJobId: string; seq: number }[] {
    this.#ensure();
    return this.sql<{ task_id: string; step_job_id: string; seq: number }>`
      SELECT task_id, step_job_id, seq FROM da_task_inputs
      WHERE sent = 0 ORDER BY created_at, seq`.map((r) => ({
      taskId: r.task_id,
      stepJobId: r.step_job_id,
      seq: r.seq
    }));
  }

  /** A branch of the task is running: a job, or a pipeline's own question. */
  openBranch(taskId: string, branchId: string): void {
    this.#ensure();
    this.sql`INSERT OR IGNORE INTO da_task_branches (task_id, branch_id)
      VALUES (${taskId}, ${branchId})`;
  }

  /** A branch waits on the person, or works again. Opens one not yet open. */
  setWaiting(taskId: string, branchId: string, waiting: boolean): void {
    this.#ensure();
    this.sql`INSERT INTO da_task_branches (task_id, branch_id, waiting)
      VALUES (${taskId}, ${branchId}, ${waiting ? 1 : 0})
      ON CONFLICT (task_id, branch_id) DO UPDATE SET waiting = excluded.waiting`;
  }

  endBranch(taskId: string, branchId: string): void {
    this.#ensure();
    this.sql`DELETE FROM da_task_branches
      WHERE task_id = ${taskId} AND branch_id = ${branchId}`;
  }

  /** Whether the task has a branch open and every one waits on the person. */
  waiting(taskId: string): boolean {
    this.#ensure();
    const row = this.sql<{ open: number; waiting: number | null }>`
      SELECT COUNT(*) AS open, SUM(waiting) AS waiting FROM da_task_branches
      WHERE task_id = ${taskId}`[0];
    return !!row && row.open > 0 && row.waiting === row.open;
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

  /** Everything recorded for a task the ledger no longer holds. */
  sweep(): void {
    this.#ensure();
    this.sql`DELETE FROM da_task_runs
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_step_jobs
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_notices
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_joins
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_inputs
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
    this.sql`DELETE FROM da_task_branches
      WHERE task_id NOT IN (SELECT task_id FROM da_a2a_tasks)`;
  }
}
