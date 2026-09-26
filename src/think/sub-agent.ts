import { Think, type ThinkModel, type WorkspaceLike } from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import type {
  AgentToolFailure,
  AgentToolLifecycleResult,
  ChatCapableAgentClass
} from "agents";
import {
  tool,
  type FlexibleSchema,
  type Tool,
  type ToolSet,
  type UIMessage
} from "ai";
import type { AgentPlugin, PluginContext } from "../contract/plugin.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/index.js";

/**
 * A sub-agent: its own Durable Object, its own messages, its own recovery.
 *
 * The parent holds a work row and nothing else. What it delegates is a job, not
 * a continuation — a sub-agent reads none of the parent's history — and how it
 * reports back is the one decision the spec makes:
 *
 *  - **awaited** — the default. The parent's tool call waits for the result and
 *    the model reads it in the same turn. It must finish inside the parent's
 *    turn, which the platform interrupts after about fifteen minutes.
 *  - **detached** — for work that may run longer than that. The dispatch returns
 *    at once, the parent's turn ends, and the A2A task stays `working` because
 *    the work row says it has open work. The result arrives as a follow-up turn
 *    the run's own `onFinish` submits.
 *
 * There is nothing in between, and the reason is the fifteen minutes: a run that
 * might cross it and is awaited anyway is lost at the boundary, its tool part
 * repaired to an error, while the child goes on working orphaned.
 */

/** What a sub-agent is, from the parent's side. */
export interface SubAgentSpec<Input = unknown> {
  /** The tool name the model calls. */
  name: string;
  /** What the model is told the sub-agent is for. */
  description: string;
  inputSchema: FlexibleSchema<Input>;
  /** What the sub-agent is told it is. Its whole system prompt. */
  soul: string;
  /**
   * Dispatch this sub-agent detached, because it may run past the parent turn's
   * fifteen minutes. See the class comment.
   */
  detached?: boolean;
  /**
   * The dispatch envelope as the sub-agent's model reads it. Defaults to the
   * JSON of the input, which is right for a structured job and wrong for one
   * whose whole content is a sentence.
   */
  formatInput?(input: Input): string;
  /**
   * Resolve the state this run needs and no model can supply — a leased
   * resource, a session handle, a checkout. Runs on the **parent**, before the
   * dispatch, and what it returns rides to the sub-agent as `runtime` on its
   * plugin context.
   */
  prepare?(ctx: {
    input: Input;
    taskId: string;
    runId: string;
    parent: PluginContext;
  }): Promise<Record<string, unknown>>;
  /**
   * The run reached a terminal outcome — release whatever {@link prepare}
   * acquired. Fires once for every outcome, completed and aborted alike, on the
   * parent.
   */
  settle?(ctx: {
    runId: string;
    runtime?: Record<string, unknown>;
    result: AgentToolLifecycleResult;
  }): Promise<void>;
}

/** What {@link subAgentTool} needs of the agent dispatching it. */
export interface SubAgentHost {
  /** The task this turn belongs to, or `undefined` outside one. */
  turnTaskId(): string | undefined;
  /** What a plugin's `prepare` is handed. */
  pluginContext(): PluginContext;
  /** Record the run before dispatching it — see {@link subAgentTool}. */
  addWork(
    workId: string,
    taskId: string,
    kind: "awaited" | "detached",
    name: string
  ): void;
  /** Close a run whose dispatch was refused, so it holds no task open. */
  closeWork(workId: string): boolean;
  /** Remember what `prepare` resolved, so `settle` can be handed it. */
  rememberRuntime(runId: string, runtime: Record<string, unknown>): void;
  runAgentTool: Think["runAgentTool"];
}

/** A `SubAgent` subclass, as `runAgentTool` takes it. */
export type SubAgentClass = ChatCapableAgentClass & {
  spec: SubAgentSpec<never>;
};

/**
 * The tool that dispatches one sub-agent.
 *
 * The work row is written **before** the dispatch, and the order matters: a
 * crash between the two leaves an open row with no run, which the gatekeeper's
 * hour closes, while the other order leaves a run nothing is waiting for and a
 * task that settles early.
 *
 * No `maxBudgetMs` and no `noProgressBudgetMs`: the gatekeeper cancels any task
 * that has not settled within the hour, and a second, shorter deadline
 * underneath it would only ever fire on work that was still healthy.
 */
export function subAgentTool(host: SubAgentHost, Cls: SubAgentClass): Tool {
  const spec = Cls.spec;
  return tool({
    description: spec.detached
      ? `${spec.description}\n\nThis runs in the background: it does not answer ` +
        "here. Say what you started, and stop — the result arrives in a later turn."
      : spec.description,
    inputSchema: spec.inputSchema as FlexibleSchema<unknown>,
    execute: async (input, { toolCallId, abortSignal }) => {
      const taskId = host.turnTaskId();
      if (!taskId) {
        throw new Error(
          `${spec.name} ran outside a task's turn: a tool that records work has ` +
            "to run inside a turn submitted with `metadata.turnMetadata.taskId`"
        );
      }
      const runId = `agent-tool:${toolCallId}`;
      const runtime = await spec.prepare?.({
        input: input as never,
        taskId,
        runId,
        parent: host.pluginContext()
      });
      if (runtime) host.rememberRuntime(runId, runtime);

      const envelope = { input, taskId, runtime };
      if (!spec.detached) {
        host.addWork(runId, taskId, "awaited", spec.name);
        const result = await host.runAgentTool(Cls, {
          input: envelope,
          runId,
          parentToolCallId: toolCallId,
          signal: abortSignal
        });
        return outcome(result);
      }

      host.addWork(runId, taskId, "detached", spec.name);
      const dispatch = await host.runAgentTool(Cls, {
        input: envelope,
        runId,
        parentToolCallId: toolCallId,
        // No `signal`: a detached run outlives the turn that started it, and
        // inheriting the turn's abort would kill it the moment the turn ends.
        detached: { onFinish: "onSubAgentFinish" }
      });
      if (dispatch.status !== "running") {
        // A synchronous rejection wires no `onFinish`, so nothing would ever
        // close this row and the task would stay `working` for ever.
        host.closeWork(runId);
        return {
          ok: false as const,
          error: dispatch.error ?? `${spec.name} did not start`
        };
      }
      return { started: runId };
    }
  });
}

