import type { z } from "zod";
import type { AgentLimits } from "../config.js";

/**
 * What a recipe domain declares.
 *
 * These types flow **outward**: the runtime consumes them, and nothing in this
 * file imports from the runtime. That direction is the whole reason a plugin can
 * live in a separate package — a new domain is a new module plus one line in the
 * consuming agent's plugin list, with no edit inside core.
 *
 * Two shapes, and the distinction between them carries real weight:
 *
 * - A **type** ({@link SubtaskTypeSpec}) is the semantic contract of a unit of
 *   work: what it means, and what it must be given to be doable at all.
 * - A **Recipe** ({@link ResolvedRecipe}) is the execution *configuration* —
 *   models, soul, tool families, budgets. It declares no params, and one Recipe
 *   may serve several types.
 */

/** Params carried by a Subtask: model-chosen, string-valued, shape-checked. */
export type SubtaskParams = Record<string, string>;

/**
 * A type's param declaration, as a shape the agent can read back — not an opaque
 * validator. The keys have to be *enumerable* because the delegate tool's schema
 * is built from them: a param the model cannot see declared is a param it will
 * not send. See {@link SubtaskTypeSpec.params}.
 */
export type SubtaskParamsShape = Record<string, z.ZodType<string>>;
export type SubtaskParamsSchema = z.ZodObject<SubtaskParamsShape>;

/**
 * The control-tool names the agent injects when it renders a type's
 * {@link SubtaskTypeSpec.delegationGuidance}.
 *
 * Guidance legitimately names those tools ("ask the user with `final_reply`
 * rather than guessing"), and their names are the agent's to own. Injecting them
 * is what lets a domain write that sentence without importing from the runtime —
 * the direction this module depends on.
 */
export interface DelegationNames {
  delegateTool: string;
  finalReplyTool: string;
}

/**
 * The execution budget for one Recipe, enforced by the resumable runner (not the
 * Workflow). Exactly two fields, because there are exactly two things worth
 * bounding: what an execution **costs** and how long it can **run away for**. The
 * run ends on whichever it reaches first, and either way through the graceful
 * budget summary.
 *
 * Deliberately *not* here: how a run is sliced into durable chunks. That is a
 * Workers step-timeout constraint, it is identical for every Recipe, and it lives
 * in {@link file://../platform.ts}. A turn count cannot do that job — nothing
 * predicts how long a turn takes — so no per-chunk turn budget belongs on a
 * Recipe.
 *
 * Structurally identical to {@link AgentLimits} — a budget is a budget at both
 * levels, and keeping one shape means `resolveLimits` merges a recipe's
 * declaration straight over the host's baseline with no translation. Aliased
 * rather than redeclared so the two can never drift apart.
 */
export type RecipeLimits = AgentLimits;

/**
 * A Recipe configuration as a domain **declares** it, one per folder in
 * `recipes/<domain>/recipe.ts`; caller-local DB rows mapping into this shape are
 * deferred until a Recipe admin surface exists. Model ids, tool families, and
 * limits are code-validated downstream
 * ({@link file://./validation.ts validateRecipe}), which is also what turns this
 * into a {@link ValidatedRecipe}.
 *
 * One rule governs every field here, and it is worth stating once: **if
 * `config.ts` declares a baseline, a Recipe overrides it; if it does not, the
 * Recipe must supply it.** So `limits` is partial and merges, while `soul` and
 * `historyWindow` are required and a missing one is refused rather than filled in.
 */
export interface ResolvedRecipe {
  key: string;
  version: number;
  // A recipe states **no model**, and there is no field here to state one with.
  //
  // Which model an agent runs on is the agent's decision, made once in its
  // config. A recipe describes *what work is* — soul, tools, budget, context —
  // and a plugin shipping one has no idea what its consumer is billed for.
  //
  // {@link ValidatedRecipe} carries the resolved pair, because a runner needs
  // one. It comes from the host, always, with no way for recipe data to
  // influence it. See `validateRecipe` for what recipe-stated models cost when
  // they were briefly allowed.
  /** Required, never defaulted — see `validateRecipe`. */
  soul: string;
  toolFamilies: string[];
  enabled: boolean;
  /**
   * Only the budget fields this Recipe overrides; the rest come from the host's
   * `CoreConfig.subagentLimits`, which reaches validation as
   * `RecipePolicy.baselineLimits`. `{}` means "the baseline", which is what most
   * Recipes want.
   */
  limits: Partial<RecipeLimits>;
  /**
   * Most-recent turns kept verbatim in the rolling model context; older turns are
   * pruned. Required, and required *of the Recipe*: how much context a domain
   * needs is a property of the domain, so there is no house default to fall back
   * to and a missing one is a refused Recipe.
   */
  historyWindow: number;
  /** Append a runtime metrics footer (turns, model calls, wall-clock) to the final result. */
  reportMetrics: boolean;
}

