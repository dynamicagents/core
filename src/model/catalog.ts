import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic } from "workers-ai-provider/anthropic";
import { openai } from "workers-ai-provider/openai";
import type { AiEnv } from "../env.js";
import type { GatewayLogFields } from "./gateway-log.js";

/** One AI Gateway catalog model, as an agent's `getModel()` returns it. */
export interface CatalogModelOptions extends GatewayLogFields {
  /**
   * `"<provider>/<model>"`: the provider slug AI Gateway's directory lists, then
   * that provider's own model id — `"openai/gpt-5.5"`. A `@cf/...` id is a
   * Workers AI model and belongs in
   * {@link file://./workers-ai.ts workersAIModel} instead; this function has
   * nothing to add to one.
   */
  slug: string;
  /** Which AI Gateway. `"default"` auto-provisions on first request. */
  gatewayId?: string;
}

/**
 * A model from AI Gateway's provider catalog, over the `AI` binding Workers AI
 * uses and carrying the same log fields.
 *
 * **No provider credential crosses this call, and there is none to configure.**
 * The binding authenticates the Worker to AI Gateway, which then decides what
 * pays: a key stored for that provider on the gateway, or failing that the
 * account's own balance. So a deployment adds a provider by naming a slug, and
 * an operator never holds a model key — which is the whole reason to prefer this
 * over the provider's own endpoint, where the key would have to live in the
 * Worker.
 *
 * The provider plugins are the pair Think resolves a bare model string with, so
 * a slug returned from `getModel()` as a string and one built here reach the
 * same provider through the same parser. They are what make a slug routable at
 * all: without them `workers-ai-provider` builds Workers AI models only.
 *
 * The gateway goes on the **model's** settings, as it does for Workers AI — but
 * for a catalog slug the model's is the one that wins (`modelGateway ??
 * providerGateway`), which is the opposite order to the Workers AI path next
 * door. Nothing here sets a provider-level gateway, so the two cannot disagree;
 * the order matters to whoever adds one. Built per call for the reason given in
 * {@link file://./workers-ai.ts workersAIModel}.
 *
 * A slug dispatches through `env.AI.run`, the transport that carries resumable
 * streaming. Gateway-side response caching and server-side fallback are the two
 * things that would move the call to the gateway's other transport, which does
 * not surface a resume handle — so buying either means giving up the recovery of
 * a turn whose stream dies mid-flight. That is the trade neither is plumbed for
 * here, and it is why this module ships no fallback model.
 *
 * There is no `sessionAffinity` and no reasoning budget: the first is a Workers
 * AI prefix-cache key and the second a Workers AI input field, and a catalog
 * provider reads neither. Where one of these models takes a reasoning effort it
 * is an AI SDK `providerOptions` value, set on the call rather than on the
 * model.
 */
export function catalogModel(
  env: AiEnv,
  options: CatalogModelOptions
): LanguageModel {
  const { slug, gatewayId = "default", metadata, eventId } = options;
  return wrapLanguageModel({
    model: createWorkersAI({
      binding: env.AI,
      providers: [openai, anthropic]
    })(slug, {
      gateway: {
        id: gatewayId,
        ...(metadata ? { metadata } : {}),
        ...(eventId ? { eventId } : {})
      }
    }),
    middleware: workersAIToolCallIds
  });
}

/**
 * What `workers-ai-provider` joins onto every tool-call id a Workers AI model
 * emits, and takes off again only when it sends that history back to Workers AI.
 */
const WORKERS_AI_TOOL_CALL_MARKER = "::cf-wai-tool-call::";

/**
 * A history outlives the model that wrote it, so a conversation moved onto a
 * slug re-sends the ids its Workers AI turns recorded, marker and all, and the
 * provider plugins pass them on verbatim. OpenAI refuses an id over 64
 * characters, and GLM's `call_<24 hex>` is 65 once marked; Anthropic refuses
 * the colons in any marked id. The marker becomes `_` rather than going with
 * its suffix: the suffix is random per call, so it keeps two calls apart where
 * the model's own ids collide.
 *
 * Only the request is rewritten. The stored history keeps the marker, so the
 * same conversation moved back onto Workers AI is stripped by its own provider.
 */
const workersAIToolCallIds: LanguageModelMiddleware = {
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
