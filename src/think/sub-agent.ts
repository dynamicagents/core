import {
  Think,
  defaultContextOverflowClassifier,
  type ThinkModel,
  type ThinkSession
} from "@cloudflare/think";
import type { AgentToolLifecycleResult } from "agents";
import type { ContextConfig } from "agents/context";
import { createCompactFunction } from "agents/sessions";
import {
  generateText,
  type FlexibleSchema,
  type LanguageModel,
  type ToolSet,
  type UIMessage
} from "ai";
import type { AgentPlugin, PluginContext } from "../contract/plugin.js";
import {
  assemblePlugins,
  type AssembledPlugins
} from "../contract/assemble.js";
import type { Action } from "@cloudflare/think";

/**
 * A sub-agent: its own Durable Object facet with its own messages, recovery and
 * resumable stream, dispatched by an `A2AAgent` through `runAgentTool`. Nothing
 * here knows about A2A — the task is the parent's.
 */

/** What `prepare` is handed on the parent, before a run is dispatched. */
export interface SubAgentPrepareContext<I, Env> {
  input: I;
  taskId: string;
  runId: string;
  parent: PluginContext<Env>;
}

/** What `settle` is handed on the parent, once a run reached its terminal. */
export interface SubAgentSettleContext {
  runId: string;
  taskId: string;
  runtime: Record<string, unknown> | undefined;
  result: AgentToolLifecycleResult;
}

/**
 * A sub-agent as data: what the parent's model is offered, and the hooks that
 * run around a dispatch. A plugin that owns a domain exports one; the agent
 * binds it to a {@link SubAgent} class.
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
  settle?(context: SubAgentSettleContext): Promise<void>;
}

/** What a dispatch carries to the child. Strings and JSON: it crosses RPC. */
export interface SubAgentEnvelope {
  input: unknown;
  taskId: string;
  callerKey: string;
  runtime?: Record<string, unknown>;
}

/**
 * A concrete sub-agent class, as a parent names it. The constructor shape is
 * agents' own `DynamicAgentClass`, which is what `runAgentTool` takes.
 */
export type SubAgentClass = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the child's Env is not the parent's to know
  new (ctx: DurableObjectState, env: never): SubAgent<any>;
  spec: SubAgentSpec<never, never>;
};

/** The milestone a note travels under, from child to parent. */
export const NOTE_MILESTONE = "note";

/** A note's payload: its dedupe key and its text, both persisted. */
export interface NoteData {
  key: string;
  text: string;
}

export abstract class SubAgent<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends Think<Env> {
  /** Set on every concrete class: `static override spec = MY_SPEC`. */
  static spec: SubAgentSpec<never, never>;

  override maxSteps = Infinity;
  override chatRecovery = { maxRecoveryWork: Infinity };
  override contextOverflow = { reactive: true };

  /**
   * Compaction for a sub-agent is opt-in: most runs are short, and one whose
   * model is not a chat model (a Claude Code session) has nothing to summarize
   * with. Set both to compact, which also arms the overflow recovery.
   */
  protected readonly compactAfterTokens?: number;
  protected readonly keepRecentTokens?: number;

  abstract override getModel(): ThinkModel;

  /** This sub-agent's plugins. Default: none. */
  getPlugins(): AgentPlugin<Env>[] {
    return [];
  }

  #plugins?: AssembledPlugins<Env>;
  #buffered = "";
  #flushed = false;

  protected get plugins(): AssembledPlugins<Env> {
    return (this.#plugins ??= assemblePlugins(this.getPlugins(), this.env));
  }

  override classifyChatError(error: unknown) {
    return defaultContextOverflowClassifier(error);
  }

  override configureSession(session: ThinkSession): ThinkSession {
    if (
      this.compactAfterTokens === undefined ||
      this.keepRecentTokens === undefined
    )
      return session;
    return session
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.compactionModel(), prompt }).then(
              (r) => r.text
            ),
          keepRecentTokens: this.keepRecentTokens
        })
      )
      .compactAfter(this.compactAfterTokens);
  }

  /** The model compaction summarizes with. Defaults to the turn's model. */
  protected compactionModel(): LanguageModel {
    return this.resolveModel(this.getModel());
  }

  override configureContext(): ContextConfig[] {
    const spec = (this.constructor as SubAgentClass).spec;
    return [
      { label: "soul", provider: { get: async () => spec.soul } },
      ...this.plugins.context()
    ];
  }

  override getTools(): ToolSet {
    return this.plugins.tools(this.pluginContext());
  }

  override getActions(): Record<string, Action> {
    return this.plugins.actions(this.pluginContext());
  }

  protected pluginContext(): PluginContext<Env> {
    const turn = () =>
      this.activeTurnMetadata as Partial<SubAgentEnvelope> | undefined;
    return {
      env: this.env,
      storage: this.ctx.storage,
      agentName: this.name,
      callerKey: () => {
        const key = turn()?.callerKey;
        if (!key) throw new Error("this sub-agent run carries no caller key");
        return key;
      },
      workspace: () => this.workspace,
      runtime: () => turn()?.runtime
    };
  }

  /**
   * The dispatch as the sub-agent reads it, with the task, caller and runtime
   * stamped on as `turnMetadata` — which Think persists on the message, so a
   * recovered turn reads the same values back.
   */
  protected override formatAgentToolInput(input: unknown): UIMessage {
    const envelope = input as SubAgentEnvelope;
    const spec = (this.constructor as SubAgentClass).spec as SubAgentSpec<
      unknown,
      unknown
    >;
    const text = spec.formatInput
      ? spec.formatInput(envelope.input)
      : typeof envelope.input === "string"
        ? envelope.input
        : JSON.stringify(envelope.input);
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
      metadata: {
        turnMetadata: {
          taskId: envelope.taskId,
          callerKey: envelope.callerKey,
          ...(envelope.runtime ? { runtime: envelope.runtime } : {})
        }
      }
    };
  }

  /**
   * Send what the model says before a tool call to the parent as a note, the
   * moment the call starts. `onStepEnd` fires after the step's tools finish,
   * which for a long tool is too late to be progress.
   *
   * A persisted milestone rather than ephemeral progress: the parent's
   * `onProgress` is best-effort, so it replays these when the run finishes.
   * Keyed on the tool call, which is stable across a recovered step.
   */
  override async onChunk(ctx: {
    chunk: { type: string; text?: string; toolCallId?: string };
  }): Promise<void> {
    const { chunk } = ctx;
    if (chunk.type === "text-delta") {
      this.#buffered += chunk.text ?? "";
      return;
    }
    if (chunk.type !== "tool-call" || this.#flushed) return;
    this.#flushed = true;
    const text = this.#buffered.trim();
    this.#buffered = "";
    if (!text || !chunk.toolCallId) return;
    await this.note(`${this.name}:${chunk.toolCallId}`, text);
  }

  override onStepEnd(): void {
    this.#buffered = "";
    this.#flushed = false;
  }

  /** Report one note to the parent's transcript. For tools with news. */
  protected async note(key: string, text: string): Promise<void> {
    const data: NoteData = { key, text };
    await this.reportProgress(
      { milestone: NOTE_MILESTONE, message: text, data },
      { persist: true }
    );
  }
}
