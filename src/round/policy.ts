import type { AgentLimits } from "../config.js";

/**
 * Why a round was handed no tools but the answer.
 *
 * A ceiling and a wall end a round the same way and read to the user completely
 * differently, so {@link file://./turn.ts RoundMode} says what the round may *do*
 * and this says *why* — the same split {@link file://./turn.ts RunTurnOutcome}
 * makes between a status and its kind.
 *
 * - `budget` — the Task spent its turns or its wall clock. The original reason,
 *   and what a caller that names none is taken to mean.
 * - `no-progress` — several rounds in a row delegated work that came back failing
 *   the identical way. The budget is intact and the work is going nowhere, so a
 *   round told its budget was spent would be told something false, and would tell
 *   the user so in turn.
 */
export type FinalRoundReason = "budget" | "no-progress";

/**
 * Everything about a round loop that is **yours**, not core's.
 *
 * The round loop in this subpath is mechanism: concurrent subtask execution,
 * chunked subagent runs, cancellation ordering, idempotent recovery, the
 * primary→fallback→repair ladder. None of it varies between agents, and every
 * place it *did* vary between two agents in one repo turned out to be a bug.
 *
 * What genuinely varies is what the model is told and what the user reads — and
 * core ships no prompt copy, deliberately, so that no run ever executes under an
 * identity nobody chose. This interface is that boundary, made explicit: supply
 * the words, get the machine.
 *
 * ```ts
 * export const policy: RoundPolicy = {
 *   roundContract: ({ typeKeys, maxSubtasks }) => `…`,
 *   finalRoundNote: (limits, reason) => `…`,
 *   copy: {
 *     taskFailed: "Sorry — something went wrong handling that request.",
 *     recoveredReply: "Working on your request.",
 *     partialNote: "Some parts of this request could not be completed…"
 *   }
 * };
 * ```
 *
 * Nothing here is optional and nothing has a default. A stub that returned an
 * empty contract would produce a round the model has no way to end correctly,
 * and a lending default would be exactly the house prompt copy core refuses to
 * have.
 *
 * ## Each prompt string owns its own leading separator
 *
 * {@link roundContract} and {@link finalRoundNote} are concatenated directly
 * onto text that came from somewhere else — the soul, the caller context, and
 * for `finalRoundNote` the open contract itself. The composition adds nothing
 * between them, so **start each with a blank line** (`\n\n`, or a template
 * literal opening on an empty line, which is what the starter does):
 *
 * ```ts
 * roundContract: () => `
 *
 * # Answering this request
 * …`
 * ```
 *
 * Return `"# Answering this request…"` with no leading newline and the model
 * reads `Calling workspace: 1.# Answering this request` — a run-together line
 * that costs nothing to produce and is invisible in every test that does not
 * assert on the rendered prompt.
 *
 * Core does not insert the separator for you, because these are *your* sections
 * and a section that cannot control its own spacing cannot control its shape —
 * a policy that legitimately wants a single newline, or continues the previous
 * paragraph, has no way to say so once core has decided.
 */
export interface RoundPolicy {
  /**
   * The round contract: how a round ends, and what `delegate` takes. Appended to
   * the soul and the caller context on every round.
   *
   * `typeKeys` is the installed subtask types — the only values `delegate` may
   * name. Per-type guidance is *not* written here: each type declares its own
   * via `SubtaskTypeSpec.delegationGuidance`, and the loop appends it, so this
   * text names no domain.
   */
  roundContract(ctx: {
    typeKeys: readonly string[];
    maxSubtasks: number;
  }): string;

  /**
   * Appended when a round is forced to answer. That round is handed no work tools
   * and no `delegate`, so this explains a constraint the model can already see
   * rather than imposing one.
   *
   * Called once per {@link FinalRoundReason} when the instructions are built, so
   * both arms exist before either is needed. An implementation that ignores the
   * reason still satisfies this and gets one note for both — accurate about the
   * constraint, wrong about the cause, which is the whole argument for writing
   * the second arm.
   */
  finalRoundNote(limits: AgentLimits, reason: FinalRoundReason): string;

  /** The strings a user can actually read. */
  copy: {
    /**
     * User-facing text on a failed Task. The diagnostic is logged separately —
     * this is what the person sees.
     */
    taskFailed: string;
    /**
     * Stand-in acknowledgement for the unreachable case where a round's subtasks
     * are durable but its acknowledgement is not in the Session. Neutral by
     * design: the work is valid and running, so the user gets an honest
     * acknowledgement rather than a failed Task.
     */
    recoveredReply: string;
    /**
     * Appended when a deterministic join has to disclose gaps — both models
     * failed, but earlier branches succeeded and their results are worth
     * delivering.
     */
    partialNote: string;
  };
}
