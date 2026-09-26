import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * The tools core gives every agent. None of them is prompt copy: each is a
 * protocol fact (asking the caller, waiting, reading history), described once.
 */

const nonBlank = (label: string) =>
  z
    .string()
    .min(1)
    .regex(/\S/, { message: `${label} must not be blank` });

// --- ask_user ----------------------------------------------------------------

export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * The most answers one question may offer. Past a handful a question is a
 * form, and the person is better served typing what they mean.
 */
export const MAX_ASK_OPTIONS = 6;

export const askUserInputSchema = z.object({
  question: nonBlank("question").describe(
    "The question, as the person will read it. Say what you need to know and why, briefly — they read it away from everything you have looked at."
  ),
  options: z
    .array(nonBlank("option"))
    .min(2)
    .max(MAX_ASK_OPTIONS)
    .optional()
    .describe(
      "Answers they can pick from, when the question has a short list of them. Leave out to have them type an answer."
    )
});

/**
 * Ask the person the task is for, and end the turn.
 *
 * **No `execute`.** The turn stops on the call (`beforeTurn`'s `stopWhen`),
 * the submission completes with the call unanswered, the task parks as
 * `input-required`, and the answer arrives as the next user message. That is
 * Think's documented pattern. `needsApproval` would count as pending and park
 * the submission instead, which is a different lifecycle.
 */
export const askUserTool: Tool<{ question: string; options?: string[] }> = tool(
  {
    description:
      "Ask the person you are working for a question, and stop. Their answer arrives as their next message, and you continue from there. Use it when you cannot go on well without a decision or a fact only they have — not to announce what you are about to do, and not to confirm what you already know.",
    inputSchema: askUserInputSchema
  }
);

// --- check_back --------------------------------------------------------------

export const CHECK_BACK_TOOL_NAME = "check_back";

/**
 * The floor stops a loop of one-second turns polling faster than anything it
 * watches could change. The ceiling is the gatekeeper's: it cancels a task
 * that has not settled within the hour.
 */
export const MIN_CHECK_BACK_SECONDS = 10;
export const MAX_CHECK_BACK_SECONDS = 3600;

export const checkBackInputSchema = z.object({
  seconds: z
    .number()
    .int()
    .min(MIN_CHECK_BACK_SECONDS)
    .max(MAX_CHECK_BACK_SECONDS)
    .describe(
      `How long to wait, in seconds, between ${MIN_CHECK_BACK_SECONDS} and ${MAX_CHECK_BACK_SECONDS}. Pick it from how fast the thing you are waiting on actually changes.`
    ),
  why: nonBlank("why").describe(
    "What you are waiting for, and what you will check when you wake. You are writing this for yourself: it is what you are handed when the wait ends."
  )
});

export const CHECK_BACK_DESCRIPTION =
  "Wait, then carry on with this request yourself. Ends this turn without telling anyone anything; when the time is up you are woken on this same request, and you check again. Use it when going on means waiting for something outside your control that you can look at again — a review, a build, a deploy. Do not use it to pause between steps you could take now, and never in place of answering.";

// --- search_history ----------------------------------------------------------

export const SEARCH_HISTORY_TOOL_NAME = "search_history";

/** One hit, as the model reads it. */
export interface HistoryHit {
  role: string;
  content: string;
  createdAt?: string;
}

/**
 * Full-text search over this conversation's own history, compacted rows
 * included — compaction folds rows into a summary for the prompt and keeps
 * them in storage, so an old detail is still findable here.
 */
export function searchHistoryTool(
  search: (query: string, limit: number) => Promise<HistoryHit[]>
): Tool<{ query: string; limit?: number }> {
  return tool({
    description:
      "Search everything said earlier in this conversation with the caller, including what has scrolled out of view. Use it before asking the caller something they may already have told you.",
    inputSchema: z.object({
      query: nonBlank("query").describe(
        "Words to look for. Matches whole words, not meaning."
      ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("How many matches to return. Defaults to 10.")
    }),
    execute: async ({ query, limit }) => {
      const hits = await search(query, limit ?? 10);
      return hits.length > 0 ? hits : "Nothing earlier matches that.";
    }
  });
}
