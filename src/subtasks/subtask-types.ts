import { z } from "zod";
import type {
  DelegationNames,
  ResolvedRecipe,
  SubtaskParams,
  SubtaskTypeSpec
} from "../contract/recipe.js";

/**
 * The **closed set of subtask types** the main agent may delegate, as the
 * runtime uses it: lookup, the delegate enum, param validation, and the
 * catalogue the delegating model is shown.
 *
 * The set is not declared here, and it is not a module constant: deriving the
 * enum, the delegate tool's description and the round contract at *import time*
 * makes the registry unoverridable, freezes it before `env` exists, and pulls
 * every domain's module into the bundle whether or not the agent uses it.
 *
 * So it is a factory. The host builds one registry per DO instance from its
 * installed plugins, and everything downstream reads that object.
 */

export type { DelegationNames, SubtaskParams, SubtaskTypeSpec };

/** A subtask whose params do not satisfy its type's contract. */
export class SubtaskParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtaskParamsError";
  }
}

export interface SubtaskTypeRegistry {
  /** Every known spec, in declaration order. */
  readonly specs: readonly SubtaskTypeSpec[];
  /** Every known type, keyed by its `key`. */
  readonly byKey: ReadonlyMap<string, SubtaskTypeSpec>;
  /** The type keys in declaration order. Empty when the agent delegates nothing. */
  readonly keys: readonly string[];
  /**
   * The keys as a non-empty tuple for `z.enum` in the delegate schema — the
   * model cannot emit anything outside it, so an unknown type never reaches the
   * data layer.
   *
   * Throws when no type is registered. Not a defensive check but the real
   * contract: an agent with no subtask types has nothing to delegate to, and
   * must not offer a delegate tool at all.
   */
  enumKeys(): [string, ...string[]];
  /** Look up a type, or null when it is not one we know. */
  spec(type: string): SubtaskTypeSpec | null;
  /**
   * Resolve a subtask type to the recipe it runs under. Throws
   * {@link SubtaskParamsError} for an unknown or retired type — the delegate
   * enum prevents the model from emitting one, so any unknown type reaching
   * execution is a configuration bug and should fail terminally.
   */
  resolveRecipe(type: string): ResolvedRecipe;
  /**
   * Validate a subtask's params against its type's contract, returning the
   * params to persist. A type with no schema must carry no params — a stray
   * param would otherwise ride along unread, looking meaningful.
   *
   * Shape only: whether an id names something the outside world actually offers
   * is a question for that world, answered when the work starts. Unknown keys
   * are stripped rather than refused — a model that invents one has produced a
   * valid subtask with noise attached, and the noise provably cannot reach the
   * execution.
   */
  validateParams(
    type: string,
    params: SubtaskParams | undefined
  ): SubtaskParams;
  /**
   * Every param key any type declares, as the optional properties of the single
   * flat `params` object the delegate tool advertises.
   *
   * Optional is not a weakening: which keys a given type *requires* is
   * {@link validateParams}'s call, and it still refuses a subtask whose type's
   * params are missing. What this adds is **visibility**. One tool schema has to
   * serve every type, so the only alternative to naming the union of keys here
   * is naming none of them — and a key the schema does not name is a key the
   * model has no legal way to send, whatever the description promises. A
   * free-form record names none; see
   * {@link file://./decomposition.ts makeSubtaskProposalSchema}.
   *
   * Descriptions are prefixed with the owning type, so a flat namespace still
   * reads unambiguously to the model (and a key two types share names both).
   */
  paramProperties(): Record<string, z.ZodType<string | undefined>>;
  /** The type catalogue as the delegating model is shown it. */
  renderTypes(): string;
  // No `renderCapabilities` here, deliberately. A type's
  // {@link SubtaskTypeSpec.capability} is rendered by
  // {@link file://../runtime/index.ts AgentRuntime.renderCapabilities}, together
  // with the plugin-level blocks and in plugin declaration order. A second
  // renderer over the same strings is not a convenience — it is a host that can
  // call both and make the main agent read every block twice.
  /** Every type's {@link SubtaskTypeSpec.delegationGuidance}, for the round contract. */
  renderDelegationGuidance(names: DelegationNames): string;
}

/**
 * Build the registry from the specs the installed plugins declared.
 *
 * Duplicate keys are refused rather than last-one-wins: two plugins claiming one
 * type is a misconfiguration whose symptom would otherwise be work silently
 * routed to the wrong domain.
 */
export function makeSubtaskTypes(
  specs: readonly SubtaskTypeSpec[]
): SubtaskTypeRegistry {
  const byKey = new Map<string, SubtaskTypeSpec>();
  for (const spec of specs) {
    if (byKey.has(spec.key)) {
      throw new Error(
        `duplicate subtask type "${spec.key}" — two plugins declare the same type`
      );
    }
    byKey.set(spec.key, spec);
  }
  const keys = specs.map((s) => s.key);
  const lookup = (type: string): SubtaskTypeSpec | null =>
    byKey.get(type) ?? null;

  return {
    specs,
    byKey,
    keys,

    enumKeys(): [string, ...string[]] {
      if (keys.length === 0) {
        throw new Error(
          "no subtask types are registered — an agent with no types cannot delegate, " +
            "so it must not build a delegate tool"
        );
      }
      return keys as [string, ...string[]];
    },

    spec: lookup,

    resolveRecipe(type: string): ResolvedRecipe {
      const found = lookup(type);
      if (!found) throw new SubtaskParamsError(`unknown subtask type: ${type}`);
      return found.recipe;
    },

    validateParams(
      type: string,
      params: SubtaskParams | undefined
    ): SubtaskParams {
      const found = lookup(type);
      if (!found) throw new SubtaskParamsError(`unknown subtask type: ${type}`);

      const supplied = params ?? {};
      if (!found.params) {
        const extra = Object.keys(supplied);
        if (extra.length > 0) {
          throw new SubtaskParamsError(
            `subtask type "${type}" takes no params, got: ${extra.join(", ")}`
          );
        }
        return {};
      }

      const parsed = found.params.safeParse(supplied);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new SubtaskParamsError(
          `subtask type "${type}" has invalid params — ${detail}`
        );
      }
      return parsed.data;
    },

    paramProperties(): Record<string, z.ZodType<string | undefined>> {
      const owners = new Map<string, string[]>();
      const declared = new Map<string, z.ZodType<string>>();
      for (const s of specs) {
        if (!s.params) continue;
        for (const [key, field] of Object.entries(s.params.shape)) {
          owners.set(key, [...(owners.get(key) ?? []), s.key]);
          declared.set(key, field);
        }
      }
      return Object.fromEntries(
        [...declared].map(([key, field]) => [
          key,
          // Described *after* `.optional()`, so the text sits on the schema this
          // returns rather than on the type it wraps — readable by both the JSON
          // Schema conversion and anything inspecting these properties directly.
          field
            .optional()
            .describe(
              `${owners.get(key)?.join("/")}: ${field.description ?? key}`
            )
        ])
      );
    },

    renderTypes(): string {
      return specs
        .map((s) => {
          const help = s.paramsHelp ? ` — ${s.paramsHelp}` : "";
          return `- \`${s.key}\`: ${s.description}${help}`;
        })
        .join("\n");
    },

    renderDelegationGuidance(names: DelegationNames): string {
      const sections: string[] = [];
      for (const s of specs) {
        if (s.delegationGuidance) sections.push(s.delegationGuidance(names));
      }
      return sections.join("\n\n");
    }
  };
}
