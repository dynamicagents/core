import { tool, type Tool } from "ai";
import { z } from "zod";
import { nonBlank } from "../subtasks/decomposition.js";

/**
 * The `ask_user` tool — the round stopping to ask the person the Task is for.
 *
 * It **ends** the round rather than pausing inside it, and that is the design. A
 * round runs inside one Workflow step, and a step cannot wait days for anyone; the
 * Workflow can, for free. So the question is the round's output like any other
 * ending, the Workflow parks on the answer, and the next round finds the question
 * and its answer in the conversation, the way it finds every other turn.
 *
 * Offered only to an agent whose policy says it may ask — `RoundPolicy.human` —
 * and never on a `final` round, which has no budget left to act on the answer.
 */

export const ASK_USER_TOOL_NAME = "ask_user";

/**
 * The most answers one question may offer to pick from. Past a handful, a
 * question is a form, and the person is better served typing what they mean.
 */
export const MAX_ASK_OPTIONS = 6;

/**
 * The call's input, exported for the same reason `final_reply`'s is: a control
 * tool has no `execute`, so the round parses the call itself — see
 * {@link file://./control.ts control.ts}.
 */
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
 * The tool as the model sees it, **without `execute`** like every control tool.
 *
 * Annotated rather than inferred, for the packaging reason given on
 * {@link file://./final-reply.ts finalReplyTool}.
 */
export const askUserTool: Tool<{ question: string; options?: string[] }> = tool(
  {
    description:
      "Ask the person you are working for a question, and end this round. Their answer is in the conversation when your next round starts, and you continue from there. Use it when you cannot go on well without a decision or a fact only they have — not to announce what you are about to do, and not to confirm what you already know.",
    inputSchema: askUserInputSchema
  }
);
