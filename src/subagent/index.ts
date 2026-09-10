import { Agent } from "agents";
import { z } from "zod";
import { CHUNK_SOFT_MS } from "../platform.js";
import type { ModelPair, ModelRuntime } from "../agent/model.js";
import { buildRecipeTools } from "../runtime/tool-families.js";
import type { ToolFamilyBuilder } from "../contract/plugin.js";
import {
  RecipeValidationError,
  validateRecipe,
  type RecipePolicy
} from "../contract/validation.js";
import type {
  ProgressEvent,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskId,
  SubtaskRuntime
} from "../subtasks/types.js";
import {
  SubtaskParamsError,
  type SubtaskTypeRegistry
} from "../subtasks/subtask-types.js";
import { SelfOrigin } from "../a2a/self-origin.js";
import { renderSubagentPrompt } from "./prompt.js";
import { makeWorkspaceHandle, type WorkspaceBacking } from "./workspace.js";
import { fingerprintRequest } from "./fingerprint.js";
import { runResumableChunk, type ChunkRunState } from "./run.js";

/**
 * Everything the facet needs that comes from the *host*: resolved config, the
 * capability policy, the installed subtask types and tool families, the model
 * runtime, and a workspace backend.
 *
 * A Durable Object class is constructed by the runtime, so it cannot take
 * constructor arguments — which is exactly the problem a library version of this
 * facet has to solve. {@link RecipeSubagentBase} takes it from an abstract
 * method instead: the consumer subclasses once, and everything host-specific
 * arrives through that one seam.
 */
export interface SubagentRuntime {
  policy: RecipePolicy;
  types: SubtaskTypeRegistry;
  models: ModelRuntime;
  toolFamilies: ReadonlyMap<string, ToolFamilyBuilder>;
  /** `CoreConfig.toolOutputWindow`. */
  toolOutputWindow: number;
  /** `CoreConfig.model.maxOutputTokens`. */
  maxOutputTokens: number;
  /**
   * Build the durable file store over this facet's own SQLite.
   *
   * Supplied by the host because the backend is a plugin's: core declares the
   * {@link WorkspaceBacking} shape and the caps, `@dynamicagents/plugins/workspace`
   * supplies the `@cloudflare/shell` implementation, and an agent that never
   * delegates file work installs neither.
   */
  workspaceBacking(
    sql: SqlStorage,
    name: () => string | undefined
  ): WorkspaceBacking;
}

/**
 * Message prefix of the error thrown when a child that already holds a cached
 * terminal result receives a *different* request. Custom error classes don't
 * survive DO RPC, so this prefix is the cross-boundary contract: it signals a
 * parent lifecycle bug — stale children must be deleted before a genuinely new
 * execution — and a Workflow retry after the parent's cleanup will succeed.
 */
export const FINGERPRINT_MISMATCH =
  "recipe-subagent: request fingerprint mismatch";

/** Deterministic managed-child name for one Subtask execution. */
export function subagentName(taskId: string, subtaskId: SubtaskId): string {
  return `subtask:${taskId}:${subtaskId}`;
}

/** Zod mirror of {@link RecipeExecutionResult} for parsing the cached JSON. */
const cachedResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    resultParts: z
      .array(z.object({ kind: z.literal("text"), text: z.string() }))
      .min(1),
    modelId: z.string()
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    modelId: z.string().nullable()
  })
]);

/**
 * `RecipeSubagent` — the isolated, stateless managed child that executes one
 * Subtask under a resolved Recipe. Created as an Agents SDK sub-agent (facet)
 * beneath the calling agent, so it needs no wrangler Durable Object binding and
 * no `new_sqlite_classes` entry; it must only be exported from the consuming
 * Worker's entry so `ctx.exports` can resolve it by class name.
 *
 * It never constructs a Session, never reads parent history beyond the
 * references supplied on its request, never reaches durable memory, and never
 * resolves a Recipe itself — it defensively re-validates the resolved Recipe the
 * parent sends and accepts no configuration beyond it.
 *
 * Retry safety: the child persists at most one terminal result in its own
 * SQLite, keyed by the deterministic request fingerprint, plus the rolling
 * `run_state` of an in-progress multi-chunk run. A retry with the same
 * fingerprint replays the terminal result or resumes the run without repeating
 * completed work; a different request for the same child name is rejected
 * ({@link FINGERPRINT_MISMATCH}). Transient platform faults throw and cache
 * nothing, so the enclosing Workflow step can retry. The parent deletes the child
 * (`deleteSubAgent`) only after its durable copy of the result succeeds, which
 * wipes this storage — the workspace and run state included.
 *
 * Not "stateless" like the single-shot original: it owns per-execution durable
 * state (the workspace and the run checkpoint), scoped to one execution and swept
 * with the child.
 */
export abstract class RecipeSubagentBase<
  TEnv extends Cloudflare.Env = Cloudflare.Env
