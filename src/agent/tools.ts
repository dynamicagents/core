import { tool, type StopCondition, type Tool, type ToolSet } from "ai";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID
} from "@dynamicagents/g2a-protocol";
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
    ),
  artifact: nonBlank("artifact")
    .optional()
    .describe(
      "The id of something you made for them to approve, such as a plan. They get its link with your question, and answer Approve, Reject, or with a comment; `options` is not used. Approving it locks it, so it cannot change afterwards."
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
export const askUserTool: Tool<{
  question: string;
  options?: string[];
  artifact?: string;
}> = tool({
  description:
    "Ask the person you are working for a question, and stop. Their answer arrives as their next message, and you continue from there. Use it when you cannot go on well without a decision or a fact only they have — not to announce what you are about to do, and not to confirm what you already know.",
  inputSchema: askUserInputSchema
});

/**
 * What the model reads when the person answered an approval: which way they
 * went, and anything they typed. A typed answer with neither is a comment on
 * the thing they were shown.
 */
export function approvalAnswerText(answer: {
  optionId?: string;
  text?: string;
}): string {
  const verdict =
    answer.optionId === HITL_APPROVE_OPTION_ID
      ? "Approved."
      : answer.optionId === HITL_REJECT_OPTION_ID
        ? "Rejected."
        : undefined;
  if (!verdict) return `Comment: ${answer.text ?? ""}`.trim();
  return answer.text ? `${verdict}\n\n${answer.text}` : verdict;
}

/**
 * An approval's answer that did not reach its artifact: another answer locked
 * it first, or it is gone. The person's answer stands, but it changed nothing,
 * and the model is not told otherwise.
 */
export function unrecordedApprovalText(text: string): string {
  return `${text}\n\nThis answer was not recorded, so it changed nothing: the artifact was already locked by another answer, or it is gone.`;
}

/**
 * What the model reads when it names an artifact the agent will not put to the
 * person: one it does not know, or one already locked.
 */
export const UNAPPROVABLE_ARTIFACT =
  "Not an artifact you can ask the person to approve: it is unknown here, or already approved. Ask with the id you were given for it, or ask without one.";

/**
 * `ask_user` as an agent offers it, with `artifact` checked when the model
 * calls it. A refused one fails the call, and the model reads the error and
 * carries on in the same turn; see {@link askedUser}.
 *
 * Here rather than in {@link askUserInputSchema}: the check is async, and the
 * turn's outcome is read with that schema synchronously.
 */
export function askUserToolFor(
  mayAskApproval: (id: string) => Promise<boolean>
): typeof askUserTool {
  return {
    ...askUserTool,
    inputSchema: askUserInputSchema.extend({
      artifact: askUserInputSchema.shape.artifact.refine(
        async (id) => id === undefined || (await mayAskApproval(id)),
        { message: UNAPPROVABLE_ARTIFACT }
      )
    })
  };
}

/**
 * Whether the step asked the person something: an `ask_user` call that parsed.
 * `hasToolCall` also counts one that did not, which ends the turn with nothing
 * asked and its error unread by the model.
 */
export const askedUser: StopCondition<ToolSet> = ({ steps }) =>
  steps
    .at(-1)
    ?.toolCalls.some(
      (call) =>
        call.toolName === ASK_USER_TOOL_NAME &&
        !("invalid" in call && call.invalid === true)
    ) ?? false;

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
