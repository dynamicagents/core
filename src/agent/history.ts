import { createCompactFunction } from "agents/sessions";
import { generateText, type LanguageModel } from "ai";

/**
 * What core's Think classes keep of a turn, and how that history compacts —
 * one home for both, because `StepAgent` and `SubAgent` each make both choices.
 */

/**
 * `sendReasoning` for both classes: off, so a turn's reasoning is never stored.
 *
 * Think builds the stored assistant message from the UI message stream, which
 * carries reasoning only when `sendReasoning` is on. Stored, a reasoning part is
 * counted by the history estimate `compactAfter` checks and re-sent on every
 * later call, while the model reads none of it: a glm-5.3 call that re-sent
 * 200,717 characters of earlier reasoning, the current turn's among them, was
 * billed 25,378 input tokens — so compaction ran at about 25k real tokens
 * against a 60k threshold. The model still reasons, and a step's reasoning still
 * reaches the next step of its turn: Think runs a turn as one `streamText`,
 * which carries it in memory.
 */
export const SEND_REASONING = false;

/**
 * Compaction that summarizes without reasoning.
 *
 * A summary is a paraphrase, and the turn waits for it: a glm-5.3 compaction
 * spent 34,552 characters reasoning to write a 13,650-character summary, over
 * 120 s. `reasoning: "none"` is the AI SDK's provider-neutral switch, which
 * workers-ai-provider sends as `reasoning_effort: null`.
 *
 * `model` is read per compaction, as `compactionModel()` is resolved per call.
 */
export function compaction(
  model: () => LanguageModel,
  keepRecentTokens: number
) {
  return createCompactFunction({
    summarize: (prompt) =>
      generateText({ model: model(), prompt, reasoning: "none" }).then(
        (r) => r.text
      ),
    keepRecentTokens
  });
}
