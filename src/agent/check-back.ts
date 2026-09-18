import { tool, type Tool } from "ai";
import { z } from "zod";
import { nonBlank } from "../subtasks/decomposition.js";

/**
 * The `check_back` tool — the round putting itself down and picking itself up.
 *
 * It **ends** the round, for the reason
 * {@link file://./ask-user.ts askUserTool} ends one: a round runs inside a single
 * Workflow step and a step cannot wait, while the Workflow can, for nothing. So
 * the wait is the round's output like any other ending, the Workflow sleeps on it,
 * and the round after it reads what it was waiting for.
 *
 * The distinction from `ask_user` is who is expected to act. A question needs a
 * person and is answered when they get to it; this needs only time, and nobody is
 * told anything. That is also what makes it cheap enough to offer: waiting holds
 * no concurrency and is not charged to the Task's wall clock, so what bounds it is
 * {@link file://../config.ts AgentLimits.maxDeferrals} and `maxDeferredMs` rather
 * than the budget the work itself spends.
 *
 * Offered on an `open` round whose deferral budget is intact — withheld from a
 * `final` round, which has none left to act on what it would wake to, and withheld
 * once the deferrals are spent, which is the state `RoundPolicy.deferralsSpentNote`
 * explains.
 */

export const CHECK_BACK_TOOL_NAME = "check_back";

/**
 * The shortest and longest one wait may be.
 *
 * The floor is not politeness to whatever is being polled — it is what stops a
 * loop of one-second rounds spending the deferral budget faster than anything it
 * watches could possibly change. The ceiling keeps a single call from swallowing
 * the whole allowance, so a model that misjudges one wait still has others.
 */
export const MIN_CHECK_BACK_SECONDS = 10;
export const MAX_CHECK_BACK_SECONDS = 600;

/**
 * The call's input, exported for the reason `ask_user`'s is: a control tool has no
 * `execute`, so the round parses the call itself — see
 * {@link file://./control.ts control.ts}.
 */
export const checkBackInputSchema = z.object({
  seconds: z
    .number()
    .int()
    .min(MIN_CHECK_BACK_SECONDS)
    .max(MAX_CHECK_BACK_SECONDS)
    .describe(
      `How long to wait, in seconds, between ${MIN_CHECK_BACK_SECONDS} and ${MAX_CHECK_BACK_SECONDS}. Pick it from how fast the thing you are waiting on actually changes — a check that comes back the same costs a wait you could have spent on a longer one.`
    ),
  why: nonBlank("why").describe(
    "What you are waiting for, and what you will check when you wake. You are writing this for yourself: the next round reads it and nothing else records why it stopped."
  )
});

/**
 * The tool as the model sees it, **without `execute`** like every control tool.
 *
 * Annotated rather than inferred, for the packaging reason given on
 * {@link file://./final-reply.ts finalReplyTool}.
 */
export const checkBackTool: Tool<{ seconds: number; why: string }> = tool({
  description:
    "Wait, then carry on with this request yourself. Ends this round without telling anyone anything; when the time is up the next round starts where this one stopped, and you check again. Use it when going on means waiting for something outside your control that you can look at again — a review, a build, a deploy. Do not use it to pause between steps you could take now, and never in place of answering.",
  inputSchema: checkBackInputSchema
});
