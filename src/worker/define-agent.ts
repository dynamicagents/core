import type { AgentManifest } from "../a2a/card.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import type { TaskAgent } from "../a2a/agent-stub.js";

/**
 * One agent's wiring, declared once.
 *
 * ```ts
 * export const reactive = defineAgent({
 *   tenant: "reactive",
 *   manifest,
 *   agent: (env: Env) => env.Reactive
 * });
 *
 * export default {
 *   fetch: createA2AWorker<Env>({ manifest: hostManifest, agents: [reactive] })
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
  resolveAgent(env: TEnv, identity: GatekeeperIdentity): TaskAgent;
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
   * This agent's Durable Object namespace. One instance per verified caller —
   * the tenant picks the agent, `identity.key` picks which instance of it.
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
 * `resolveAgent` refuses a caller with no key rather than falling back to a
 * shared instance: the key is what makes one caller's tasks unreachable from
 * another's, so a missing one is a routing failure, not a default.
 */
export function defineAgent<
  TEnv,
  TAgent extends TaskAgent & Rpc.DurableObjectBranded
>(options: DefineAgentOptions<TEnv, TAgent>): MountedAgent<TEnv> {
  return {
    tenant: options.tenant,
    manifest: options.manifest,
    resolveAgent(env, identity) {
      if (!identity.key) {
        throw new Error("identity.key is required to route to the agent DO");
      }
      const ns = options.agent(env);
      return ns.get(ns.idFromName(identity.key)) as unknown as TaskAgent;
    }
  };
}
