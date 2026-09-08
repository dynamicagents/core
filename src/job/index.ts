/**
 * `@dynamicagents/core/job` — a long job a Durable Object owns through its alarm.
 *
 * **The sibling of `@dynamicagents/core/alarm`, and the pairing is the point.**
 * A `Scheduler` owns *when* an object wakes; this owns *what a job owes on
 * waking*. Neither depends on the other's reason for existing, and both are
 * useful to a plain `DurableObject` rather than only to a `DynamicAgent` — which
 * is why they are subpaths and not part of the agent machinery.
 *
 * **Mechanism only.** Nothing here knows what a job *does*: no command, no
 * container, no filesystem, no vendor library. A consumer supplies the handle
 * and the meaning; this supplies the four rules that are wrong in the same way
 * every time — arming before the work starts, one job at a time, a drain that
 * can outlive its job, and a job nobody is draining. See {@link JobLifecycle}.
 *
 * Deliberately **not** called `task`. Core already has a `Task` — the A2A one,
 * with its own lifecycle, its own guarded writes and its own table — and two
 * unrelated meanings in one namespace is a cost paid forever by every reader.
 */

export {
  isRearmable,
  isRunning,
  type DoneJob,
  type FailedJob,
  type IdleJob,
  type JobState,
  type RunningJob,
  type SkippedJob
} from "./state.js";

export {
  JobLifecycle,
  type JobContext,
  type JobHandle,
  type JobLifecycleOptions,
  type JobResult
} from "./lifecycle.js";
