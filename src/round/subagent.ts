import { createAgentRuntime } from "../runtime/index.js";
import type { AgentPlugin } from "../contract/plugin.js";
import type { CoreConfigOverrides, ModelConfig } from "../config.js";
import type { AiEnv } from "../env.js";
import type { ModelRuntime } from "../agent/model.js";
import { workersAIModels } from "../agent/workers-ai/index.js";
import { RecipeSubagentBase, type SubagentRuntime } from "../subagent/index.js";
import type { PluginHost } from "../host/plugin-host.js";

/**
 * The host half of a subagent facet: the same plugins as its parent, assembled
 * into the {@link SubagentRuntime} the base class executes recipes with.
 *
 * `RecipeSubagentBase` already ships the whole body — resumable chunks, the
 * terminal-result cache keyed by request fingerprint, workspace wiring,
 * cancellation, the fingerprint-mismatch contract. All that was ever missing is
 * this assembly, and a Durable Object class is constructed by the runtime, so it
 * cannot take constructor arguments. The two abstract methods are that seam.
 *
 * ## Why the facet builds its own runtime instead of asking its parent
 *
 * The obvious move is to read it off the parent, which already has one. It does
 * not work: the SDK reaches a parent through `this.parentAgent(Cls)`, which is an
 * **RPC stub**, and a `SubagentRuntime` is mostly functions — `models`, the
 * `toolFamilies` builder map, `workspaceBacking`. None of that survives
 * serialization, so the call would return a shape that type-checks and is inert.
 *
 * So each agent gets its own facet class over this base, building the same
 * runtime from the same `plugins.ts` its parent uses:
 *
 * ```ts
 * export class MySubagent extends RecipeSubagentHost<Env> {
 *   protected agentConfig() { return MY_CONFIG; }
 *   protected agentPlugins(host: PluginHost<Env>) { return plugins(host); }
 * }
 * ```
 *
 * It must be a **named, exported** class, not one produced by a factory: the
 * framework resolves a facet through `ctx.exports[this.constructor.name]`, so an
 * anonymous class breaks the lookup, and so does a bundler that minifies class
 * names.
 *
 * ## Not a bound Durable Object
 *
 * A facet is created beneath its calling agent, so it needs no wrangler binding
 * and no `new_sqlite_classes` entry — only an export from the Worker entry so
 * `ctx.exports` can resolve it. It *does* need a test-only binding, because the
 * Vitest pool only marks bound classes as DO classes.
 */
export abstract class RecipeSubagentHost<
  TEnv extends Cloudflare.Env & AiEnv = Cloudflare.Env & AiEnv
> extends RecipeSubagentBase<TEnv> {
  private _rt?: SubagentRuntime;

  /** This facet's agent config — the same object its parent DO passes. */
  protected abstract agentConfig(): CoreConfigOverrides;

  /** This facet's plugins — the same list its parent DO installs. */
  protected abstract agentPlugins(host: PluginHost<TEnv>): AgentPlugin[];

  /**
   * Built once per facet instance. The base calls this per RPC and documents
   * that an implementation building anything expensive should memoize its own.
   */
  protected subagentRuntime(): SubagentRuntime {
    return (this._rt ??= this.buildRuntime());
  }

  /**
   * Which provider this facet's chunks run on. Mirrors
   * {@link file://../host/agent.ts DynamicAgent.modelRuntime}, and **must be
   * overridden to match it** — a facet that keeps the Workers AI default while
   * its parent runs on another provider would silently execute every subtask on
   * a different model than the round that delegated it.
   *
   * The two seams take the same arguments precisely so that keeping them in step
   * needs no discipline: write the provider once as a
   * {@link file://../agent/model.ts ModelRuntimeFactory} and have both return
   * it. Two hand-copied runtime-construction bodies is what this shape exists to
   * stop, because nothing type-checks their agreement.
   *
   * Note the cheapest way to satisfy this is to override *neither* seam, which
   * is what an agent on core's default does.
   *
   * Takes the model config rather than reading `this.config`, because the facet
   * resolves its config inside `buildRuntime` and this is called from there.
   */
  protected modelRuntime(model: ModelConfig): ModelRuntime {
    return workersAIModels(this.env, model);
  }

  private buildRuntime(): SubagentRuntime {
    const config = this.agentConfig();
    const runtime = createAgentRuntime({
      config,
      plugins: this.agentPlugins({
        env: this.env,
        storage: this.ctx.storage,
        // No caller identity exists down here, and nothing reads one: the
        // per-caller hooks are the parent's surface, never a subagent's. A
        // throwing thunk is the honest encoding — it can only fire if a plugin
        // starts reading caller state on the execution path, which is a design
        // question, not a missing value.
        callerKey: () => {
          throw new Error(
            "a subagent execution has no caller identity — this plugin reads " +
              "per-caller state on a path where none exists"
          );
        },
        aiGatewayId: config.model?.aiGatewayId ?? ""
      }),
      env: this.env
    });

    return {
      policy: runtime.policy,
      types: runtime.types,
      models: this.modelRuntime(runtime.config.model),
      toolFamilies: runtime.toolFamilies,
      toolOutputWindow: runtime.config.toolOutputWindow,
      maxOutputTokens: runtime.config.model.maxOutputTokens,
      // Always defined: the plugin that declared a backend, or core's in-memory
      // fallback. So this needs no null check.
      workspaceBacking: runtime.workspaceBacking
    };
  }
}

/**
 * A **concrete** facet constructor, as `subAgent()` requires one.
 *
 * {@link RecipeSubagentHost} is abstract, and `subAgent()` rightly refuses an
 * abstract class — it is what constructs one. So the seam on the agent side is
 * typed as this: any named subclass below it.
 */
export type SubagentClass = new (
  ...args: ConstructorParameters<typeof RecipeSubagentBase>
) => RecipeSubagentBase;
