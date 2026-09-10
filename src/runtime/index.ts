import type { ToolSet } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  resolveConfig,
  type CoreConfig,
  type CoreConfigOverrides
} from "../config.js";
import {
  PLUGIN_CONTRACT_VERSION,
  type AgentPlugin,
  type EnrichResultContext,
  type MainAgentToolContext,
  type ResolveRuntimeContext,
  type ToolFamilyBuilder,
  type TurnGateContext
} from "../contract/plugin.js";
import type { PluginStore } from "../db/db.js";
import {
  memoryWorkspaceBacking,
  type WorkspaceBacking
} from "../subagent/workspace.js";
import type { RecipePolicy } from "../contract/validation.js";
import {
  makeSubtaskTypes,
  type SubtaskTypeRegistry
} from "../subtasks/subtask-types.js";
import type {
  RecipeExecutionResult,
  SubtaskRuntime
} from "../subtasks/types.js";
import { boundToolCalls } from "./bound-tools.js";
import { collectToolFamilies } from "./tool-families.js";

export { buildRecipeTools, collectToolFamilies } from "./tool-families.js";

/**
 * The agent runtime: everything that used to be a module-level constant,
 * resolved once per Durable Object instance from the host's config and its
 * installed plugins.
 *
 * This is the whole point of the package split. In the predecessor repo the
 * subtask registry was imported at module scope and every derived value — the
 * type map, the delegate tool's enum and description, the round contract, the
 * known-tool-family allowlist — was computed at *import time*. That made the
 * registry unoverridable, pulled every domain's module into every bundle, and
 * could not read `env`, which does not exist at module scope on Workers.
 *
 * Build it in `onStart`:
 *
 * ```ts
 * async onStart() {
 *   this.runtime = createAgentRuntime({
 *     config: { model: { chatModelId: "…" } },
 *     plugins: plugins(this.env)
 *   });
 * }
 * ```
 */
export interface AgentRuntime {
  config: CoreConfig;
  plugins: readonly AgentPlugin[];
  /** The installed subtask types — what `delegate` may name. */
  types: SubtaskTypeRegistry;
  /** Every tool family the installed plugins registered, by name. */
  toolFamilies: ReadonlyMap<string, ToolFamilyBuilder>;
  /** The capability boundary `validateRecipe` enforces. */
  policy: RecipePolicy;
  /** Plugin-owned stores, to hand to `new AgentDB(storage, { stores })`. */
  stores: readonly PluginStore[];
  /** Every binding and secret the installed plugins require of the host. */
  requirements: { secrets: string[]; bindings: string[] };
  /**
   * The subagent workspace backend — the one plugin that declared it, or an
   * in-memory fallback when none did. Always defined, so a host writes
   * `workspaceBacking: runtime.workspaceBacking` into its `SubagentRuntime`
   * unconditionally.
   */
  workspaceBacking: (
    sql: SqlStorage,
    name: () => string | undefined
  ) => WorkspaceBacking;

  /** The plugin that declared a subtask type, or null. */
  pluginForType(type: string): AgentPlugin | null;
  /**
   * Tools the installed plugins offer the *main* agent, merged, each bounded by
   * {@link boundToolCalls}. Pass the round's `signal` so a plugin can stop work a
   * cancel has made pointless.
   */
  mainAgentTools(ctx: MainAgentToolContext): Promise<ToolSet>;
  /**
   * The capability blocks for the main agent's soul, in plugin declaration
   * order: each plugin's own {@link AgentPlugin.capability} and the one on its
   * {@link AgentPlugin.subtaskType}, if it declares either. Returns `""` when
   * none does, so a call site can append unconditionally.
   */
  renderCapabilities(): string;
  /**
   * Ask every plugin declaring {@link AgentPlugin.shouldHandleTurn} whether this
   * turn should run. `true` when none declares one, and `false` if any single
   * gate declines.
   *
   * Never rejects: a gate that fails is logged against its plugin key and
   * counted as `true`, because the failure mode of a broken gate must be a noisy
   * agent, never a silent one.
   */
  shouldHandleTurn(ctx: TurnGateContext): Promise<boolean>;
  /**
   * Announce the messages a compaction is folding into a summary to every plugin
   * declaring {@link AgentPlugin.onMessagesDisplaced}. Pass it straight to
   * `buildAgentSession`'s option of the same name — it reads no `this`, so the
   * bare reference works.
   *
   * Never rejects: listeners are fanned out with `Promise.allSettled` and each
   * rejection is logged against the plugin key that caused it.
   */
  onMessagesDisplaced(messages: SessionMessage[]): Promise<void>;