> extends Agent<TEnv> {
  /**
   * Supply the host runtime. Called per RPC, not memoized here — an
   * implementation that builds something expensive should memoize its own.
   *
   * ```ts
   * export class RecipeSubagent extends RecipeSubagentBase<Env> {
   *   protected subagentRuntime() {
   *     return (this._rt ??= buildSubagentRuntime(this.env));
   *   }
   * }
   * ```
   */
  protected abstract subagentRuntime(): SubagentRuntime;

  /**
   * Test-only `ModelPair` injection (a field, so never on the RPC stub).
   * A whole pair — rather than model instances — so error-path tests can throw
   * synchronously from the pair's factories, the repo convention (a rejecting
   * `doGenerate` inside `generateText` leaks an unhandled rejection through
   * the AI SDK telemetry span that workerd flags as a failure).
   */
  modelsOverride?: ModelPair;

  private _workspace?: WorkspaceBacking;

  /**
   * The chunk currently executing here, if any. In memory only — it exists to be
   * interrupted mid-call, and an isolate that lost it has no in-flight call left
   * to interrupt. See {@link abortRun}.
   */
  private inflight?: AbortController;

  /**
   * This deployment's own public origin, as the parent DO passes it on every
   * chunk, pinned from the first. In memory for the same reason {@link inflight}
   * is: a facet is reached only through {@link executeChunk}, so an instance that
   * lost it is an instance that will be told again before it can run anything.
   * See {@link SelfOrigin}.
   */
  private readonly selfOriginMemo = new SelfOrigin();

  async onStart(): Promise<void> {
    this.ensureTables();
  }

  /**
   * Idempotent schema bootstrap. Also called lazily from the RPCs so
   * `runInDurableObject`-style tests reach ready tables without RPC dispatch
   * (mirroring how `AgentDB` migrates on construction).
   */
  private ensureTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS execution_cache (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS run_state (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        fingerprint TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
  }

  /** The recipe's durable workspace, backed by this facet's own SQLite storage. */
  private workspace(): WorkspaceBacking {
    return (this._workspace ??= this.subagentRuntime().workspaceBacking(
      this.ctx.storage.sql,
      () => this.name
    ));
  }

  /**
   * This deployment's own public origin, if the parent has passed it to this
   * instance yet. See {@link SelfOrigin}.
   */
  protected selfOrigin(): string | undefined {
    return this.selfOriginMemo.peek();
  }

  /**
   * The same, for a caller that cannot proceed without it — a facet that signs
   * its own caller tokens, above all. Mirrors `DynamicAgent.requireSelfOrigin`,
   * because a facet must run on the same provider, and so the same credential
   * path, as the parent that delegated to it.
   */
  protected requireSelfOrigin(): string {
    return this.selfOriginMemo.require();
  }

  /**
   * Execute one durable chunk of a Subtask under the parent's resolved Recipe.
   *
   * A terminal outcome (completed / failed) is cached and replayed on retry. A
   * mid-run chunk persists its rolling state to `run_state` and returns a
   * `done: false` yield for the Workflow to run another chunk. `chunk` and
   * `selfOrigin` are separate arguments — never part of `request` — so every
   * chunk fingerprints identically and the cache/resume keys line up. Only
   * transient platform faults throw (nothing cached), so a Workflow retry
   * resumes from the last checkpoint.
   */
  async executeChunk(
    request: RecipeExecutionRequest,
    _chunk: number,
    runtime: SubtaskRuntime = {},
    selfOrigin?: string
  ): Promise<RecipeChunkResult> {
    this.ensureTables();
    // Before `subagentRuntime()`, which is where a host builds its model runtime
    // — and a facet running on a provider it authenticates to mint-signed reads
    // this origin from there.
    this.selfOriginMemo.note(selfOrigin);
    const rt = this.subagentRuntime();
    const fingerprint = await fingerprintRequest(request);

    // A terminal result already exists → replay it (idempotent retry).
    const cached = this.sql<{ fingerprint: string; result_json: string }>`
      SELECT fingerprint, result_json FROM execution_cache WHERE slot = 1
    `[0];
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw mismatch("terminal");
      return {
        done: true,
        result: cachedResultSchema.parse(JSON.parse(cached.result_json)),
        progress: []
      };
    }

    // Validate the recipe up front; an unusable recipe (disabled, or with no
    // soul) and an empty prompt are deterministic, cacheable terminal failures
    // with no model call.
    let recipe;
    try {
      recipe = validateRecipe(request.recipe, rt.policy);
    } catch (error) {
      if (!(error instanceof RecipeValidationError)) throw error;
      return this.cacheTerminal(fingerprint, {
        status: "failed",
        error: error.message,
        modelId: null
      });
    }
    if (request.prompt.trim() === "") {
      return this.cacheTerminal(fingerprint, {
        status: "failed",
        error: "empty subtask prompt",
        modelId: null
      });
    }
    // Re-check the type's param contract, the same defensive posture as
    // `validateRecipe`: a subtask missing a param its type requires cannot
    // succeed, and failing here costs no model call and gives the parent a real
    // diagnostic.
    try {
      rt.types.validateParams(request.type, request.params);
    } catch (error) {
      if (!(error instanceof SubtaskParamsError)) throw error;
      return this.cacheTerminal(fingerprint, {
        status: "failed",
        error: error.message,
        modelId: null
      });
    }

    // Resume an in-progress run, guarding against a stale child holding a
    // *different* run (the same reuse hazard the terminal cache guards).
    const saved = this.sql<{ fingerprint: string; state_json: string }>`
      SELECT fingerprint, state_json FROM run_state WHERE slot = 1
    `[0];
    if (saved && saved.fingerprint !== fingerprint)
      throw mismatch("in-progress");
    const prev: ChunkRunState | null = saved
      ? (JSON.parse(saved.state_json) as ChunkRunState)
      : null;

    const models =
      this.modelsOverride ??
      rt.models.createModelPair({
        primaryModelId: recipe.primaryModelId,
        fallbackModelId: recipe.fallbackModelId,
        // AI Gateway correlation: tie this child's model calls to its Subtask.
        metadata: { taskId: request.taskId, subtaskId: request.subtaskId }
      });
    const workspace = makeWorkspaceHandle(this.workspace());
    const progress: ProgressEvent[] = [];
    // Before the tools, which close over its signal so a cancel reaches work they
    // started as well as the model call.
    const controller = new AbortController();
    const { tools } = buildRecipeTools(recipe.toolFamilies, rt.toolFamilies, {
      workspace,
      emitProgress: (event: ProgressEvent) => progress.push(event),
      params: request.params,
      runtime,
      signal: controller.signal
    });
    const { system, prompt } = renderSubagentPrompt({ ...request, recipe });

    this.inflight = controller;
    let outcome, state;
    try {
      ({ outcome, state } = await runResumableChunk(prev, {
        system,
        seedPrompt: prompt,
        models,
        tools,
        limits: recipe.limits,
        chunkSoftMs: CHUNK_SOFT_MS,
        historyWindow: recipe.historyWindow,
        toolOutputWindow: rt.toolOutputWindow,
        reportMetrics: recipe.reportMetrics,
        maxOutputTokens: rt.maxOutputTokens,
        now: () => Date.now(),
        progress,
        checkpoint: (s) => this.saveRunState(fingerprint, s),
        abortSignal: controller.signal
      }));
    } finally {
      this.inflight = undefined;
    }
    // The per-step checkpoint already ran; persist the final state too so a chunk
    // that yielded without a completed step still advances durably.
    this.saveRunState(fingerprint, state);

    if (outcome.done) {
      return this.cacheTerminal(fingerprint, outcome.result, outcome.progress);
    }
    return { done: false, progress: outcome.progress };
  }

  /**
   * Interrupt the chunk running here right now, so a cancellation lands on the
   * current model call instead of at the next chunk boundary (up to `chunkSoftMs`
   * later — minutes, for a long recipe). Returns whether there was one to stop.
   *
   * Distinct from {@link abortExecution}, which releases *external* state after
   * the fact; this only stops local work. An aborted run yields rather than
   * producing a terminal result, so nothing is cached and the parent resolves the
   * row itself. Reaching a facet mid-`executeChunk` works because it is awaiting
   * a model `fetch` at the time, which does not hold the input gate closed.
   */
  async abortRun(): Promise<boolean> {
    if (!this.inflight) return false;
    this.inflight.abort();
    return true;
  }

  /**
   * Best-effort cleanup on cancellation: rebuild the recipe's tool families and
   * run their `abort` hooks (e.g. release an external resource recorded in the
   * workspace session file). Reconstructible from the workspace, so it is safe on a fresh
   * isolate. The parent supplies the validated tool families it resolved.
   */
  async abortExecution(toolFamilies: string[]): Promise<void> {
    this.ensureTables();
    const rt = this.subagentRuntime();
    const ctx = {
      workspace: makeWorkspaceHandle(this.workspace()),
      emitProgress: () => {},
      params: {},
      runtime: {}
    };
    const { abort } = buildRecipeTools(toolFamilies, rt.toolFamilies, ctx);
    if (abort) await abort(ctx);
  }

  /** Persist a terminal result to the cache and return it as a done chunk. */
  private cacheTerminal(
    fingerprint: string,
    result: RecipeExecutionResult,
    progress: ProgressEvent[] = []
  ): RecipeChunkResult {
    this.sql`
      INSERT INTO execution_cache (slot, fingerprint, result_json, created_at)
      VALUES (1, ${fingerprint}, ${JSON.stringify(result)}, ${Date.now()})
      ON CONFLICT (slot) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `;
    return { done: true, result, progress };
  }

  /** Persist the rolling run state (called after every model turn). */
  private saveRunState(fingerprint: string, state: ChunkRunState): void {
    this.sql`
      INSERT INTO run_state (slot, fingerprint, state_json, updated_at)
      VALUES (1, ${fingerprint}, ${JSON.stringify(state)}, ${Date.now()})
      ON CONFLICT (slot) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `;
  }
}

/** The cross-RPC stale-child error (see {@link FINGERPRINT_MISMATCH}). */
function mismatch(phase: "terminal" | "in-progress"): Error {
  return new Error(
    `${FINGERPRINT_MISMATCH}: this child already holds a ${phase} state for a ` +
      "different request; the parent must delete a stale child before starting a " +
      "genuinely new execution"
  );
}
