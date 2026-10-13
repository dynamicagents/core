import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AiEnv } from "../env.js";
import { modelGateway, type GatewayLogFields } from "./gateway-log.js";

/** One Workers AI chat model, as an agent's `getModel()` returns it. */
export interface WorkersAIModelOptions extends GatewayLogFields {
  /**
   * A `@cf/...` Workers AI id, and only that.
   *
   * A `"<provider>/<model>"` catalog slug is **accepted here and silently
   * wrong**: with no provider plugins configured, `workers-ai-provider` builds
   * a Workers AI chat model for the slug, which sends Workers AI's wire format
   * and reads nothing back out of the provider's reply. The turn ends with empty
   * text and no error — measured, not inferred. Slugs belong in
   * {@link file://./catalog.ts catalogModel}.
   */
  modelId: string;
  /** Which AI Gateway. `"default"` auto-provisions on first request. */
  gatewayId?: string;
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
 * The gateway goes on the **model's** settings and never on the provider's:
 * `workers-ai-provider` takes the provider's in preference to the model's on
 * this path, so a gateway set on both silently discards the model's `metadata`
 * and `eventId`.
 *
 * Built per call, never at module scope: bindings are not populated while
 * `wrangler deploy` evaluates the module, and `createWorkersAI` throws without
 * one.
 */
export function workersAIModel(
  env: AiEnv,
  options: WorkersAIModelOptions
): LanguageModel {
  const { modelId, gatewayId, reasoningEffort, sessionAffinity } = options;
  return createWorkersAI({ binding: env.AI })(modelId, {
    gateway: modelGateway(gatewayId, options),
    ...(sessionAffinity ? { sessionAffinity } : {}),
    ...(reasoningEffort !== undefined
      ? { reasoning_effort: reasoningEffort }
      : {})
  });
}