/**
 * What the model reads for an awaited run: the summary, or a failure it can act
 * on.
 *
 * The same envelope `agentTool` produces, because a sub-agent that fails should
 * read the same to the model whichever tool dispatched it — `retryable` in
 * particular is the difference between "try again" and "this will not work".
 */
function outcome(result: {
  status: string;
  summary?: string;
  error?: string;
  reason?: AgentToolFailure["reason"];
  childStillRunning?: boolean;
}): string | AgentToolFailure {
  if (result.status === "completed") return result.summary ?? "";
  if (result.status === "aborted") {
    return {
      ok: false,
      status: "aborted",
      error: result.error ?? "the sub-agent run was cancelled",
      retryable: false
    };
  }
  if (result.status === "interrupted") {
    return {
      ok: false,
      status: "interrupted",
      error:
        result.error ??
        "the sub-agent run was interrupted before it finished; it can be retried",
      retryable: true,
      reason: result.reason,
      childStillRunning: result.childStillRunning
    };
  }
  return {
    ok: false,
    status: "error",
    error: result.error ?? "the sub-agent run failed",
    retryable: false
  };
}

/** What a dispatch carries to the sub-agent, and what it reads back off it. */
interface SubAgentInput {
  input: unknown;
  taskId: string;
  runtime?: Record<string, unknown>;
}

/**
 * The sub-agent base class. One subclass per sub-agent, naming its spec and its
 * plugins.
 *
 * It knows nothing about A2A: the task lifecycle is the parent's, and what
 * crosses back is a summary, a failure, and whatever milestones it reported on
 * the way.
 */
export abstract class SubAgent<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends Think<Env> {
  /** What this sub-agent is, and how the parent dispatches it. */
  static spec: SubAgentSpec<never>;

  /**
   * No step, turn or recovery budget. The gatekeeper cancels any task that has
   * not settled within the hour, and that is the only bound this design wants —
   * a second one underneath it can only ever cut short work that was healthy.
   */
  maxSteps = Infinity;
  chatRecovery = { maxRecoveryWork: Infinity };
  contextOverflow = { reactive: true };

  /** Built in `onStart`, from {@link getPlugins}. */
  protected plugins!: AgentRuntime<Env>;

  /** The model this sub-agent runs on. One model; there is no fallback. */
  abstract override getModel(): ThinkModel;

  /** The capabilities this sub-agent installs. */
  getPlugins(): AgentPlugin<Env>[] {
    return [];
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    this.plugins = createAgentRuntime<Env>({
      plugins: this.getPlugins(),
      env: this.env
    });
    const workspace = this.plugins.workspace(this.pluginContext());
    if (workspace) this.workspace = workspace;
  }

  override getSystemPrompt(): string {
    return this.spec().soul;
  }

  override configureContext(): ContextConfig[] {
    return this.plugins.context();
  }

  override getTools(): ToolSet {
    return this.plugins.tools(this.pluginContext());
  }

  override getActions() {
    return this.plugins.actions(this.pluginContext());
  }

  /**
   * The dispatch envelope as the model reads it.
   *
   * Overridden because the default stringifies the whole envelope, `runtime` and
   * all — and `runtime` is the half no model should be reading: it is what the
   * parent resolved precisely because no model could supply it.
   */
  protected override formatAgentToolInput(input: unknown): UIMessage {
    const envelope = input as SubAgentInput;
    const spec = this.spec();
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text:
            spec.formatInput?.(envelope.input as never) ??
            JSON.stringify(envelope.input)
        }
      ],
      metadata: {
        turnMetadata: {
          taskId: envelope.taskId,
          runtime: envelope.runtime
        }
      }
    };
  }

  /**
   * Say something on the parent's transcript, mid-run.
   *
   * `persist: true` is what makes it survive: the parent's `onProgress` is
   * best-effort and is not replayed after an eviction, so the persisted
   * milestone is the copy the parent replays when the run finishes. The key is
   * what the transcript dedupes on, so it must be derived from position.
   */
  protected async note(key: string, text: string): Promise<void> {
    await this.reportProgress(
      { milestone: "note", message: text, data: { key, text } },
      { persist: true }
    );
  }

  protected pluginContext(): PluginContext<Env> {
    return {
      env: this.env,
      storage: this.ctx.storage,
      agentName: this.name,
      callerKey: () => this.name,
      workspace: (): WorkspaceLike => this.workspace,
      runtime: () => {
        const metadata = this.activeTurnMetadata as
          | { runtime?: Record<string, unknown> }
          | undefined;
        return metadata?.runtime;
      }
    };
  }

  /** This subclass's own spec, off the constructor rather than the instance. */
  protected spec(): SubAgentSpec<never> {
    return (this.constructor as typeof SubAgent).spec;
  }
}
