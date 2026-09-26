import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AiEnv } from "../env.js";
import type { GatewayLogFields } from "./gateway-log.js";

/** One Workers AI chat model, as an agent's `getModel()` returns it. */
export interface WorkersAIModelOptions extends GatewayLogFields {
  modelId: string;
  /** AI Gateway slug. `"default"` auto-provisions on first request. */
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
 * The gateway goes on the **model's** settings and never on the provider's:
 * `workers-ai-provider` resolves `providerGateway ?? modelGateway`, so a
 * gateway on both silently discards the model's `metadata` and `eventId`.
 *
 * Built per call, never at module scope: bindings are not populated while
 * `wrangler deploy` evaluates the module, and `createWorkersAI` throws without
 * one.
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
  return createWorkersAI({ binding: env.AI })(modelId, {
    gateway: {
      id: gatewayId,
      ...(metadata ? { metadata } : {}),
      ...(eventId ? { eventId } : {})
    },
    ...(sessionAffinity ? { sessionAffinity } : {}),
    ...(reasoningEffort !== undefined
      ? { reasoning_effort: reasoningEffort }
      : {})
  });
}
