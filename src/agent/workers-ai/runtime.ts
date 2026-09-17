import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { ModelConfig } from "../../config.js";
import type { AiEnv } from "../../env.js";
import type { GatewayLogFields } from "../gateway-log.js";
import type {
  ModelOverrides,
  ModelPair,
  ModelRuntime,
  ModelRuntimeFactory
} from "../model.js";

/**
 * The Workers-AI model pair every loop runs on by default, built per agent
 * instance.
 *
 * The predecessor read `env.AI` and five config constants as module-level
 * imports. Neither survives packaging: `env` does not exist at module scope on
 * Workers, and a module constant cannot be overridden by a consumer. So this is
 * a factory over an injected binding and an injected {@link ModelConfig}.
 */

export interface WorkersAIRuntimeDeps {
  /** The `AI` binding. Read lazily — see {@link createWorkersAIModelRuntime}. */
  ai: Ai;
  config: ModelConfig;
}

/**
 * Build the Workers AI model runtime for one agent instance.
 *
 * The provider is constructed on first *use*, not here. During `wrangler deploy`
 * Cloudflare evaluates module scope to validate the new version, and bindings
 * are not populated at that point — constructing eagerly makes `createWorkersAI`
 * throw "you must provide either a binding or credentials". The same laziness
 * protects a consumer who builds their runtime early.
 */
export function createWorkersAIModelRuntime(
  deps: WorkersAIRuntimeDeps
): ModelRuntime {
  const { config } = deps;
  let provider: ReturnType<typeof createWorkersAI> | undefined;
  /**
   * No `gateway` here, and it must stay that way. `workers-ai-provider` resolves
   * a model's gateway as the provider's first and the model's second
   * (`this.config.gateway ?? settings.gateway`), so a gateway set on both is the
   * provider's alone: the model's `metadata` and `eventId` are discarded before
   * the binding sees them, and nothing fails. `chatSettings` is the only route.
   * `runtime.spec.ts` asserts the options the binding actually receives.
   */
  const workersai = () => (provider ??= createWorkersAI({ binding: deps.ai }));

  /**
   * Per-model Workers-AI settings: the AI Gateway route and what the call tells
   * it about itself, and the reasoning budget.
   *
   * Always returns a settings object, even with nothing to tell the gateway: the
   * route and `reasoning_effort` have to reach the binding on every call, and an
   * `undefined` return drops both.
   */
  const chatSettings = ({ metadata, eventId }: GatewayLogFields) => ({
    gateway: {
      id: config.aiGatewayId,
      ...(metadata ? { metadata } : {}),
      ...(eventId ? { eventId } : {})
    },
    reasoning_effort: config.reasoningEffort
  });

  return {
    createModelPair(overrides: ModelOverrides = {}): ModelPair {
      const primaryId = overrides.primaryModelId ?? config.chatModelId;
      const fallbackId =
        overrides.fallbackModelId ?? config.fallbackChatModelId;
      let primary: LanguageModel | undefined;
      let fallback: LanguageModel | undefined;
      const settings = chatSettings(overrides);
      return {
        primary: () =>
          (primary ??= overrides.model ?? workersai()(primaryId, settings)),
        fallback: () =>
          (fallback ??=
            overrides.fallbackModel ??
            overrides.model ??
            workersai()(fallbackId, settings)),
        primaryId: () => primaryId,
        fallbackId: () => fallbackId
      };
    }
  };
}

/**
 * Core's default provider — what every {@link ModelRuntimeFactory} seam lands on
 * when an agent does not override it.
 *
 * One definition rather than one per base class. The body used to be written
 * twice, once in {@link file://../../host/agent.ts DynamicAgent.modelRuntime}
 * and once in
 * {@link file://../../round/subagent.ts RecipeSubagentHost.modelRuntime}, which
 * is the same duplication the seam exists to let a *consumer* avoid.
 *
 * Typed on {@link AiEnv} rather than a caller's full `Env`: a factory that
 * accepts the narrow shape is callable with any env that satisfies it, so both
 * base classes pass `this.env` straight through.
 */
export const workersAIModels: ModelRuntimeFactory<AiEnv> = (env, config) =>
  createWorkersAIModelRuntime({ ai: env.AI, config });
