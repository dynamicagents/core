import type { AgentManifest } from "../a2a/card.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import type { TaskAgent } from "../a2a/agent-stub.js";
import {
  ignoreAlreadyExists,
  workflowIdForMessage,
  type AcceptedTurn
} from "../a2a/executor.js";

/**
 * One agent's wiring, declared once.
 *
 * ## What this replaces
 *
 * Mounting an agent used to mean writing the same four things by hand and keeping
 * them in agreement: a `getAgent(identity)` that guards `identity.key` and reads a
 * Durable Object binding, a `startTurn` that derives an idempotent workflow id and
 * swallows the already-exists race, an entry in the `tenants` map, and — in the
 * agent's own Workflow entrypoint — a second reference to the same DO binding.
 *
 * Four copies of one fact, and only the first two were even adjacent. The wiring
 * also type-checked when it was **wrong**: naming a sibling's workflow binding on
 * a tenant compiles perfectly and fails at runtime, after auth, after the turn was
 * accepted, as a task that simply never calls back.
 *
 * ```ts
 * export const reactive = defineAgent({
 *   tenant: "reactive",
 *   manifest,
 *   agent: (env: Env) => env.ReactiveAgent,
 *   workflow: (env: Env) => env.HANDLE_TASK_WORKFLOW
 * });
 *
 * // the Worker entry
 * export default {
 *   fetch: createA2AWorker<Env>({ manifest: hostManifest, agents: [reactive] })
 * };
 *
 * // the agent's Workflow entrypoint. `return`, not a bare `await`: the platform
 * // records what `run()` returns as the instance's `output`, and that verdict is
 * // the only thing distinguishing a failed task from a successful one on a
 * // record where both are `complete` with every step `ok`.
 * return await runHandleTask(event.payload, step, {
 *   resolveAgent: (identity) => reactive.resolveAgent(this.env, identity),
 *   …
 * });
 * ```
 *
 * ## Why accessors rather than binding names
 *
 * `agent` and `workflow` are functions of `env`, not strings. A string would have
 * to be checked against `keyof Env` and then widened back to a namespace, which
 * loses the Durable Object's own class — so the Workflow could not see the very
 * methods it exists to drive. An accessor infers both: the tenant is mounted and
 * the Workflow is driven from one declaration, `env.RactiveAgent` is a compile
 * error, and `resolveAgent` comes back typed as the agent itself.
 *
 * `env` stays a parameter throughout, for the reason `src/env.ts` gives: core
 * never reaches for a consumer's ambient bindings, and on Workers `env` does not
 * exist at module scope anyway.
 */

/**
 * What `createA2AWorker` needs in order to mount an agent. The Durable Object's
 * own class is irrelevant to routing, so this shape forgets it —
 * {@link AgentDefinition} keeps it for the agent's Workflow.
 */
export interface MountedAgent<TEnv> {
  /** The tenant id a caller addresses this agent with. */
  tenant: string;
  /** The transport-independent half of this agent's card. */
  manifest: AgentManifest;
  resolveAgent(env: TEnv, identity: GatekeeperIdentity): TaskAgent;
  startTurn(env: TEnv, turn: AcceptedTurn): Promise<void>;
}

/**
 * {@link AgentDefinition} deliberately does **not** declare `extends
 * MountedAgent`, even though every one satisfies it.
 *
 * A generic `DurableObjectStub<TAgent>` cannot be proven assignable to
 * {@link TaskAgent} while `TAgent` is unresolved: the RPC stub type widens an
 * *optional* method (`listTasks?`) to `Promise<undefined> | (…) => …`, and
 * forcing the comparison also trips TypeScript's instantiation-depth limit — the
 * same wall that made `PlainTask` necessary. At a concrete call site, where
 * `TAgent` is a real agent class, the assignment resolves normally. So the check
 * happens where it can actually succeed: passing `agents: [reactive]` to
 * `createA2AWorker`.
 */

export interface DefineAgentOptions<
  TEnv,
  TAgent extends Rpc.DurableObjectBranded
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
  /** The Workflow this agent's turns run on. */
  workflow: (env: TEnv) => Workflow<AcceptedTurn>;
}

export interface AgentDefinition<
  TEnv,
  TAgent extends Rpc.DurableObjectBranded
> {
  /** The tenant id a caller addresses this agent with. */
  tenant: string;
  /** The transport-independent half of this agent's card. */
  manifest: AgentManifest;
  /**
   * Resolve the per-caller agent DO stub, keyed by the verified `identity.key`.
   *
   * Typed as the agent's **own** class, so the Workflow that drives its round
   * methods reaches them through the same declaration the tenant is mounted with
   * — the two cannot address different Durable Objects.
   *
   * Refuses a caller with no key rather than falling back to a shared instance:
   * that key is what makes one caller's tasks unreachable from another's, so a
   * missing one is a routing failure, not a default.
   */
  resolveAgent(
    env: TEnv,
    identity: GatekeeperIdentity
  ): DurableObjectStub<TAgent>;
  /**
   * Start this agent's durable turn, idempotently.
   *
   * The instance id is derived from the gatekeeper's `messageId`, which is stable
   * across dispatch retries — so a retry finding its instance already running is
   * the idempotency working, not a failure. {@link ignoreAlreadyExists} swallows
   * exactly that race and rethrows everything else.
   */
  startTurn(env: TEnv, turn: AcceptedTurn): Promise<void>;
}

export function defineAgent<TEnv, TAgent extends Rpc.DurableObjectBranded>(
  options: DefineAgentOptions<TEnv, TAgent>
): AgentDefinition<TEnv, TAgent> {
  return {
    tenant: options.tenant,
    manifest: options.manifest,

    resolveAgent(env, identity) {
      if (!identity.key) {
        throw new Error("identity.key is required to route to the agent DO");
      }
      const ns = options.agent(env);
      return ns.get(ns.idFromName(identity.key));
    },

    startTurn(env, turn) {
      return ignoreAlreadyExists(() =>
        options.workflow(env).create({
          id: workflowIdForMessage(turn.messageId),
          params: { ...turn }
        })
      );
    }
  };
}
