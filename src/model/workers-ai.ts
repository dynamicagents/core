import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { AiEnv } from "../env.js";
import type { AiGatewayMetadata } from "./gateway-log.js";

/**
 * One Workers AI model, built per turn.
 *
 * There is **no fallback**. An agent runs one model: a transient failure is the
 * AI SDK's retries and Think's chat recovery to handle, and a model that cannot
 * take the call at all is a deployment fact, not something to paper over with a
 * second model whose answers nobody compared.
 *
 * Reading `env.AI` at module scope does not survive packaging — `env` does not
 * exist there on Workers — so this takes the binding as a parameter, like every
 * other core function that needs one.
 */

export interface WorkersAIModelOptions {
  /** The Workers AI model id, e.g. `@cf/zai-org/glm-4.6`. */
  modelId: string;
  /** AI Gateway to route through. Absent, the binding is called directly. */
  gatewayId?: string;
  /**
   * Reasoning budget, for a model that takes one. Passed through verbatim: the
   * accepted values are the model's, and core knows none of them.
   */
  reasoningEffort?: string;
  /** What this call tells the gateway about itself — see {@link gatewayLogFields}. */
  metadata?: AiGatewayMetadata;
  /** The exact handle for this unit of work in the Logs API's `event_id` filter. */
  eventId?: string;
  /**
   * Workers AI prefix-cache affinity key. Steers model-instance routing, so it
   * must be **stable for one conversation and distinct between conversations**.
   */
  sessionAffinity?: string;
}

/**
 * Build the model for one turn.
 *
 * The gateway route, the metadata and the affinity key all ride on the *model's*
 * settings rather than on the provider's, and that is not a style choice:
 * `workers-ai-provider` resolves a gateway as `this.config.gateway ??
 * settings.gateway`, so a gateway set on the provider wins outright and the
 * model's `metadata` and `eventId` are discarded before the binding sees them,
 * silently.
 */
export function workersAIModel(
  env: AiEnv,
  options: WorkersAIModelOptions
): LanguageModel {
  return createWorkersAI({ binding: env.AI })(options.modelId, {
    gateway: {
      id: options.gatewayId,
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.eventId ? { eventId: options.eventId } : {})
    },
    ...(options.sessionAffinity
      ? { sessionAffinity: options.sessionAffinity }
      : {}),
    reasoning_effort: options.reasoningEffort
  });
}
