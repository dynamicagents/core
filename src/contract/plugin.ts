import type { Action, WorkspaceLike } from "@cloudflare/think";
import type { ToolSet } from "ai";
import type { ContextConfig } from "agents/context";

/**
 * The plugin contract — everything an independently packaged capability may
 * contribute to an agent, and the only thing core knows about one.
 *
 * Shaped like a Think extension manifest, in-process: tools, actions and
 * context blocks, under Think's own names. Nothing in core imports a plugin; a
 * plugin imports core and is installed by the agent, which is what keeps a
 * bundle proportional to what an agent installs.
 */

/**
 * The contract version a plugin was built against. Asserted when an agent
 * assembles its plugins, so a skew fails with a sentence naming the plugin and
 * both versions rather than a structural-type error several frames away.
 */
export const PLUGIN_CONTRACT_VERSION = 3;

/** What a plugin knows when it builds its tools and actions. */
export interface PluginContext<Env = Cloudflare.Env> {
  env: Env;
  /** The installing object's own storage. */
  storage: DurableObjectStorage;
  /** The installing object's name — a caller key, or a sub-agent run id. */
  agentName: string;
  /**
   * The verified caller this work is for. Constant for a parent (its object is
   * keyed by it); carried to a sub-agent with each dispatch.
   */
  callerKey(): string;
  /** The installing agent's Think workspace. */
  workspace(): WorkspaceLike;
  /**
   * In a sub-agent: what its spec's `prepare` returned for the running
   * dispatch. `undefined` in a parent. Read it inside `execute`, not while
   * building tools — it belongs to the turn.
   */
  runtime(): Record<string, unknown> | undefined;
}

/** A plugin's prompt block. `label` defaults to the plugin's name. */
export type PluginContextBlock = Omit<ContextConfig, "label"> & {
  label?: string;
};

/** Bindings and secrets a plugin needs the agent's `wrangler.jsonc` to provide. */
export interface PluginRequirements {
  /** Secret names, e.g. `["GITHUB_TOKEN"]`. */
  secrets?: readonly string[];
  /** Binding names, e.g. `["BROWSER"]`. */
  bindings?: readonly string[];
}

export interface AgentPlugin<Env = Cloudflare.Env> {
  /** Stable identifier, unique across an agent's plugins. */
  name: string;
  /**
   * The {@link PLUGIN_CONTRACT_VERSION} this plugin was built against. Set by
   * {@link definePlugin} from the constant it compiled against.
   */
  contractVersion: number;
  /**
   * The plugin's tools. Synchronous, because Think's `getTools()` is: a tool
   * whose shape depends on durable state reads it in `execute`.
   *
   * The same for a parent and a sub-agent. A plugin that describes a sub-agent
   * exports a `SubAgentSpec` as data, and the agent binds it to a class.
   */
  tools?(ctx: PluginContext<Env>): ToolSet;
  /**
   * Think actions: tools with an idempotency ledger, so a recovered turn never
   * repeats a side effect. See Think's `action()`.
   */
  actions?(ctx: PluginContext<Env>): Record<string, Action>;
  /**
   * What the model is told about this domain, as prompt blocks. Labels are
   * namespaced under the plugin's name.
   */
  context?: readonly PluginContextBlock[];
  /**
   * Checked when the agent assembles its plugins, so a missing binding fails
   * at start with a readable message instead of at the first tool call.
   */
  requires?: PluginRequirements;
}

/** Pins {@link AgentPlugin.contractVersion} to the core the plugin built against. */
export function definePlugin<Env = Cloudflare.Env>(
  plugin: Omit<AgentPlugin<Env>, "contractVersion"> & {
    contractVersion?: number;
  }
): AgentPlugin<Env> {
  return {
    ...plugin,
    contractVersion: plugin.contractVersion ?? PLUGIN_CONTRACT_VERSION
  };
}

/** See {@link restrictTools}. */
export interface RestrictToolsOptions {
  /**
   * The tool and action names kept. Names rather than a predicate, so the
   * install site says what the agent can do without opening the plugin.
   */
  allow: readonly string[];
  /**
   * What the model is told instead of the plugin's own blocks, which describe
   * its whole surface. Omit to say nothing, which is right for `allow: []`.
   */
  context?: readonly PluginContextBlock[];
}

/**
 * A plugin whose tools and actions are narrowed to `allow` — "my sub-agents
 * can run a shell, I cannot". Everything else passes through, `requires`
 * above all, so the binding is still checked at start.
 *
 * A name in `allow` the plugin does not offer is logged, not thrown: tools
 * are built per turn, so a throw lands inside a request someone is waiting on,
 * for what is always a typo.
 */
export function restrictTools<Env>(
  plugin: AgentPlugin<Env>,
  options: RestrictToolsOptions
): AgentPlugin<Env> {
  const allow = new Set(options.allow);
  const keep = <T>(all: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(all).filter(([name]) => allow.has(name)));

  const restricted: AgentPlugin<Env> = { ...plugin };
  const { tools, actions } = plugin;
  restricted.tools = (ctx) => {
    const all = tools?.(ctx) ?? {};
    const offered = new Set([
      ...Object.keys(all),
      ...Object.keys(actions?.(ctx) ?? {})
    ]);
    for (const name of allow) {
      if (!offered.has(name))
        console.error(
          `[plugin] "${plugin.name}" offers no tool or action "${name}" — ` +
            "the allowlist names something that does not exist. Check for a rename."
        );
    }
    return keep(all);
  };
  restricted.actions = (ctx) => keep(actions?.(ctx) ?? {});
  if (options.context === undefined) delete restricted.context;
  else restricted.context = options.context;
  return restricted;
}
