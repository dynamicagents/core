import type { ToolSet } from "ai";
import type {
  RecipeToolSet,
  ToolFamilyBuilder,
  ToolFamilyContext
} from "../contract/plugin.js";
import type { SubtaskRuntime } from "../subtasks/types.js";
import { boundToolCalls } from "./bound-tools.js";

/**
 * Assemble a recipe's toolset from the installed families.
 *
 * This replaces the predecessor's dispatcher, which was an `if / else if` chain
 * naming three families inline — including a domain one — inside otherwise
 * generic code, with static imports of that domain's modules at the top of the
 * file. That is the single edit that made every agent's bundle carry every
 * domain, and it is why this takes a map instead.
 *
 * A family a recipe names but no plugin registered is skipped rather than
 * throwing: `validateRecipe` already dropped unknown families, so reaching one
 * here means the policy and the registry disagreed, and a subagent that silently
 * runs with fewer tools degrades better than one that fails a whole branch. The
 * skipped names are returned so a caller can log them.
 *
 * Every tool comes back wrapped by {@link boundToolCalls}, so a family is held to
 * `MAX_TOOL_CALL_MS` whether or not its tools read a signal.
 */
export function buildRecipeTools<TRuntime = SubtaskRuntime>(
  families: readonly string[],
  registry: ReadonlyMap<string, ToolFamilyBuilder<TRuntime>>,
  ctx: ToolFamilyContext<TRuntime>
): RecipeToolSet<TRuntime> & { skipped: string[] } {
  const tools: ToolSet = {};
  const aborts: Array<(ctx: ToolFamilyContext<TRuntime>) => Promise<void>> = [];
  const skipped: string[] = [];

  for (const family of families) {
    const build = registry.get(family);
    if (!build) {
      skipped.push(family);
      continue;
    }
    const built = build(ctx);
    Object.assign(tools, built.tools);
    if (built.abort) aborts.push(built.abort);
  }

  const abort =
    aborts.length === 0
      ? undefined
      : async (c: ToolFamilyContext<TRuntime>) => {
          for (const run of aborts) await run(c);
        };

  return { tools: boundToolCalls(tools), abort, skipped };
}

/**
 * Collect every family builder the installed plugins registered, refusing
 * duplicates.
 *
 * Two plugins claiming one family name is a misconfiguration whose symptom would
 * otherwise be a subagent silently getting the wrong domain's tools — so it fails
 * at DO start, named, instead.
 */
export function collectToolFamilies<TRuntime = SubtaskRuntime>(
  plugins: readonly {
    key: string;
    toolFamilies?: Record<string, ToolFamilyBuilder<TRuntime>>;
  }[]
): Map<string, ToolFamilyBuilder<TRuntime>> {
  const registry = new Map<string, ToolFamilyBuilder<TRuntime>>();
  const owner = new Map<string, string>();
  for (const plugin of plugins) {
    for (const [family, build] of Object.entries(plugin.toolFamilies ?? {})) {
      const existing = owner.get(family);
      if (existing) {
        throw new Error(
          `tool family "${family}" is registered by both "${existing}" and "${plugin.key}"`
        );
      }
      owner.set(family, plugin.key);
      registry.set(family, build);
    }
  }
  return registry;
}
