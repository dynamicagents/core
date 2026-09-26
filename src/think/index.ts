/**
 * `@dynamicagents/core/think` — the A2A task lifecycle on `@cloudflare/think`.
 *
 * {@link A2AAgent} is the per-caller agent behind core's zero-trust edge, and
 * {@link SubAgent} the child it dispatches. Everything a turn does is Think's;
 * what is here is the part Think does not have — the A2A task, its guarded
 * ledger, delivery, and a task that outlives its turn.
 */

export { A2AAgent, type A2ACopy, type CheckBackWake } from "./agent.js";

export {
  NOTE_MILESTONE,
  SubAgent,
  type NoteData,
  type SubAgentClass,
  type SubAgentEnvelope,
  type SubAgentPrepareContext,
  type SubAgentSettleContext,
  type SubAgentSpec
} from "./sub-agent.js";

export {
  A2ATasks,
  TASK_RETENTION_MS,
  isTerminalState,
  type TaskListFilter,
  type TaskRow,
  type WorkKind,
  type WorkRow
} from "./tasks.js";

export {
  latestTaskId,
  readTurn,
  taskIdOf,
  type TurnOutcome
} from "./outcome.js";

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
