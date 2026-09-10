import type { LanguageModel } from "ai";
import type { ModelConfig } from "../config.js";

/**
 * The provider contract every loop runs against — and nothing that implements
 * it.
 *
 * {@link ModelRuntime} is the whole seam: an agent that returns one runs every
 * loop in core unchanged, because nothing downstream — the round loop, the
 * control-tool repair ladder, the Session's compaction, the Workflow — ever sees
 * more than a `LanguageModel` from `ai`. It never learns which provider produced
 * it.
 *
 * Core ships exactly one implementation —
 * {@link file://./workers-ai/index.ts `./workers-ai`} — as a sibling directory
 * under `agent/`. A second provider is a second directory exporting one
 * {@link ModelRuntimeFactory}, and nothing here has to change to admit it;
 * a consumer can equally supply one from outside the package, which is the
 * point of the seam.
 *
 * There was a `./anthropic` sibling until 0.8.0 — a hand-written Messages API
 * adapter behind an optional peer dependency. It was removed with the only
 * deployment that used it. Nothing about this contract changed when it went,
 * which is the strongest thing that can be said for the contract.
 *
 * Which is why this file has no runtime imports at all. The Workers AI factory
 * used to live in it, and a contract that ships one implementation inline reads
 * as *the* runtime with an escape hatch, rather than as one of N.
 */

/**
 * Custom metadata attached to the AI Gateway log for every call a pair makes.
 * AI Gateway's own `metadata` is otherwise `null`, so a model call can only be
 * tied back to its task by timestamp; stamping `{ taskId, round }` (a turn) or
 * `{ taskId, subtaskId }` (a chunk) makes correlation exact. Values are limited
 * to AI Gateway's accepted scalar set.
 */
export type AiGatewayMetadata = Record<string, number | string | boolean>;

export interface ModelOverrides {
  /** Test override for the primary slot. */
  model?: LanguageModel;
  /** Test override for the fallback slot. */
  fallbackModel?: LanguageModel;
  /**
   * The provider's model id for the primary slot. Defaults to the configured
   * `chatModelId`.
   *
   * The subagent path passes `ValidatedRecipe.primaryModelId`, which is the
   * host's own configured id — `validateRecipe` copies the pair on, and a recipe
   * has no field to name a model with. So this parameterizes the pair without
   * ever widening which models are reachable.
   */
  primaryModelId?: string;
  /** The provider's model id for the fallback slot. See {@link primaryModelId}. */
  fallbackModelId?: string;
  /** AI Gateway log metadata for correlation — see {@link AiGatewayMetadata}. */
  metadata?: AiGatewayMetadata;
}

/** The primary/fallback models (lazily memoized) plus their ids for logging. */
export interface ModelPair {
  primary: () => LanguageModel;
  fallback: () => LanguageModel;
  primaryId: () => string;
  fallbackId: () => string;
}

/**
 * ## What a provider owes the loops when a call fails
 *
 * One thing, and it is not optional: **a failure worth another attempt is an
 * `APICallError` carrying `isRetryable`.** That flag is read twice. The SDK
 * retries it on the same model first, honouring the provider's own
 * `retry-after`; whatever survives that reaches
 * {@link file://./inference.ts isTransientAiError}, which throws it out of the
 * attempt ladder so the Workflow step retries the round instead of spending the
 * fallback slot on it.
 *
 * Those answer different questions, and only one of them is the fallback's: a
 * `429` says "not yet", while the fallback answers "this model cannot" — and when
 * both slots sit behind one credential it cannot even answer that. A provider
 * that rethrows its transport's errors raw gets neither behaviour, because
 * nothing about a bare `Error` says which question it is answering, so core reads
 * it as deterministic and spends the fallback proving it.
 *
 * Everything else is deterministic, with one exception the loops have to be told
 * about separately: a refused credential is
 * {@link file://./errors.ts CredentialRejectedError}, which neither a retry nor a
 * fallback can clear.
 */
export interface ModelRuntime {
  /**
   * Lazily build + memoize a primary/fallback model pair (overridable in tests,
   * id-parameterized so a subagent can run the pair its validated recipe
   * carries). Nothing is checked here — the ids reaching this can only be the
   * host's own, which `resolveConfig` has already proven non-empty and distinct.
   */
  createModelPair(overrides?: ModelOverrides): ModelPair;
}

/**
 * How a provider is supplied to an agent: given the Worker env and the agent's
 * *resolved* model config, return a runtime.
 *
 * Both base-class seams — `DynamicAgent.modelRuntime` and
 * `RecipeSubagentHost.modelRuntime` — take this shape, which is the point of it.
 * A provider written as one of these is defined once and referenced from the
 * agent and its subagent facet, instead of being spelled out twice in two class
 * bodies that nothing keeps in step. See
 * {@link file://./workers-ai/runtime.ts workersAIModels} for core's own.
 *
 * Config arrives as an argument rather than being read off `this`: the facet
 * resolves its config inside `buildRuntime` and calls the seam from there, so
 * there is no `this.config` to read at that point — and a factory that cannot
 * reach for one cannot disagree with its caller about which AI Gateway the agent
 * is on.
 */
export type ModelRuntimeFactory<TEnv> = (
  env: TEnv,
  config: ModelConfig
) => ModelRuntime;