  /**
   * Resolve the session state an execution needs, by asking the plugin that owns
   * its type. Returns `{}` for a type whose plugin declares no
   * `resolveRuntime` — most of them.
   */
  resolveRuntime(ctx: ResolveRuntimeContext): Promise<SubtaskRuntime>;
  /** Let the owning plugin amend a terminal result before it is persisted. */
  enrichResult(
    ctx: EnrichResultContext,
    result: RecipeExecutionResult
  ): Promise<RecipeExecutionResult>;
  /** Let the owning plugin release whatever `resolveRuntime` acquired. */
  onAbort(ctx: ResolveRuntimeContext): Promise<void>;
}

export interface CreateAgentRuntimeOptions {
  plugins: readonly AgentPlugin[];
  /**
   * Required, because {@link CoreConfigOverrides} requires a model pair and core
   * ships no default for it. Everything else in it stays optional.
   */
  config: CoreConfigOverrides;
  /**
   * Verify that every secret and binding the plugins declared is actually
   * present, given the Worker `env`. Off by default because core cannot know
   * which of a consumer's bindings are optional; pass `env` to switch it on.
   *
   * Typed `object`, not `Record<string, unknown>`, and that is not looseness.
   * `Env` is the ambient interface `wrangler types` generates into a consumer's
   * `worker-configuration.d.ts`; an interface has no index signature, so it does
   * not satisfy `Record<string, unknown>` and every consumer would have to cast
   * their own `this.env` to pass it. Requiring a cast to opt into a *check* is
   * how the check goes unused.
   */
  env?: object;
}

/**
 * Thrown when the installed plugins and the host disagree — a contract-version
 * skew, a duplicate key, or a missing binding. Always at DO start, never mid-request.
 */
export class RuntimeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSetupError";
  }
}

