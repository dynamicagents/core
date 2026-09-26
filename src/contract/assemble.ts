import type { Action } from "@cloudflare/think";
import type { ToolSet } from "ai";
import type { ContextConfig } from "agents/context";
import {
  PLUGIN_CONTRACT_VERSION,
  type AgentPlugin,
  type PluginContext
} from "./plugin.js";

/**
 * Thrown when an agent's plugins and its deployment disagree — a contract
 * skew, a duplicate name, a missing binding, or two plugins claiming one tool.
 */
export class PluginSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSetupError";
  }
}

/** An agent's plugins, checked, with their contributions merged. */
export interface AssembledPlugins<Env> {
  readonly plugins: readonly AgentPlugin<Env>[];
  tools(ctx: PluginContext<Env>): ToolSet;
  actions(ctx: PluginContext<Env>): Record<string, Action>;
  context(): ContextConfig[];
  /**
   * Build every tool and action once, so a name offered twice fails the start
   * rather than the first turn. The names are only known once built, which
   * takes the installing agent's context; call it from `onStart`.
   *
   * Tools and actions share the model's one namespace, and `reserved` names
   * the rest of it — what the agent sets besides its plugins, by owner.
   */
  check(ctx: PluginContext<Env>, reserved?: ReadonlyMap<string, string>): void;
}

/**
 * Check an agent's plugins against this core and its deployment, once, at
 * start — never mid-request.
 */
export function assemblePlugins<Env>(
  plugins: readonly AgentPlugin<Env>[],
  env: Env
): AssembledPlugins<Env> {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw new PluginSetupError(
        `duplicate plugin "${plugin.name}" — two installed plugins claim the name`
      );
    }
    names.add(plugin.name);
    if (plugin.contractVersion !== PLUGIN_CONTRACT_VERSION) {
      throw new PluginSetupError(
        `plugin "${plugin.name}" was built against plugin contract v${plugin.contractVersion}, ` +
          `but this @dynamicagents/core speaks v${PLUGIN_CONTRACT_VERSION}. ` +
          "Upgrade whichever of the two is behind — they publish from separate repos, " +
          "so a release train can leave one lagging."
      );
    }
  }

  const bound = env as Record<string, unknown>;
  const missing = plugins.flatMap((plugin) =>
    [...(plugin.requires?.secrets ?? []), ...(plugin.requires?.bindings ?? [])]
      .filter((name) => {
        const value = bound[name];
        return value === undefined || value === null || value === "";
      })
      .map((name) => `${name} (required by "${plugin.name}")`)
  );
  if (missing.length > 0) {
    throw new PluginSetupError(
      `missing bindings or secrets: ${missing.join(", ")}. ` +
        "A plugin cannot add its own binding — declare these in wrangler.jsonc " +
        "(and `wrangler secret put` the secrets)."
    );
  }

  /** Two plugins offering one name is a wiring fault, not a preference. */
  const merge = <T>(
    kind: string,
    build: (plugin: AgentPlugin<Env>) => Record<string, T> | undefined
  ): Record<string, T> => {
    const merged: Record<string, T> = {};
    const owner = new Map<string, string>();
    for (const plugin of plugins) {
      for (const [name, value] of Object.entries(build(plugin) ?? {})) {
        const other = owner.get(name);
        if (other) {
          throw new PluginSetupError(
            `plugins "${other}" and "${plugin.name}" both offer the ${kind} "${name}"`
          );
        }
        owner.set(name, plugin.name);
        merged[name] = value;
      }
    }
    return merged;
  };

  const tools = (ctx: PluginContext<Env>) =>
    merge("tool", (p) => p.tools?.(ctx)) as ToolSet;
  const actions = (ctx: PluginContext<Env>) =>
    merge("action", (p) => p.actions?.(ctx));

  return {
    plugins,
    tools,
    actions,
    check: (ctx, reserved = new Map()) => {
      const owners = new Map(reserved);
      for (const plugin of plugins) {
        const names = [
          ...Object.keys(plugin.tools?.(ctx) ?? {}),
          // An action reaches the model under its own `name`, if it sets one.
          ...Object.entries(plugin.actions?.(ctx) ?? {}).map(
            ([key, action]) => action.config.name ?? key
          )
        ];
        for (const name of names) {
          const other = owners.get(name);
          if (other) {
            throw new PluginSetupError(
              `${other} and plugin "${plugin.name}" both offer the tool "${name}"`
            );
          }
          owners.set(name, `plugin "${plugin.name}"`);
        }
      }
    },
    context: () =>
      plugins.flatMap((plugin) =>
        (plugin.context ?? []).map(({ label, ...block }) => ({
          ...block,
          label: label ? `${plugin.name}.${label}` : plugin.name
        }))
      )
  };
}
