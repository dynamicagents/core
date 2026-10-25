import type { LanguageModelMiddleware } from "ai";

/**
 * Tool-call ids a stored history carries that no provider will take back.
 *
 * A history outlives the model that wrote it, and every turn re-sends the ids
 * its earlier turns recorded. One spelling in that store is not a spelling any
 * provider accepts.
 */

/**
 * The separator a Workers AI tool-call id was recorded with before this package
 * reached Workers AI through `createAI`.
 *
 * It is not written any more, and nothing strips it on the way out either: the
 * provider that both appended and removed it is no longer what this package
 * reaches Workers AI through. It is still in the installed tree, as Think's own
 * dependency, which is why a stored id can carry a marker no code here writes.
 * So a conversation older than that change still holds marked ids, and they go
 * to whichever provider the conversation is on now.
 */
const WORKERS_AI_TOOL_CALL_MARKER = "::cf-wai-tool-call::";

/**
 * Rewrites a marked id into one every provider accepts, on the request only.
 *
 * OpenAI refuses an id over 64 characters, and GLM's `call_<24 hex>` is 65 once
 * marked; Anthropic refuses the colons in any marked id. The marker becomes `_`
 * rather than going with its suffix, because the suffix is random per call and
 * keeps two calls apart where the model's own ids collide.
 *
 * Applied on every path rather than on the one that used to need it. The id a
 * request carries has to be one the provider reading it accepts, and which
 * provider that is belongs to the agent's configuration rather than to the turn
 * that recorded the id.
 *
 * Only the request is rewritten; the stored history keeps what it has. So this
 * holds for as long as any conversation predating `createAI` is still being
 * answered, and the day none is it is dead code rather than wrong code.
 */
export const workersAIToolCallIds: LanguageModelMiddleware = {
  transformParams: ({ params }) =>
    Promise.resolve({
      ...params,
      // A case per role: mapped as one union, the assistant's content array
      // and the tool's type as neither.
      prompt: params.prompt.map((message) => {
        switch (message.role) {
          case "assistant":
            return { ...message, content: message.content.map(resendable) };
          case "tool":
            return { ...message, content: message.content.map(resendable) };
          default:
            return message;
        }
      })
    })
};

function resendable<P extends object>(part: P): P {
  return "toolCallId" in part && typeof part.toolCallId === "string"
    ? {
        ...part,
        toolCallId: part.toolCallId.replace(WORKERS_AI_TOOL_CALL_MARKER, "_")
      }
    : part;
}
