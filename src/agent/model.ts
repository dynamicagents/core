import type { LanguageModel } from "ai";
import type { ModelConfig } from "../config.js";
import type { GatewayLogFields } from "./gateway-log.js";

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
 * This file has no runtime imports at all, deliberately: a contract that ships
 * one implementation inline reads as *the* runtime with an escape hatch, rather
 * than as one of N.
 */

/**
 * `metadata` and `eventId` are what every call the pair makes tells AI Gateway
 * about itself. Build them with
 * {@link file://./gateway-log.ts gatewayLogFields} rather than by hand: the key
 * budget is enforced there.
 */
export interface ModelOverrides extends GatewayLogFields {
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
  /**
   * Routes every call this pair makes to the one model instance already holding
   * this conversation's prefix.
   *
   * Workers AI's prefix cache is per-instance and implicit — no breakpoints, no
   * TTL, 64-token blocks — so a repeated prefix hits only when routing happens
   * to land back on the right instance. Unsteered that was measured at about
   * half the time inside the eviction window and never past a five-minute gap,
   * and a miss is billed as fresh input at five times the cached rate.
   *
   * The key is a **continuous history**, not a unit of work. A task boundary is
   * not a prefix boundary: one Session spans every task a caller sends, so a new
   * task opens on the previous one's history and a per-task key would route it
   * away from its own prefix. A Durable Object's own name is the right grain,
   * because the object is keyed 1:1 with the history it holds.
   */
  sessionAffinity?: string;
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
 * `APICallError` carrying `isRetryable`.** A provider that rethrows its
 * transport's errors raw gets none of what follows, because nothing about a bare
 * `Error` says whether waiting would have helped.
 *
 * A failed call is offered to the **other slot** first — the two are different
 * models, and the second may have capacity the first does not. Only a pair that
 * both failed reaches {@link file://./inference.ts isTransientAiError}, which
 * reads the flag again to decide between retrying the whole round and giving up
 * on it. So the flag answers two different questions at two different levels,
 * and the same value answers both: see
 * {@link file://./fallback.ts withFallback} for the first and `isTransientAiError`
 * for the second.
 *
 * Everything else is deterministic, with one exception the loops have to be told
 * about separately: a refused credential is
 * {@link file://./errors.ts CredentialRejectedError}. Neither slot can clear it —
 * they sit behind one credential — so it is the one failure that is never offered
 * to the second.
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
