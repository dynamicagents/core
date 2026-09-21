import { z } from "zod";
import type { ReferenceCatalogEntry } from "./catalog.js";
import {
  SubtaskParamsError,
  type SubtaskTypeRegistry
} from "./subtask-types.js";
import type {
  DecompositionProposal,
  SubtaskDraft,
  SubtaskReference
} from "./types.js";

/**
 * Pure validation and resolution of a `delegate` call's input. No model, no
 * Session, no database — given a {@link DecompositionProposal} and the ephemeral
 * reference catalog it was generated against, this either produces the drafts to
 * persist or throws.
 *
 * One invariant lives here: **the model selects references by index only.** It
 * emits catalog indices; this module copies the catalog entry's exact role+text
 * onto the draft. Model output never becomes reference text, so a Subtask cannot
 * carry a rewritten, summarized, or fabricated "quote" of the conversation.
 *
 * A proposal's subtasks are **independent of one another**: they all run at once
 * and none can read another's output, so there is no graph to validate and
 * nothing to order. Sequencing is expressed across rounds instead — the main
 * agent delegates, reads the results, and delegates the next step.
 *
 * Invalid output is never repaired: a throw fails the attempt, which falls back to
 * the other model, and two failed attempts fail the parent Task. Silently
 * synthesizing a general Subtask would deliver plausible work the user never asked
 * for.
 */

/** A model proposal that cannot be resolved into a valid decomposition. */
export class DecompositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompositionValidationError";
  }
}

/**
 * A required string that is not whitespace.
 *
 * Written as a `.regex()` rather than the equivalent `.refine()`, deliberately.
 * Both are enforced wherever this schema is actually run, but a refinement is
 * **invisible to the model**: custom checks do not survive JSON-Schema conversion,
 * so the rule would be one the model is held to without ever being shown it.
 * `/\S/` converts to `"pattern": "\\S"` next to `"minLength": 1`, so the
 * constraint reaches the model as part of the tool schema, on every field. A
 * field's `.describe()` says what the field is for, and need not restate it.
 *
 * Being shown a rule is not the same as being held to it. This schema reaches
 * the model through a **control** tool, which has no `execute`, so the SDK never
 * validates its input — what enforces the constraint is
 * {@link file://../agent/control.ts control.ts}, which parses every control call
 * with the tool's own schema before the round uses it.
 */
export const nonBlank = (label: string) =>
  z
    .string()
    .min(1)
    .regex(/\S/, { message: `${label} must not be blank` });

function makeSubtaskProposalSchema(types: SubtaskTypeRegistry) {
  return z.object({
    // A closed enum, not prose: an invented type is rejected by the tool schema
    // itself rather than silently resolving to some default recipe.
    type: z
      .enum(types.enumKeys())
      .describe(
        "Exactly one of the type names listed in this tool's description. Any other value fails the call."
      ),
    prompt: nonBlank("prompt").describe(
      "The complete instruction for this subtask. Its subagent sees nothing but this and the turns named in referenceIndexes."
    ),
    referenceIndexes: z
      .array(z.number().int().min(1))
      .optional()
      .describe(
        "The N of each conversation turn marked [ref N] that this subtask must read verbatim. Only marked turns can be referenced."
      ),
    /**
     * The type's required inputs — ids the model quotes from a tool result.
     * Every key any type declares is named here, gathered from those types by
     * `SubtaskTypeRegistry.paramProperties`; which of them a given type actually
     * *requires* is the per-type contract, checked below.
     *
     * Named keys rather than a free-form record, deliberately: a record's value
     * schema is the JSON Schema `additionalProperties` slot, which the AI SDK's
     * strict-mode pass overwrites with `false` — turning "any string key" into
     * "no key at all" and leaving the model no legal way to send params it was
     * told to send. Explicit properties survive that pass, and say more besides.
     */
    params: z.object(types.paramProperties()).optional()
  });
}

