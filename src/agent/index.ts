/**
 * `@dynamicagents/core/agent` — the agent behind core's zero-trust edge.
 *
 * {@link A2AAgent} is the per-caller agent a starter subclasses: a Think agent
 * with the A2A task around its turns. Everything a turn does is Think's; what
 * is here is the part Think does not have — the task, its guarded ledger,
 * delivery, and a task that outlives its turn. The ledger and the turn reader
 * are internal: a subclass answers hooks, it does not write task state.
 */

export { A2AAgent, type A2ACopy, type CheckBackWake } from "./agent.js";

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

export { ensureStarted } from "./lifecycle.js";
