import type { AgentManifest } from "../a2a/card.js";
import type { VerifiedCaller } from "../a2a/caller-scope.js";
import type { TaskAgent } from "../a2a/agent-stub.js";

/**
 * One agent's wiring, declared once.
 *
 * ```ts
 * export const generic = defineAgent({
 *   tenant: "generic",
 *   manifest,
 *   agent: (env: Env) => env.Generic
 * });
 *
 * export default {
 *   fetch: createA2AWorker<Env>({ manifest: hostManifest, agents: [generic] })
 * };
 * ```
 *
 * `agent` is a function of `env` rather than a binding name: an accessor infers
 * the Durable Object's own class, so it is checked as an agent and
 * `env.Ractive` is a compile error. `env` stays a parameter because on Workers
 * it does not exist at module scope.
 */

/**
 * What `createA2AWorker` needs in order to mount an agent. The Durable Object's
 * own class is irrelevant to routing, so this shape forgets it.
 */
export interface MountedAgent<TEnv> {
  /** The tenant id a caller addresses this agent with. */
  tenant: string;
  /** The transport-independent half of this agent's card. */
  manifest: AgentManifest;
  resolveAgent(env: TEnv, caller: VerifiedCaller): TaskAgent;
}

export interface DefineAgentOptions<
  TEnv,
  TAgent extends TaskAgent & Rpc.DurableObjectBranded
> {
  /**
   * The tenant id a caller addresses this agent with, and what a gatekeeper
   * registers against. Renaming one is a re-registration, not a refactor.
   */
  tenant: string;
  /** The transport-independent half of this agent's card. */
  manifest: AgentManifest;
  /**
   * This agent's Durable Object namespace. One instance per verified caller: the
   * tenant picks the agent, and the caller's scope picks which instance of it.
   */
  agent: (env: TEnv) => DurableObjectNamespace<TAgent>;
}

/**
 * Mount an agent.
 *
 * The agent is checked against {@link TaskAgent} as a **class** (the
 * `TAgent` constraint), and its stub is then used as one. Comparing the stub
 * instead — `DurableObjectStub<TAgent>`, Cloudflare's RPC type mapping run over
 * every member a Think agent inherits — exceeds TypeScript's instantiation
 * depth. The class comparison is cheap and catches the same mistakes.
 *
 * `resolveAgent` names the instance by the caller's **scope**, which binds the
 * key the gatekeeper claimed to the origin that signed for it. That composition
 * is what makes one caller's tasks unreachable from another's, including from
 * another gatekeeper naming the same key, and
 * {@link file://../a2a/caller-scope.ts verifiedCaller} is where it is explained
 * and where a caller with no key is refused. The guard below is the floor under
 * a hand-built caller: a scope is a routing name, so an empty one is a failure
 * rather than a fallback to an instance two callers would share.
 */
export function defineAgent<
  TEnv,
  TAgent extends TaskAgent & Rpc.DurableObjectBranded
>(options: DefineAgentOptions<TEnv, TAgent>): MountedAgent<TEnv> {
  return {
    tenant: options.tenant,
    manifest: options.manifest,
    resolveAgent(env, caller) {
      if (!caller.scope) {
        throw new Error("caller.scope is required to route to the agent DO");
      }
      const ns = options.agent(env);
      return ns.get(ns.idFromName(caller.scope)) as unknown as TaskAgent;
    }
  };
}
