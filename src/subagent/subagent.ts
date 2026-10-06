import {
  Think,
  defaultContextOverflowClassifier,
  type Action,
  type ThinkModel,
  type ThinkSession
} from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import { type LanguageModel, type ToolSet, type UIMessage } from "ai";
import {
  clipEntryBody,
  type ArtifactEntryDetail,
  type EntryStatus
} from "../artifacts/detail.js";
import type { AgentPlugin, PluginContext } from "../contract/plugin.js";
import {
  assemblePlugins,
  type AssembledPlugins
} from "../contract/assemble.js";
import type { SubAgentSpec } from "../contract/subagent.js";
import { compaction, SEND_REASONING } from "../agent/history.js";
import { readRunSummary } from "../agent/outcome.js";

/**
 * A sub-agent: its own Durable Object facet with its own messages, recovery and
 * resumable stream, dispatched by a `StepAgent` through `runAgentTool`. Nothing
 * here knows about A2A — the task is the parent's.
 */

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

/** A note's payload: its dedupe key, its text and its card, all persisted. */
export interface NoteData {
  key: string;
  text: string;
  /**
   * What opening the note on the transcript shows. Clip its sections with
   * `clipEntryBody` before reporting it: a milestone is persisted before the
   * transcript ever sees it.
   */
  detail?: ArtifactEntryDetail;
}

export abstract class SubAgent<
  Env extends Cloudflare.Env = Cloudflare.Env
> extends Think<Env> {
  /** Set on every concrete class: `static override spec = MY_SPEC`. */
  static spec: SubAgentSpec<never, never>;

  override maxSteps = Infinity;
  override chatRecovery = { maxRecoveryWork: Infinity };
  override contextOverflow = { reactive: true };
  /** A turn's reasoning is not stored — see `../agent/history.ts`. */
  override sendReasoning = SEND_REASONING;

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

  /** The plugins are checked here, so a wiring fault fails the dispatch. */
  override async onStart(): Promise<void> {
    this.plugins.check(this.pluginContext());
    await super.onStart();
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
        compaction(() => this.compactionModel(), this.keepRecentTokens)
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

  /** The run's result, read across its whole turn: see {@link readRunSummary}. */
  protected override getAgentToolSummary(
    runId: string,
    output: unknown
  ): string {
    return (
      readRunSummary(this.messages) || super.getAgentToolSummary(runId, output)
    );
  }

  /**
   * Send what the model says before a tool call to the parent as a note, the
   * moment the call starts, and each tool call as a card that its result
   * completes. `onStepEnd` fires after the step's tools finish, which for a
   * long tool is too late to be progress.
   *
   * A persisted milestone rather than ephemeral progress: the parent's
   * `onProgress` is best-effort, so it replays these when the run finishes.
   * Keyed on the tool call, which is stable across a recovered step.
   */
  override async onChunk(ctx: { chunk: ToolChunk }): Promise<void> {
    const { chunk } = ctx;
    if (chunk.type === "text-delta") {
      this.#buffered += chunk.text ?? "";
      return;
    }
    const id = chunk.toolCallId;
    if (!id) return;
    if (chunk.type === "tool-call") {
      if (!this.#flushed) {
        this.#flushed = true;
        const text = this.#buffered.trim();
        this.#buffered = "";
        if (text) await this.note(`${this.name}:${id}`, text);
      }
      await this.#card(id, chunk, "running", "Input", chunk.input);
      return;
    }
    // A preliminary result is a streaming tool's partial output; the final one
    // follows under the same id.
    if (chunk.type === "tool-result" && !chunk.preliminary)
      await this.#card(id, chunk, "ok", "Output", chunk.output);
    if (chunk.type === "tool-error")
      await this.#card(id, chunk, "error", "Error", chunk.error);
  }

  /**
   * One half of a tool's card: the call opens it, the result or error
   * completes it — two entries sharing a `ref`, which the transcript folds.
   */
  async #card(
    id: string,
    chunk: ToolChunk,
    status: EntryStatus,
    label: string,
    value: unknown
  ): Promise<void> {
    const name = chunk.toolName ?? "tool";
    const half = status === "running" ? "call" : "result";
    await this.note(
      `${this.name}:${id}:${half}`,
      summarizeToolInput(chunk.input) ?? name,
      {
        ref: `${this.name}:${id}`,
        status,
        title: name,
        sections: [{ label, body: clipEntryBody(show(value)), format: "code" }]
      }
    );
  }

  override onStepEnd(): void {
    this.#buffered = "";
    this.#flushed = false;
  }

  /** Report one note to the parent's transcript. For tools with news. */
  protected async note(
    key: string,
    text: string,
    detail?: ArtifactEntryDetail
  ): Promise<void> {
    const data: NoteData = { key, text, ...(detail ? { detail } : {}) };
    await this.reportProgress(
      { milestone: NOTE_MILESTONE, message: text, data },
      { persist: true }
    );
  }
}

/** The fields of an AI SDK stream part that {@link SubAgent.onChunk} reads. */
interface ToolChunk {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  preliminary?: boolean;
}

/** The most of a tool's input a card's summary line shows. */
const SUMMARY_MAX_CHARS = 120;

/**
 * A tool call as one line: its input's first string field, which for most
 * tools is the thing acted on — a path, a query, a command. `undefined` when
 * there is none, and the card falls back to the tool's name.
 */
function summarizeToolInput(input: unknown): string | undefined {
  let first: unknown = input;
  if (typeof input === "object" && input !== null && !Array.isArray(input))
    first = Object.values(input).find((value) => typeof value === "string");
  if (typeof first !== "string") return undefined;
  const line = first.trim().split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length <= SUMMARY_MAX_CHARS
    ? line
    : `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** A tool's input or output as a card's body. */
function show(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
