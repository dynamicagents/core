/**
 * What the task host's ledger (`src/task/tasks.ts`) and a step agent's job
 * ledger (`src/agent/step-jobs.ts`) share: both keep A2A's task states, on the
 * object's own SQLite.
 */

/** The tagged-template `sql` every `Agent` exposes. */
export type Sql = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** The states a task or a job never leaves. */
const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

export function isTerminalState(state: string): boolean {
  return TERMINAL.has(state);
}

/** Rows older than this are swept by the retention task. */
export const TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
