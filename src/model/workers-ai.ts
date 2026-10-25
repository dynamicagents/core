import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware
} from "ai";
import type { AiEnv } from "../env.js";
import type { GatewayLogFields } from "./gateway-log.js";
import { workersAIToolCallIds } from "./tool-call-ids.js";

/** One Workers AI chat model, as an agent's `getModel()` returns it. */
export interface WorkersAIModelOptions extends GatewayLogFields {
  modelId: string;
  /** AI Gateway slug. `"default"` auto-provisions on first request. */
  gatewayId?: string;
  /**
   * The effort this model reasons at unless a call asks for something else.
   * `null` turns reasoning off.
   *
   * A **default**, not an override: the AI SDK's provider-neutral `reasoning`
   * call option wins over it, and core relies on that — compaction asks for
   * `reasoning: "none"` because a summary is a paraphrase, and a host's
   * configured effort must not turn that back on. See
   * {@link file://./tool-call-ids.ts} for the other thing the middleware chain
   * here is for, and {@link reasoningDefault} for why this is middleware at all.
   */
  reasoningEffort?: "low" | "medium" | "high" | null;
  /**
   * Prefix-cache routing key. Every call an object makes re-sends one history,
   * so the key is the object's name — anything finer routes a call away from
   * the prefix it is about to re-send.
   */
  sessionAffinity?: string;
}

/**
 * A Workers AI model through AI Gateway, carrying what the call tells the
 * gateway about itself.
 *
 * For a model from another provider in AI Gateway's catalog, over this same
 * binding, see {@link file://./catalog.ts catalogModel} — the `modelId` here is
 * a `@cf/...` id and nothing else.
 *
 * `modelId` stays a `string` rather than the union `createAI` accepts. The
 * catalogue of ids belongs to the deployment, which reads them from its own
 * config, and a union here would make every id a consumer configures a compile
 * error it has to cast away. An id no provider knows is rejected by the gateway
 * on the first call, which is where an id typed from config has to be checked
 * anyway.
 *
 * Every gateway option goes on the **model** rather than on the provider.
 * `createAI` merges the two levels with the model's winning, so either would
 * reach the request, and one level is one place to read.
 *
 * Built per call, never at module scope: bindings are not populated while
 * `wrangler deploy` evaluates the module.
 */
export function workersAIModel(
  env: AiEnv,
  options: WorkersAIModelOptions
): LanguageModel {
  const {
    modelId,
    gatewayId = "default",
    reasoningEffort,
    metadata,
    eventId,
    sessionAffinity
  } = options;
  return wrapLanguageModel({
    model: createAI({ binding: env.AI })(modelId as CloudflareLanguageModelId, {
      id: gatewayId,
      ...(metadata ? { metadata } : {}),
      ...(eventId ? { eventId } : {}),
      ...(sessionAffinity ? { sessionAffinity } : {})
    }),
    middleware:
      reasoningEffort === undefined
        ? workersAIToolCallIds
        : [workersAIToolCallIds, reasoningDefault(reasoningEffort)]
  });
}

/**
 * The host's configured effort, applied only to a call that asked for none.
 *
 * It is middleware rather than a model option because the provider resolves the
 * two the other way round: an effort set on the model wins over the call's
 * `reasoning`, so passing it there would make
 * {@link file://../agent/history.ts compaction}'s `reasoning: "none"` a no-op on
 * any model a host configured an effort for, and a compaction that reasons is
 * the 120-second cost that switch exists to avoid. Set per call instead, where
 * the provider gives it the lowest precedence of the three.
 *
 * `"provider-default"` counts as asking for none: it names the provider's own
 * default, which for a configured model is this.
 */
function reasoningDefault(
  reasoningEffort: "low" | "medium" | "high" | null
): LanguageModelMiddleware {
  return {
    transformParams: ({ params }) =>
      Promise.resolve(
        params.reasoning === undefined ||
          params.reasoning === "provider-default"
          ? {
              ...params,
              providerOptions: {
                ...params.providerOptions,
                cloudflare: {
                  reasoningEffort,
                  ...params.providerOptions?.cloudflare
                }
              }
            }
          : params
      )
  };
}
