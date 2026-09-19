import { tool, type Tool } from "ai";
import { makeDecompositionProposalSchema } from "./decomposition.js";
import type { SubtaskTypeRegistry } from "./subtask-types.js";
import type {
  CompositionBranch,
  DecompositionProposal,
  SubtaskId,
  SubtaskStatus
} from "./types.js";

/**
 * The `delegate` tool — the single act by which the main agent hands work to
 * subagents, and the shape both ends of that act agree on.
 *
 * Delegation is a **durable tool call**: a round emits it for real (the model
 * picks it and fills its input), the Workflow performs it over minutes or hours,
 * and a later round reassembles the call with its result to keep working. The two
 * halves are separated by a Workflow boundary, not by a fiction — nothing here is
 * fabricated on the model's behalf.
 *
 * This module owns the tool's identity because every round depends on it
 * agreeing: a later round pairs a synthesized `tool-result` to an earlier round's
 * `tool-call` by name and id, and a mismatch would not throw — it would silently
 * produce a malformed history that the model quietly misreads.
 */

export const DELEGATE_TOOL_NAME = "delegate";

/**
 * The tool as the model sees it. Deliberately **without `execute`**: the Workflow
 * performs this call, durably, outside the inference — so there is nothing for the
 * SDK to run, and the tool loop halts on the call rather than trying to continue
 * past it. That is what makes it a *control* tool: unlike the agent's work tools
 * (`set_context`, and whatever the installed plugins offer), calling it ends the
 * round.
 *
 * Its `inputSchema` is the delegation contract itself, and it is the **only**
 * declaration of this tool. One schema has to serve both directions — the calls
 * the model emits now, and the calls reconstructed from durable rows in later
 * rounds — because a provider cannot be shown two shapes for one tool name in a
 * single request. See {@link delegateCallInput} for how a durable row is rendered
 * back into it.
 *
 * Built per registry rather than declared as a module constant: both the type
 * enum in its schema and the catalogue in its description are facts about which
 * plugins are installed, and in the predecessor repo both were frozen at import
 * time — which is exactly what made the type set unoverridable.
 */
export function makeDelegateTool(
  types: SubtaskTypeRegistry,
  maxSubtasks: number
): Tool {
  return tool({
    description:
      "Delegate part of the user's request to isolated subagents and acknowledge it. Their results return to you, and you then decide what to do next — answer the user, or delegate again.\n\n" +
      "Every subtask must name one of these types, and supply the params that type requires:\n" +
      types.renderTypes(),
    inputSchema: makeDecompositionProposalSchema(types, maxSubtasks)
  });
}

/**
 * The call's id, derived from the parent Task and the round that emitted it —
 * deterministic and replay-safe, the same discipline as the Session message ids
 * it sits alongside (see {@link file://../agent/history.ts}). Later rounds rebuild it
 * rather than storing it.
 *
 * **Underscores, not colons, and this is load-bearing.** Unlike a Session message
 * id, this one is sent to a provider as a `tool_use.id`, and Anthropic validates
 * that field against `^[a-zA-Z0-9_-]+$`. The colon-separated form this used to
 * return failed every round from the first delegation onwards — round 0 was fine
 * because the model authors its own ids, and round 1 reconstructs this one, so
 * the request 400d deterministically on both the primary and the fallback until
 * the deterministic join fired. Workers AI never validated the field, which is
 * why it took a Claude-backed agent to surface it.
 *
 * Nothing persists this: both halves of the pair are rebuilt together on every
 * request, so changing the shape needs no migration. There is no longer a
 * provider-side backstop in core — the adapter that carried one went with
 * `./anthropic` in 0.8.0 — so a provider added here that validates tool-call ids
 * needs to sanitize them on its own way out.
 */
export function delegateToolCallId(taskId: string, round: number): string {
  return `task_${taskId}_round_${round}_delegate`;
}

/**
 * One branch's outcome, as the tool result carries it. `output` carries the
 * branch's report when it completed and its failure reason when it did not.
 *
 * **A failed branch says why, and that is a reversal worth explaining.** This
 * used to be `null` for anything that did not complete, on the principle that
 * internal diagnostics never reach the model. The principle was right about
 * *diagnostics* and wrong about this field: what a facet writes into `error` is
 * not a stack trace, it is a sentence addressed to the delegating model —
 * "there is no checkout in this workspace yet… clone the repository before
 * delegating", "every credential has reached its limit; send this request again
 * after that". Withholding those left the parent with `status: "failed"` and
 * nothing else, and a parent that cannot tell a transient failure from a
 * permanent one retries. In the run that prompted this it retried twelve times
 * over nine minutes, then apologised to the user for a wall it was never shown.
 *
 * What replaces the old rule is a constraint on the writer rather than a filter
 * here: **an `error` is model-visible, so a facet must write it in words that
 * are safe for one to read and act on.**
 *
 * **Neither half is clipped.** A report cut short reads as complete, and its
 * tail is where it says what was left undone. A facet that can produce a
 * runaway `error` bounds it where it writes it.
 *
 * Still one field, not two. The model's question is "what came back from this
 * branch", and `status` already says which kind of answer it is getting.
 *
 * A type alias, not an interface: this is serialized as the tool result's
 * `JSONValue`, and only aliases get the implicit index signature that satisfies.
 */
export type DelegateSubtaskOutcome = {
  subtaskId: SubtaskId;
  type: string;
  status: SubtaskStatus;
  output: string | null;
};

/**
 * Rebuild one round's call input from its durable rows, in stable ordinal order.
 * Typed as {@link DecompositionProposal} — the same type the model's own calls
 * are validated into — so the reconstructed call and an emitted one cannot drift
 * apart in shape.
 *
 * `referenceIndexes` is omitted rather than faked: this round's references were
 * snapshotted verbatim onto the rows when it ran, and the catalog they were
 * chosen from is long gone.
 *
 * A subtask proposal carries no identifier of its own, so the model pairs each
 * entry here with its outcome **by position**: both arrays are built from the
 * same ordinal-ordered `branches`, and the outcome additionally repeats `type`
 * and carries the durable `subtaskId`.
 */
export function delegateCallInput(
  reply: string,
  branches: CompositionBranch[]
): DecompositionProposal {
  return {
    reply,
    subtasks: branches.map((branch) => ({
      type: branch.type,
      prompt: branch.prompt,
      // Reconstructed verbatim from the row: a later round must see the same
      // params the call really carried, or it cannot reason about what ran.
      params: branch.params
    }))
  };
}

/**
 * Rebuild one round's call result from its durable rows, in stable ordinal order.
 *
 * A completed branch reports its parts; any other branch reports its `error`, or
 * `null` when it has none to give — a cancelled branch usually does not, and
 * inventing a sentence for it would be worse than the absence.
 */
export function delegateCallOutput(
  branches: CompositionBranch[]
): DelegateSubtaskOutcome[] {
  return branches.map((branch) => ({
    subtaskId: branch.subtaskId,
    type: branch.type,
    status: branch.status,
    output:
      branch.status === "completed"
        ? (branch.resultParts ?? []).map((part) => part.text).join("\n")
        : branch.error || null
  }));
}
