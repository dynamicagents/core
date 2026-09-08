/**
 * `@dynamicagents/core/subtasks` — the delegation layer: what a round may hand out,
 * and how a proposal becomes durable drafts.
 */

export {
  makeSubtaskTypes,
  SubtaskParamsError,
  type SubtaskTypeRegistry
} from "./subtask-types.js";

export {
  DecompositionValidationError,
  makeDecompositionProposalSchema,
  nonBlank,
  resolveDecomposition
} from "./decomposition.js";

export {
  DELEGATE_TOOL_NAME,
  makeDelegateTool,
  delegateToolCallId,
  delegateCallInput,
  delegateCallOutput,
  type DelegateSubtaskOutcome
} from "./delegate.js";

export { isCatalogEligible, type ReferenceCatalogEntry } from "./catalog.js";

export { labelSubagentNote } from "./progress.js";

export * from "./types.js";