export function createAgentRuntime(
  options: CreateAgentRuntimeOptions
): AgentRuntime {
  const config = resolveConfig(options.config);
  const plugins = options.plugins;

  // --- contract + identity checks, all up front -----------------------------

  const byKey = new Map<string, AgentPlugin>();
  for (const plugin of plugins) {
    if (byKey.has(plugin.key)) {
      throw new RuntimeSetupError(
        `duplicate plugin key "${plugin.key}" — two installed plugins claim it`
      );
    }
    byKey.set(plugin.key, plugin);

    if (plugin.contractVersion !== PLUGIN_CONTRACT_VERSION) {
      throw new RuntimeSetupError(
        `plugin "${plugin.key}" was built against plugin contract v${plugin.contractVersion}, ` +
          `but this @dynamicagents/core speaks v${PLUGIN_CONTRACT_VERSION}. ` +
          "Upgrade whichever of the two is behind — they publish from separate repos, " +
          "so a version train can leave one lagging."
      );
    }
  }

  // --- what the plugins contribute ------------------------------------------

  const specs = plugins.flatMap((p) => (p.subtaskType ? [p.subtaskType] : []));
  const types = makeSubtaskTypes(specs);
  const toolFamilies = collectToolFamilies(plugins);

  const typeOwner = new Map<string, AgentPlugin>();
  for (const plugin of plugins) {
    if (plugin.subtaskType) typeOwner.set(plugin.subtaskType.key, plugin);
  }

  const stores = plugins.flatMap((p) => (p.store ? [p.store] : []));

  const displacementListeners = plugins.flatMap((p) =>
    p.onMessagesDisplaced
      ? [{ key: p.key, notify: p.onMessagesDisplaced.bind(p) }]
      : []
  );

  const turnGates = plugins.flatMap((p) =>
    p.shouldHandleTurn ? [{ key: p.key, gate: p.shouldHandleTurn.bind(p) }] : []
  );

  // At most one backend: two would mean two answers to "where did that file go".
  const backings = plugins.flatMap((p) =>
    p.workspaceBacking ? [{ key: p.key, make: p.workspaceBacking.bind(p) }] : []
  );
  if (backings.length > 1) {
    throw new RuntimeSetupError(
      `plugins ${backings.map((b) => `"${b.key}"`).join(" and ")} both declare a ` +
        "workspaceBacking — an execution has one workspace, so only one plugin may back it"
    );
  }
  const workspaceBacking = backings[0]?.make ?? memoryWorkspaceBacking;

  const secrets = [
    ...new Set(plugins.flatMap((p) => [...(p.requires?.secrets ?? [])]))
  ];
  const bindings = [
    ...new Set(plugins.flatMap((p) => [...(p.requires?.bindings ?? [])]))
  ];

  if (options.env) {
    const env = options.env as Record<string, unknown>;
    const missing: string[] = [];
    for (const plugin of plugins) {
      for (const name of [
        ...(plugin.requires?.secrets ?? []),
        ...(plugin.requires?.bindings ?? [])
      ]) {
        const value = env[name];
        if (value === undefined || value === null || value === "") {
          missing.push(`${name} (required by "${plugin.key}")`);
        }
      }
    }
    if (missing.length > 0) {
      throw new RuntimeSetupError(
        `missing bindings or secrets: ${missing.join(", ")}. ` +
          "A plugin cannot add its own wrangler binding — declare these in wrangler.jsonc " +
          "(and `wrangler secret put` the secrets)."
      );
    }
  }

  const policy: RecipePolicy = {
    primaryModelId: config.model.chatModelId,
    fallbackModelId: config.model.fallbackChatModelId,
    knownToolFamilies: new Set(toolFamilies.keys()),
    baselineLimits: config.subagentLimits
  };

  const pluginForType = (type: string): AgentPlugin | null =>
    typeOwner.get(type) ?? null;

  return {
    config,
    plugins,
    types,
    toolFamilies,
    policy,
    stores,
    requirements: { secrets, bindings },
    workspaceBacking,

    pluginForType,

    async mainAgentTools(ctx: MainAgentToolContext): Promise<ToolSet> {
      const tools: ToolSet = {};
      // Sequential rather than fanned out: this is a handful of plugins reading
      // one session, and merging in declaration order is what makes a name
      // collision resolve the same way on every call.
      for (const plugin of plugins) {
        if (plugin.mainAgentTools)
          Object.assign(tools, await plugin.mainAgentTools(ctx));
      }
      return boundToolCalls(tools);
    },

    renderCapabilities(): string {
      const blocks: string[] = [];
      for (const plugin of plugins) {
        // Both blocks a plugin may declare, emitted adjacently: a plugin that
        // declares a subtask type puts its capability on the *type*, and one
        // that only offers main-agent tools puts it on the plugin. Declaring
        // both is legal and means the model reads both.
        if (plugin.capability) blocks.push(plugin.capability);
        if (plugin.subtaskType?.capability)
          blocks.push(plugin.subtaskType.capability);
      }
      return blocks.join("\n\n");
    },

    async shouldHandleTurn(ctx: TurnGateContext): Promise<boolean> {
      if (turnGates.length === 0) return true;
      // Same `allSettled` + `async`-wrapped-callback discipline as
      // `onMessagesDisplaced` below, and for the same two reasons: every gate is
      // consulted even when one throws, and a gate that throws *synchronously*
      // (reading a binding before its first await) is caught rather than
      // escaping past the aggregation.
      //
      // A rejection resolves to `true`. That is not leniency — it is the only
      // safe default here. A wrong reply is noise the user sees and ignores; a
      // wrong silence is invisible to the person who needed an answer, so a
      // broken gate must degrade to "run the turn" and never to a mute agent.
      const results = await Promise.allSettled(
        turnGates.map(async (g) => g.gate(ctx))
      );
      return results.every((result, i) => {
        if (result.status === "rejected") {
          console.warn(
            `[runtime] plugin "${turnGates[i].key}" turn gate failed, handling the turn`,
            result.reason
          );
          return true;
        }
        return result.value;
      });
    },

    async onMessagesDisplaced(messages: SessionMessage[]): Promise<void> {
      // allSettled, not all: `all` rejects at the first listener to throw and
      // stops awaiting the rest, so every other plugin's write is still in
      // flight when this returns — and on a Durable Object the isolate can be
      // evicted before it lands. One plugin's outage would silently cost the
      // others their writes. Each rejection is logged against the key that
      // caused it; an anonymous aggregate is not debuggable across plugins.
      //
      // The `async` on the map callback is load-bearing, not style. A listener
      // is typed `(messages) => Promise<void>`, which does not oblige it to be
      // `async` — one that reads a binding before starting its async work can
      // throw *synchronously*, during this very `.map()`. Without the `async`
      // that throw escapes before `Promise.allSettled` exists to catch it: this
      // method rejects despite documenting that it never does, and `.map()`
      // aborts mid-iteration so every listener after the thrower is never even
      // invoked — strictly worse than the `Promise.all` failure mode above.
      const results = await Promise.allSettled(
        displacementListeners.map(async (l) => l.notify(messages))
      );
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          console.error(
            `[runtime] plugin "${displacementListeners[i].key}" failed on displaced messages`,
            result.reason
          );
        }
      });
    },

    async resolveRuntime(ctx: ResolveRuntimeContext): Promise<SubtaskRuntime> {
      const plugin = pluginForType(ctx.type);
      if (!plugin?.resolveRuntime) return {};
      return (await plugin.resolveRuntime(ctx)) as SubtaskRuntime;
    },

    async enrichResult(
      ctx: EnrichResultContext,
      result: RecipeExecutionResult
    ): Promise<RecipeExecutionResult> {
      const plugin = pluginForType(ctx.request.type);
      if (!plugin?.enrichResult) return result;
      return plugin.enrichResult(ctx, result);
    },

    async onAbort(ctx: ResolveRuntimeContext): Promise<void> {
      const plugin = pluginForType(ctx.type);
      if (plugin?.onAbort) await plugin.onAbort(ctx);
    }
  };
}
