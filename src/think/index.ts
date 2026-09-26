/**
 * `@dynamicagents/core/think` — the A2A task lifecycle on `@cloudflare/think`.
 *
 * Think owns the conversation: durable turns and their recovery, non-destructive
 * compaction, sub-agents awaited or detached, tools, actions, context blocks.
 * This subpath is the half Think has no opinion about — an A2A task, its guarded
 * transitions, and the callback that ends it — expressed as two base classes an
 * agent subclasses and a tool factory that wires a sub-agent to a work row.
 *
 * What is **not** here, and must not arrive: a number, and a sentence the model
 * reads. Both are the agent's. See {@link A2AAgent}'s abstract members.
 */

export { A2AAgent, type A2ACopy } from "./agent.js";

export {
  SubAgent,
  subAgentTool,
  type SubAgentClass,
  type SubAgentHost,
  type SubAgentSpec
} from "./sub-agent.js";

export {
  A2ATasks,
  isTerminalState,
  type AcceptedRow,
  type LedgerSql,
  type TaskRow,
  type WorkKind,
  type WorkRow
} from "./tasks.js";

export { readTurn, taskIdOf, type PendingAsk, type TurnOutcome } from "./outcome.js";

export { askUserTool, searchHistoryTool } from "./tools.js";

export { ensureStarted } from "./lifecycle.js";
