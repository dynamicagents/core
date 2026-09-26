import type { AgentToolLifecycleResult } from "agents";
import type { FlexibleSchema } from "ai";
import type { PluginContext } from "./plugin.js";

/** What `prepare` is handed on the parent, before a run is dispatched. */
export interface SubAgentPrepareContext<I, Env> {
  input: I;
  taskId: string;
  runId: string;
  parent: PluginContext<Env>;
}

/**
 * What `settle` is handed on the parent, once a run reached its terminal — or
 * once its task closed before the run could start.
 */
export interface SubAgentSettleContext<Env = Cloudflare.Env> {
  runId: string;
  taskId: string;
  runtime: Record<string, unknown> | undefined;
  result: AgentToolLifecycleResult;
  parent: PluginContext<Env>;
}

/**
 * A sub-agent as data: what the parent's model is offered, and the hooks that
 * run around a dispatch. A plugin that owns a domain exports one; the agent
 * binds it to a `SubAgent` class from `/subagent`.
 */
export interface SubAgentSpec<I = unknown, Env = Cloudflare.Env> {
  /** The tool name the parent's model calls it by. */
  name: string;
  description: string;
  inputSchema: FlexibleSchema<I>;
  /** Who the sub-agent is. Rendered as its `soul` block. */
  soul: string;
  /**
   * Whether a run may outlive the parent's turn. A turn is cut after at most
   * fifteen minutes of wall time, and an awaited run in flight at the cut is
   * lost, so work that may run longer is dispatched **detached**: the call
   * returns at once, the task stays open, and the result arrives as a later
   * turn. How long a domain runs is the domain's to say.
   */
  detached?: boolean;
  /** The first message the sub-agent reads. Defaults to the input as JSON. */
  formatInput?(input: I): string;
  /**
   * Resolve what the run needs and no model can supply — a checkout, a lease.
   * Runs on the parent; the result is handed to the sub-agent's plugins as
   * `runtime()`, and to `settle`.
   */
  prepare?(
    context: SubAgentPrepareContext<I, Env>
  ): Promise<Record<string, unknown> | undefined>;
  /**
   * Release what `prepare` acquired. Runs on the parent once per run, on every
   * terminal: completed, failed and canceled alike. Best-effort.
   */
  settle?(context: SubAgentSettleContext<Env>): Promise<void>;
}
