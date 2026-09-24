/**
 * Everything a plugin may need from its host, resolved once per Durable Object
 * instance.
 *
 * This is **contract, not application code**, which is why it lives in core. A
 * published plugin's config is written against this shape — `recall` takes
 * `callerKey` — so a plugin that could not name the type was writing its
 * signature against a structural guess at an interface declared in an app it
 * has never seen.
 *
 * Not just `env`, and each field is load-bearing:
 *
 * - `env` — bindings and secrets. Typed `object` for the same reason
 *   {@link file://../runtime/index.ts CreateAgentRuntimeOptions.env} is: `Env` is
 *   the ambient interface `wrangler types` generates into a consumer's
 *   `worker-configuration.d.ts`, it has no index signature, and requiring a cast
 *   to pass one's own `this.env` is how a seam goes unused. A host narrows it.
 * - `storage` — a plugin that owns tables needs the DO's storage to build a query
 *   handle over. `this.ctx.storage`.
 * - `callerKey` — **a thunk, deliberately.** It derives from the verified
 *   caller's identity, which does not exist yet when `plugins()` runs at DO
 *   start. The DO is keyed 1:1 by that caller, so the value is constant once
 *   known; a thunk is what lets the host supply it late while every hook reads
 *   the same one. On a subagent facet there is no caller at all, and the honest
 *   encoding is a thunk that throws.
 * - `aiGatewayId` — the **resolved** AI Gateway slug, so a plugin making its own
 *   model calls is correlated with the agent's. Resolved, not read off the
 *   overrides object: reaching into `MY_CONFIG.model?.aiGatewayId` at a call site
 *   silently yields `undefined` the moment that override is dropped in favour of
 *   core's baseline, and the plugin's calls quietly stop being correlated.
 *
 * Deliberately **not** here: the agent's model pair. See the note on the
 * interface below.
 */
export interface PluginHost<TEnv extends object = object> {
  env: TEnv;
  storage: DurableObjectStorage;
  /** The verified caller. A thunk — it does not exist when `onStart` runs. */
  callerKey: () => string;
  /** `config.model.aiGatewayId`, already resolved over core's baseline. */
  aiGatewayId: string;
  /**
   * `config.agentName`, for a plugin's own model calls to carry the same `agent`
   * key as the agent's. A correlation tag rather than a model, so it belongs here
   * for the same reason the note closing this interface gives for `aiGatewayId`.
   */
  agentName?: string;

  // No `primaryModelId` / `fallbackModelId`.
  //
  // They were here so a plugin could stamp the host's models onto a recipe it
  // declared — and every consumer did exactly that, producing a round trip that
  // could only ever return what it started with: host config → plugin options →
  // recipe → `validateRecipe` → host config. The one case where it *didn't*
  // round-trip was the bug, a recipe naming the host's fallback as its primary
  // and collapsing the pair.
  //
  // A plugin has no business knowing what its host is billed for. Every recipe
  // runs on the agent's configured pair; `ValidatedRecipe` carries it, and
  // nothing a plugin declares can influence it.
  //
  // `aiGatewayId` stays because it is not a model — it is the correlation slug a
  // plugin's *own* calls (an embedding, a classifier) must share with the
  // agent's so one AI Gateway log ties them together. Those are different jobs, on
  // deliberately different models, chosen by the plugin that owns the job.
}