/**
 * A Recipe that has been through {@link file://./validation.ts validateRecipe} —
 * limits merged over the baseline, models and tool families checked. The only
 * shape the runner ever consumes: a `Partial<RecipeLimits>` can never reach it.
 */
export interface ValidatedRecipe extends ResolvedRecipe {
  limits: RecipeLimits;
  /**
   * The pair this recipe will actually run on — **the host's, always**.
   *
   * These exist only here, never on {@link ResolvedRecipe}, and that asymmetry
   * is the design: a recipe cannot state a model, so the only way to hold one is
   * to have been through `validateRecipe`, which copies the host's. Recipe data
   * has no path to influence them.
   *
   * Guaranteed non-empty and guaranteed distinct, because `resolveConfig`
   * refuses a config that is either — so the fallback is always a genuinely
   * different model from the primary, which is the entire point of having one.
   */
  primaryModelId: string;
  fallbackModelId: string;
}

/**
 * One entry in the closed set of Subtask types the main agent may delegate,
 * declared by the domain that owns it and collected in
 * {@link file://./index.ts}.
 *
 * Two things follow from the set being closed rather than free prose:
 *
 * - The delegating model picks from an enum, so an invented type is rejected by
 *   the tool schema itself instead of silently falling back to a general recipe.
 * - A type can *require params*. A type that works on one named thing cannot be
 *   attempted without it, so a subtask that names none is refused up front
 *   rather than discovering it has nothing to work on several turns later.
 *
 * Params are the model's declared inputs — ids it chose, validated for shape and
 * resolved against durable rows at execution start. They are never the place for
 * anything the model cannot know: an API session pinned to one of those ids is
 * resolved by the parent from the id, never carried in the params.
 */
export interface SubtaskTypeSpec {
  key: string;
  /** One line shown to the delegating model so it picks the right type. */
  description: string;
  /**
   * Required params for this type, or null when it takes none. Kept to flat
   * strings: these are ids the model quotes from a tool result, not structures.
   *
   * A `z.object`, not an opaque `z.ZodType`, and that is load-bearing: the agent
   * reads `.shape` back to build the `params` field of the delegate tool's schema
   * (see `SubtaskTypeRegistry.paramProperties`). Declaring a param the model is
   * never shown is the failure this shape exists to prevent — describe each key
   * with `.describe()`, because that text is what the model reads.
   */
  params: SubtaskParamsSchema | null;
  /** How the model is told to obtain each param, appended to the description. */
  paramsHelp?: string;
  /**
   * What the main agent is told it can *do* with this domain, rendered into its
   * soul alongside the other capability blocks. Omit when the type needs no
   * introduction beyond {@link description}.
   *
   * These two prompt fields exist to hold one rule: **everything the main agent
   * is told about a domain is declared here, never written inside the runtime.**
   * Advice written in the runtime instead has to be repeated per call site, and
   * the copies drift — into telling the main agent two contradictory things
   * about the same domain, twice per round.
   */
  capability?: string;
  /**
   * How to construct a `delegate` payload for this type, rendered into the round
   * contract the main agent reads every round.
   *
   * A function because the text names the control tools, whose names belong to
   * the agent (see {@link DelegationNames}). Three rules, none of them enforced
   * beyond a test: it must open with its own `## ` heading, it must not restate
   * the params schema — the `delegate` tool description already renders that from
   * {@link params} — and it must stay short, because every round pays for it.
   */
  delegationGuidance?: (names: DelegationNames) => string;
  /** The execution configuration this type runs under. */
  recipe: ResolvedRecipe;
}
