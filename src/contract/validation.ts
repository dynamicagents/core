import type { AgentLimits } from "../config.js";
import type { ResolvedRecipe, ValidatedRecipe } from "./recipe.js";

/**
 * The capability boundary every recipe passes through, whatever declared it.
 *
 * This module imports no domain. It owns only what code must be able to say
 * about *any* recipe: which tool families it may select, which models it runs
 * on, and how a malformed one is made safe or refused. A domain cannot widen
 * its *capabilities* by declaring them — the legal tool families come from
 * {@link RecipePolicy}, which the host builds from its installed plugins, and
 * the model pair comes from the host's config with no declaration involved at
 * all. Its budget is the deliberate exception; see {@link resolveLimits}.
 *
 * The indirection exists to keep a domain key out of otherwise generic code: the
 * set of legal families is exactly the set the installed plugins registered,
 * never a module constant naming one.
 */
export interface RecipePolicy {
  /**
   * The pair every recipe runs on: the host agent's own, copied verbatim onto
   * each {@link ValidatedRecipe}.
   *
   * There is no allowlist, because there is nothing to check against it — a
   * recipe cannot state a model. One could only ever contain these same two
   * ids, so a recipe-stated preference could never reach a third model: it
   * could only swap the primary for the fallback, which is not a capability
   * anyone wants and which breaks the pair's distinctness.
   */
  primaryModelId: string;
  /** See {@link primaryModelId}. Guaranteed distinct from it by `resolveConfig`. */
  fallbackModelId: string;
  /**
   * Tool-family keys the runtime recognizes — derived from the installed
   * plugins, never hardcoded.
   *
   * A main-agent-only tool is never a valid family — the Session's
   * `set_context`, or anything a plugin offers only through `mainAgentTools`
   * (an episodic-memory search, say). A subagent has no Session or durable
   * memory to reach, and such a tool's absence from every plugin's
   * `toolFamilies` makes it structurally impossible to enable through recipe
   * data.
   */
  knownToolFamilies: ReadonlySet<string>;
  /** The baseline a recipe's declared `limits` merge over. */
  baselineLimits: AgentLimits;
}

/**
 * Merge a recipe's declared budget over the baseline, per field. A positive
 * integer wins; anything else — missing, null, zero, fractional — falls back to
 * the baseline rather than reaching the runner.
 *
 * The baseline is a default, not a ceiling: a recipe may declare a budget larger
 * than the baseline and it is honored — sizing its own branch is what declaring
 * `limits` is for, so nothing here clamps. What the merge buys, as
 * defense-in-depth for a recipe that ever comes from data rather than code, is
 * that a corrupt or absent value cannot reach the runner as a zero, fractional,
 * or missing budget.
 *
 * Exported separately from {@link validateRecipe} because it must never throw.
 */
export function resolveLimits(
  limits: Partial<AgentLimits>,
  baseline: AgentLimits
): AgentLimits {
  const positiveInt = (n: number | undefined, fallback: number): number =>
    typeof n === "number" && Number.isInteger(n) && n > 0 ? n : fallback;
  return {
    maxTurns: positiveInt(limits?.maxTurns, baseline.maxTurns),
    maxWallMs: positiveInt(limits?.maxWallMs, baseline.maxWallMs)
  };
}

/**
 * Thrown by {@link validateRecipe} for a recipe that is unusable as given — it
 * is disabled, carries no soul, or states no history window. All are
 * deterministic caller bugs (the parent must only hand enabled, complete recipes
 * to a subagent), so the child maps this to a terminal failed result rather than
 * retrying.
 */
export class RecipeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeValidationError";
  }
}

/**
 * Code-owned defensive validation of an already-resolved recipe. Returns a
 * normalized copy (never mutates the input): the host's model pair is stamped
 * on, and unknown tool families are dropped (deduped, order-preserving).
 * Applied by the parent when it resolves a recipe and re-applied by the subagent
 * on its inbound request, so recipe data can never select arbitrary models or
 * tools — models because there is no field to select one with, tools because
 * the legal set comes from the installed plugins rather than the declaration.
 *
 * The split between what is normalized and what is refused follows one rule:
 * **the host declares a baseline ⇒ merge; it does not ⇒ require.** `limits`
 * merge. A soul and a `historyWindow` do not: substituting a generic soul would
 * run the work under an identity nobody declared — the model would answer,
 * plausibly, as something other than what the recipe is for — and how much
 * context a domain needs is likewise a property of the domain, not something a
 * house default can guess. Both fail the recipe outright.
 */
export function validateRecipe(
  recipe: ResolvedRecipe,
  policy: RecipePolicy
): ValidatedRecipe {
  if (!recipe.enabled) {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) is disabled`
    );
  }
  if (recipe.soul.trim() === "") {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) has no soul`
    );
  }
  if (!Number.isInteger(recipe.historyWindow) || recipe.historyWindow <= 0) {
    throw new RecipeValidationError(
      `recipe "${recipe.key}" (v${recipe.version}) has no usable historyWindow ` +
        `(got ${recipe.historyWindow}); every recipe states its own`
    );
  }
  const toolFamilies = [...new Set(recipe.toolFamilies)].filter((family) =>
    policy.knownToolFamilies.has(family)
  );
  return {
    ...recipe,
    // The host's pair, copied. Not selected, not substituted, not merged —
    // there is nothing on a `ResolvedRecipe` to select *from*.
    //
    // Substituting a recipe's stated preference against an allowlist, per slot
    // and independently, is what makes that unsafe: a recipe preferring the
    // host's *fallback* as its primary, and stating no fallback of its own,
    // resolves to the same id in both slots — so the fallback retries the model
    // that has just failed, defeating the distinct-pair invariant
    // `resolveConfig` enforces one layer up.
    //
    // Copying wholesale makes that unrepresentable: the pair here is exactly the
    // pair the agent configured, which `resolveConfig` has already guaranteed is
    // non-empty and distinct.
    primaryModelId: policy.primaryModelId,
    fallbackModelId: policy.fallbackModelId,
    toolFamilies,
    limits: resolveLimits(recipe.limits, policy.baselineLimits)
  };
}
