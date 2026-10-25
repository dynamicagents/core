import { createOpenAI } from "@ai-sdk/openai";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware
} from "ai";
import type { AiEnv } from "../env.js";
import type { GatewayLogFields } from "./gateway-log.js";
import { workersAIToolCallIds } from "./tool-call-ids.js";

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
  /**
   * OpenAI's prompt-cache routing key. Every call an object makes re-sends one
   * history, so the key is the object's name, as it is for Workers AI's
   * `sessionAffinity`. Read by `openai/*` slugs only.
   */
  sessionAffinity?: string;
}

/**
 * The key `@ai-sdk/openai` is built with, and a placeholder because no key is
 * wanted here.
 *
 * The provider refuses to build a request without one, and this one never
 * leaves the Worker: `vendorKey: "gateway"` below drops the `authorization`
 * header the provider wrote before the request goes out, so the gateway
 * authenticates with what it holds for the provider.
 */
const NO_VENDOR_KEY = "unused";

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
 * `slug` stays a `string` for the reason `modelId` does next door, and the
 * gateway options go on the model for the reason given there too.
 *
 * **Two transports, and a slug's provider decides which.**
 *
 * A slug that is not OpenAI's is passed to `createAI` as an id, which dispatches
 * it through `env.AI.run`. That transport names each streamed run and resumes it
 * from the last complete event when the connection drops, so a turn whose stream
 * dies mid-flight is picked up rather than restarted.
 *
 * An `openai/*` slug is instead built as OpenAI's own Responses model and handed
 * to `createAI` as a model object, which sends it down AI Gateway's
 * provider-native path: OpenAI's own request body, parser and error shapes, with
 * only the transport Cloudflare's. That path carries no run id, so **a dropped
 * stream on an OpenAI turn is not resumed here**; it is an interrupted turn, and
 * Think's chat recovery continues it on the next wake. The trade buys the
 * Responses API as OpenAI itself writes it, which is what its reasoning models
 * need in order to accept function tools at any effort above `"none"`.
 *
 * So a bare `"openai/..."` string returned from `getModel()` is not the model
 * this builds: Think resolves a model id through its own bundled provider, which
 * writes Chat Completions and sends none of the defaults below.
 *
 * Nothing stands one model in for another when a call fails. `createAI` takes a
 * `fallback` list and this passes none: a second model answering a history the
 * first wrote is a different conversation, and the retry that is wanted here is
 * the AI SDK's own.
 *
 * There is no reasoning budget here: where one of these models takes a
 * reasoning effort it is an AI SDK `providerOptions` value, set on the call
 * rather than on the model.
 */
export function catalogModel(
  env: AiEnv,
  options: CatalogModelOptions
): LanguageModel {
  const {
    slug,
    gatewayId = "default",
    metadata,
    eventId,
    sessionAffinity
  } = options;
  const gateway = {
    id: gatewayId,
    ...(metadata ? { metadata } : {}),
    ...(eventId ? { eventId } : {})
  };
  const ai = createAI({ binding: env.AI });
  const openAIModelId = openAIModelOf(slug);
  return wrapLanguageModel({
    // `wrapLanguageModel` outside `ai()`, never inside it: a routed model is
    // asked for the provider settings a middleware wrapper does not have, and
    // `createAI` rejects one that cannot answer.
    model:
      openAIModelId === undefined
        ? ai(slug as CloudflareLanguageModelId, gateway)
        : ai(createOpenAI({ apiKey: NO_VENDOR_KEY }).responses(openAIModelId), {
            ...gateway,
            // The default, written out because what it decides is whether a
            // credential leaves this Worker. See {@link NO_VENDOR_KEY}.
            vendorKey: "gateway"
          }),
    middleware:
      openAIModelId === undefined
        ? workersAIToolCallIds
        : [workersAIToolCallIds, openAIDefaults(sessionAffinity)]
  });
}

/**
 * The model id OpenAI knows itself by, for an `openai/*` slug, and `undefined`
 * for every other provider.
 *
 * A catalog slug names the provider and then that provider's own id, and the
 * provider-native path needs the second half alone: the provider is read from
 * the host the vendor's own model would have called.
 */
function openAIModelOf(slug: string): string | undefined {
  const prefix = "openai/";
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : undefined;
}

/**
 * Defaults for every `openai/*` call, under any the caller sets.
 *
 * `store: false`, because Responses would otherwise keep each reply at OpenAI
 * and send the next step a reference to it, into whichever OpenAI organization
 * AI Gateway billed. Off, the provider asks for the reasoning encrypted and
 * sends it back by value, which is what a step's tool loop needs. No reasoning
 * outlives its turn anyway: see {@link file://../agent/history.ts}.
 */
function openAIDefaults(sessionAffinity?: string): LanguageModelMiddleware {
  return {
    transformParams: ({ params }) =>
      Promise.resolve({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: {
            store: false,
            ...(sessionAffinity ? { promptCacheKey: sessionAffinity } : {}),
            ...params.providerOptions?.openai
          }
        }
      })
  };
}
