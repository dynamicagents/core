import { tool, type Tool } from "ai";
import { z } from "zod";
import { nonBlank } from "../subtasks/decomposition.js";

/**
 * The `final_reply` tool — the main agent answering the user itself, and the other
 * way a round can end.
 *
 * **Prose is not an outcome.** Both endings are named tools, the round runs with
 * `toolChoice: "required"`, and a round that ends any other way has failed its
 * attempt. Let a round end with plain text instead and "the model answered the
 * user" and "the model narrated an action it never took" become the same outcome
 * — a non-empty string — so a model that writes "I'll start the game" and emits
 * no call completes the Task successfully, having done nothing.
 *
 * The *choice* is still entirely the model's — the point of the design (see
 * {@link file://../round/turn.ts turn.ts}) is not that the model be steered toward
 * delegating, only that it not be forced. Picking between two named tools is also a
 * far easier discrimination for a small model than picking between prose and a tool,
 * which is what the weaker fallback models get wrong.
 *
 * This lives outside `subtasks/` deliberately: replying is not a subtask concept.
 */

export const FINAL_REPLY_TOOL_NAME = "final_reply";

/**
 * The call's input, exported as the zod schema rather than only as the tool's
 * `inputSchema`, because the round has to run it itself.
 *
 * A tool with no `execute` never has its input validated by the SDK — the loop
 * halts on the call and nothing checks it. That is what let a blank `text` through
 * to the user despite {@link nonBlank}. The round now parses every control call
 * with the tool's own schema before using it (see
 * {@link file://./control.ts control.ts}), and needs the schema in hand to do it.
 */
export const finalReplyInputSchema = z.object({
  text: nonBlank("text").describe(
    "Your reply, in your own voice. This is shown to the user verbatim, so it must be the complete answer and must not be blank."
  )
});

/**
 * The tool as the model sees it. **Without `execute`**, exactly like
 * {@link file://../subtasks/delegate.ts delegateTool}: the call *is* the round's
 * output, so there is nothing for the SDK to run and the loop halts on it.
 *
 * Unlike `delegate`, this call is never reconstructed in a later round's history —
 * a past reply is stored as, and replayed as, ordinary assistant text (history is
 * text-only by design). The tool exists to constrain *generation*, not to become a
 * new shape in the transcript.
 */
/*
 * Annotated, not inferred, and the annotation is a **packaging** constraint
 * rather than a style choice.
 *
 * `tool()` returns `Tool<Input, Output, Context>`, and `Context` lives in
 * `@ai-sdk/provider-utils` — an internal of `ai`, which resolves it as a nested
 * copy. Left inferred, `tsc` emits `import("@ai-sdk/provider-utils").Context`
 * into this module's `.d.ts`, so every consumer typechecking
 * `@dynamicagents/core/agent` needs a package this one does not declare and cannot
 * usefully declare: pinning it here installs a *second*, different major
 * alongside `ai`'s own, and TypeScript then refuses the reference outright as
 * unportable.
 *
 * Naming the type through `ai`'s own re-export keeps the emitted declaration
 * pointing at a package that is already a required peer. `verify:exports` walks
 * the declaration graph for exactly this.
 */
export const finalReplyTool: Tool<{ text: string }> = tool({
  description:
    "Answer the user and end this round. Use this whenever the request is yours to answer — anything about this conversation, your own history, memory, or tools, and anything you can settle with the tools available to you here, including work that has already come back to you.",
  inputSchema: finalReplyInputSchema
});