/**
 * The `delegate` tool's input schema. The per-round bound is enforced here
 * (the model is told it, and the SDK rejects a call that breaks it) and again in
 * the data layer, which owns the durable invariant.
 *
 * Blank strings are rejected at the schema edge rather than deep in execution: an
 * empty `prompt` would otherwise burn a Subtask slot and only fail later, inside
 * the child, with no useful diagnostic.
 *
 * `referenceIndexes` is optional because this one schema also has to describe the
 * calls **reconstructed from durable rows** in later rounds, whose references
 * were resolved to verbatim snapshots at the time and no longer have indices.
 */
export function makeDecompositionProposalSchema(
  types: SubtaskTypeRegistry,
  maxSubtasks: number
) {
  return z.object({
    // Said outright, because a model confuses it with a subtask's `prompt` and
    // sends a top-level `prompt` instead: a missing `reply` is the commonest
    // rejection this tool gets.
    reply: nonBlank("reply").describe(
      "Required. The message the user sees now, while the work runs: what you are doing about their request. Not an instruction — the work itself goes in each subtask's prompt."
    ),
    subtasks: z
      .array(makeSubtaskProposalSchema(types))
      .min(1)
      .max(maxSubtasks)
      .describe(
        "The units of work. All of them start at once, and none can see another's output."
      )
  });
}

/**
 * Snapshot the selected catalog entries onto a draft: validate every index against
 * the catalog, reject duplicates, and copy each entry's exact role+text. Indexes
 * are stored ascending so a Subtask's references read in conversation order
 * regardless of the order the model listed them.
 *
 * `label` names the offending subtask by its 1-based position in the proposal —
 * the only handle a subtask has, and the one the model can map back to what it
 * just wrote.
 */
function resolveReferences(
  label: string,
  referenceIndexes: number[] | undefined,
  catalog: ReferenceCatalogEntry[]
): SubtaskReference[] {
  if (!referenceIndexes) return [];
  const seen = new Set<number>();
  for (const index of referenceIndexes) {
    if (seen.has(index)) {
      throw new DecompositionValidationError(
        `${label} references index ${index} more than once`
      );
    }
    seen.add(index);
    if (index > catalog.length) {
      throw new DecompositionValidationError(
        `${label} references unknown catalog index ${index} ` +
          `(catalog has ${catalog.length} ${catalog.length === 1 ? "entry" : "entries"})`
      );
    }
  }
  return [...referenceIndexes]
    .sort((a, b) => a - b)
    .map((index) => {
      // The catalog is 1-based; copy role+text verbatim (never the model's words).
      const entry = catalog[index - 1];
      return { role: entry.role, text: entry.text };
    });
}

/**
 * Resolve a validated model proposal into the drafts to persist.
 *
 * Throws {@link DecompositionValidationError} on any structural problem: blank
 * fields, unknown or duplicate reference indices, and params a type refuses. On
 * success, array order is preserved — the data layer derives each Subtask's
 * `ordinal` from it.
 */
export function resolveDecomposition(
  proposal: DecompositionProposal,
  catalog: ReferenceCatalogEntry[],
  types: SubtaskTypeRegistry
): { reply: string; drafts: SubtaskDraft[] } {
  const drafts: SubtaskDraft[] = proposal.subtasks.map((s, index) => {
    const label = `subtask ${index + 1}`;
    const type = s.type.trim();
    let params;
    try {
      // Shape only. Whether an id names a row that exists — and is still usable —
      // is a question for durable state, answered when the execution starts.
      params = types.validateParams(type, s.params);
    } catch (err) {
      if (!(err instanceof SubtaskParamsError)) throw err;
      throw new DecompositionValidationError(`${label}: ${err.message}`);
    }
    return {
      type,
      prompt: s.prompt.trim(),
      references: resolveReferences(label, s.referenceIndexes, catalog),
      params
    };
  });

  return { reply: proposal.reply.trim(), drafts };
}
