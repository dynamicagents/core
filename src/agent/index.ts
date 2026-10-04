/**
 * `@dynamicagents/core/agent` — the step agent.
 *
 * {@link StepAgent} is the per-caller agent a starter subclasses: a Think agent
 * that runs the jobs a task workflow (`/workflow`) starts, and reports each to
 * it. Everything a turn does is Think's; what is here is the part Think does
 * not have — the job, its guarded ledger, its reports, and a job that outlives
 * its turn. It speaks no A2A: the task is its host's (`/task`). The ledger and
 * the turn reader are internal: a subclass answers hooks, it does not write job
 * state.
 */

export { StepAgent, type CheckBackWake } from "./agent.js";

export {
  ASK_USER_TOOL_NAME,
  CHECK_BACK_TOOL_NAME,
  MAX_ASK_OPTIONS,
  MAX_CHECK_BACK_SECONDS,
  MIN_CHECK_BACK_SECONDS,
  SEARCH_HISTORY_TOOL_NAME,
  askUserInputSchema,
  askUserTool,
  checkBackInputSchema
} from "./tools.js";
