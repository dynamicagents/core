/**
 * `@dynamicagents/core/round` — the delegating round loop.
 *
 * A round agent answers the user or hands work to isolated subagents, waits for
 * their durable results, and decides again. This subpath ships the whole
 * mechanism of that: the round loop and its primary→fallback→repair ladder
 * ({@link runTurn}), the durable Workflow orchestration that runs a round's
 * subtasks concurrently ({@link runHandleTask}), the Durable Object body ({@link
 * RoundAgentBase}), and the subagent facet host ({@link RecipeSubagentHost}).
 *
 * **Opt-in, and its own subpath on purpose.** An agent whose turn is a single
 * inference — one that never delegates — imports none of this and carries none of
 * it in its bundle. Core's root barrel does not re-export it.
 *
 * **Core still ships no prompt copy.** Everything the model and the user read
 * comes from the {@link RoundPolicy} an agent supplies: the round contract, the
 * forced-answer notes, and the three user-facing strings. That is the line — core
 * owns the machine, you own the words.
 */

// `FinalRoundReason` rides with the policy: it is the second argument of
// `finalRoundNote`, and a host writing that note should not have to guess the
// union its own words are selected by.
export type { ApprovalCall, FinalRoundReason, RoundPolicy } from "./policy.js";

export {
  RoundAgentBase,
  type HumanWaitResult,
  type ParkResult
} from "./agent.js";

export { RecipeSubagentHost, type SubagentClass } from "./subagent.js";

export {
  runHandleTask,
  type HandleTaskDeps,
  type HandleTaskParams,
  type TaskFailureKind,
  type TaskVerdict
} from "./workflow.js";

// Re-exported here, not only from `/agent`: `RoundFailureKind` is most of
// `TaskFailureKind`, the argument type of `HandleTaskDeps.failureCopy`, and a
// host implementing that hook should not have to reach into a second subpath to
// name it — nor to name the credential subset, which is what a host keyed only
// on those will write.
export type {
  NonRecoverableKind,
  RoundFailureKind
} from "../agent/inference.js";

// The shape `RunTurnArgs.observations` is built from — exported because a host
// calling `runTurn` directly has to be able to name it. The two functions are
// core's own: a host supplies rounds, not the mechanics of bounding them.
export type { RoundObservations } from "./observations.js";

export {
  buildTurnInstructions,
  joinSuccessfulBranches,
  renderTurnMessages,
  runTurn,
  type ApprovalReplay,
  type ParkedOn,
  type RoundMode,
  type RunTurnArgs,
  type RunTurnOutcome,
  type TurnInstructions
} from "./turn.js";
