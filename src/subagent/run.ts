import type { LanguageModel, ModelMessage, StepResult, ToolSet } from "ai";
import { generateText, isStepCount } from "ai";
import {
  CHUNK_SOFT_MS,
  MAX_TOOL_CALL_MS,
  TOOL_CALL_GRACE_MS
} from "../platform.js";
import { stepAllowance } from "../agent/budget.js";
import {
  isTransientAiError,
  nonRecoverableKind,
  type NonRecoverableKind
} from "../agent/inference.js";
import { validateRecipe, type RecipePolicy } from "../contract/validation.js";
import type { ModelPair } from "../agent/model.js";
import type {
  ProgressEvent,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult
} from "../subtasks/types.js";
import type { RecipeLimits } from "../contract/recipe.js";
import { renderSubagentPrompt } from "./prompt.js";

/**
 * The resumable execution runner — ONE loop for every Recipe, from a single-shot
 * general Subtask to a long game. It runs the model/tool loop in durable
 * **chunks**: each call advances as far as `chunkSoftMs` allows (or until the run
 * spends its budget, or until a tool emits progress), checkpoints its rolling state
 * after every turn, and returns either a terminal result or a "not done" yield. The
 * facet persists the state between chunks and the Workflow runs each chunk as its
 * own durable, retryable step — so no single step ever approaches the platform
 * step timeout, and a crash loses at most the in-flight turn.
 *
 * Domain behavior lives entirely in the tool families; this runner is agnostic of
 * what work happens beneath it. State that must outlive the small rolling context
 * window is the recipe's responsibility to persist to its workspace.
 */

/** The rolling state carried across a run's chunks (persisted by the facet). */
export interface ChunkRunState {
  /** Windowed conversation so far (system is supplied separately, not stored here). */
  messages: ModelMessage[];
  /** Total model turns (tool-loop steps) across every chunk — bounds `maxTurns`. */
  turns: number;
  /** Total `generateText` invocations (including fallbacks and summarization). */
  llmCalls: number;
  /** Wall-clock start of the whole execution (for the metrics footer). */
  startedAtMs: number;
}

/** Everything one chunk needs, assembled by the facet (or a test) each call. */
export interface ChunkRunDeps {
  system: string;
  /** The rendered initial user message; seeds a fresh run's first chunk. */
  seedPrompt: string;
  models: ModelPair;
  tools: ToolSet;
  /** The run's budget: turns and wall clock. Nothing else. */
  limits: RecipeLimits;
  /**
   * How long this chunk may run before it checkpoints and yields a fresh durable
   * step — the Workers step-timeout guard, not a budget, and identical for every
   * Recipe (`CHUNK_SOFT_MS` in `platform.ts`). Injected rather than imported so
   * the runner stays testable with a fake clock.
   */
  chunkSoftMs: number;
  historyWindow: number;
  /**
   * How many of the most recent assistant turns keep their tool results in full;
   * older ones are stubbed by {@link elideToolOutputs}. A mechanic of the window
   * rather than a property of a domain — see `CoreConfig.toolOutputWindow`.
   */
  toolOutputWindow: number;
  reportMetrics: boolean;
  /**
   * Output-token ceiling for every model call in this chunk. Injected rather
   * than imported: it is host config, and a published runner must not carry a
   * hardcoded one.
   */
  maxOutputTokens: number;
  /**
   * `CoreConfig.model.maxRetries` — retries on *this* model, honouring the
   * provider's `retry-after`, before the slot hands over to the fallback.
   */
  maxRetries: number;
  now: () => number;
  /** Shared sink the tool families push progress events into (fresh per chunk). */
  progress: ProgressEvent[];
  /** Persist rolling state after every model turn — the crash-safety checkpoint. */
  checkpoint: (state: ChunkRunState) => void | Promise<void>;
  /**
   * Interrupts the in-flight model call when the parent Task is canceled. Without
   * it a cancellation is only observed at the next chunk boundary — up to
   * `chunkSoftMs` of unwanted play. See {@link ChunkAttempt}'s `aborted` case for
   * why an abort is emphatically *not* a model failure.
   */
  abortSignal?: AbortSignal;
}

export interface ChunkRunOutput {
  outcome: RecipeChunkResult;
  state: ChunkRunState;
}

/**
 * `aborted` is deliberately distinct from `failed`. A rejected `generateText`
 * normally means "this model is unusable, try the other one" and, if both go,
 * becomes a **cached terminal failure**. An abort means neither: the work was
 * interrupted on purpose, a second model would only burn another call, and
 * caching the outcome would replay a bogus failure on every future retry. It
 * therefore yields — same rule the runner already applies to transient faults,
 * which throw and cache nothing.
 */
type ChunkAttempt =
  | { kind: "completed"; text: string; modelId: string }
  | { kind: "yield" }
  | { kind: "aborted" }
  | { kind: "failed"; diagnostic: string; error?: unknown; modelId: string };

// The window mechanics live in `/agent` now: `/round` needs the identical rules
// for the exchanges it carries between rounds, and two copies of "which tool
// results are still worth their tokens" would not stay identical. Re-exported
// here because this is where they were, and where a reader of the loop below
// still expects to find them.
export {
  ELIDED_TOOL_OUTPUT,
  elideToolOutputs,
  windowMessages
} from "../agent/window.js";
import { elideToolOutputs, windowMessages } from "../agent/window.js";

/** Human-readable elapsed time for the metrics footer. */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function metricsFooter(state: ChunkRunState, now: number): string {
  return (
    `\n\n---\nRan ${state.turns} model turn(s) across ${state.llmCalls} model ` +
    `call(s) in ${formatDuration(now - state.startedAtMs)}.`
  );
}

/**
 * Has this execution spent its whole-run budget? Turns and wall-clock are one
 * predicate because they mean the same thing to the runner — the run is over and
 * owes a report — and because checking only turns is what let a slow-turning
 * recipe run for hours while its turn counter looked healthy.
 *
 * `startedAtMs` rides in the checkpoint, so the deadline survives chunk
 * boundaries, step retries and isolate restarts without any storage of its own.
 */
function budgetSpent(state: ChunkRunState, deps: ChunkRunDeps): boolean {
  return (
    state.turns >= deps.limits.maxTurns ||
    deps.now() - state.startedAtMs >= deps.limits.maxWallMs
  );
}

function completed(
  state: ChunkRunState,
  deps: ChunkRunDeps,
  text: string,
  modelId: string
): ChunkRunOutput {
  const finalText = deps.reportMetrics
    ? text + metricsFooter(state, deps.now())
    : text;
  return {
    outcome: {
      done: true,
      result: {
        status: "completed",
        resultParts: [{ kind: "text", text: finalText }],
        modelId
      },
      progress: deps.progress
    },
    state
  };
}

/**
 * Fail a chunk on an error no second attempt can clear.
 *
 * Terminal for this subtask, and deliberately *not* a throw: a throw is retried
 * by the Workflow step, which is exactly the spend this classification exists to
 * avoid. The parent round then hits the same condition on its own inference and
 * fails carrying the kind, which is where an operator-facing message gets
 * attached — a subagent has no channel of its own to say "a human must fix
 * this", only this row's `error` string.
 */
function nonRecoverableOutcome(
  state: ChunkRunState,
  deps: ChunkRunDeps,
  modelId: string,
  kind: NonRecoverableKind,
  diagnostic: string
): ChunkRunOutput {
  console.error("[recipe-runner] non-recoverable model failure", {
    model: modelId,
    kind,
    diagnostic
  });
  return {
    outcome: {
      done: true,
      result: {
        status: "failed",
        error: `${kind}: ${diagnostic}`,
        modelId
      },
      progress: deps.progress
    },
    state
  };
}

/**
 * Run one durable chunk. Returns a terminal result (natural completion, budget
 * exhaustion, or exhausted models) or a `done: false` yield with the progress
 * emitted this chunk. Throws only on a transient platform fault, so the Workflow
 * step retries and resumes from the last checkpoint.
 */
export async function runResumableChunk(
  prev: ChunkRunState | null,
  deps: ChunkRunDeps
): Promise<ChunkRunOutput> {
  const state: ChunkRunState = prev ?? {
    messages: [{ role: "user", content: deps.seedPrompt }],
    turns: 0,
    llmCalls: 0,
    startedAtMs: deps.now()
  };

  /**
   * Hand the chunk back with no terminal result. An abort takes this exit too —
   * that is the whole point: nothing terminal is produced, so the facet caches
   * nothing and no bogus failure can replay on a later retry.
   */
  const yielded = (): ChunkRunOutput => ({
    outcome: { done: false, progress: deps.progress },
    state
  });

  // Already canceled before this chunk started: don't call a model at all.
  if (deps.abortSignal?.aborted) return yielded();

  // The durable enforcement point for the whole-run budget: it reads persisted
  // state before any model call, so every chunk re-checks it however the previous
  // one ended. It also covers the retry that resumes from a checkpoint taken on
  // the final allowed turn before the chunk returned — e.g. summarizeBudget's own
  // call threw a transient fault and the Workflow step retried. The budget is
  // already spent, so summarize now instead of running another unbudgeted,
  // side-effecting turn (which `stopWhen`'s `Math.max(1, …)` would otherwise force).
  if (budgetSpent(state, deps)) {
    return summarizeBudget(state, deps);
  }

  const chunkStartMs = deps.now();

  const onStepEnd = async (step: StepResult<ToolSet>): Promise<void> => {
    state.turns += 1;
    // Window first (drops whole turns at an assistant boundary), then elide what
    // survived. Both before the checkpoint, so the durable `run_state` row
    // shrinks with the context rather than tracking the untrimmed run.
    state.messages = elideToolOutputs(
      windowMessages(
        [...state.messages, ...step.response.messages],
        deps.historyWindow
      ),
      deps.toolOutputWindow
    );
    await deps.checkpoint(state);
  };

  /**
   * Four boundaries, and only the first two are budgets. A chunk ends on
   * whichever comes first; the run ends only on a budget.
   *
   * Rebuilt per attempt rather than once per chunk, and that is the whole point:
   * `isStepCount` counts within one `generateText` call, so a `stopWhen` shared
   * with the fallback would hand it the turn allowance the primary already spent.
   * `onStepEnd` has moved `state.turns` by then, so recomputing here charges the
   * fallback for what the run has actually used.
   */
  const boundaries = () => [
    // The turn budget — all of what is left of it. There is deliberately no
    // per-chunk turn allowance: a turn count cannot bound a step's *duration*,
    // which is the only thing the step timeout cares about, so the wall-clock
    // predicate below owns that job alone.
    isStepCount(stepAllowance(deps.limits.maxTurns, state.turns)),
    // The run-wide deadline. Without it the entry guard would only observe the
    // deadline at the next chunk boundary, up to `chunkSoftMs` past it.
    () => deps.now() - state.startedAtMs >= deps.limits.maxWallMs,
    // Not a budget: the configured step timeout, which needs this chunk to
    // checkpoint and hand back a fresh step before it trips. Soft, and only
    // checked here between turns — the turn already in flight when it trips still
    // runs to completion, which is why `STEP_TIMEOUT_MS - CHUNK_SOFT_MS` is sized
    // to cover a whole turn rather than a nominal moment. See `platform.ts`.
    () => deps.now() - chunkStartMs >= deps.chunkSoftMs,
    // Not a budget either: publish progress to the user promptly.
    () => deps.progress.length > 0
  ];

  const attempt = async (
    model: () => LanguageModel,
    modelId: string
  ): Promise<ChunkAttempt> => {
    state.llmCalls += 1;
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: model(),
        instructions: deps.system,
        messages: state.messages,
        tools: deps.tools,
        stopWhen: boundaries(),
        maxOutputTokens: deps.maxOutputTokens,
        // Not a duplicate of the fallback: the fallback answers "this model
        // cannot do it", and a 429 says "not yet". See `ModelConfig.maxRetries`.
        maxRetries: deps.maxRetries,
        abortSignal: deps.abortSignal,
        // The recipe's tools get the same ceiling the main agent's do; see the
        // `timeout` on the round's own `generateText` for why only `toolMs`.
        timeout: { toolMs: MAX_TOOL_CALL_MS - TOOL_CALL_GRACE_MS },
        onStepEnd
      });
    } catch (error) {
      // Check the signal before the error: an abort surfaces as a rejection, and
      // reading it as bad model output would spend the fallback and cache a
      // failure for work that was cancelled on purpose.
      if (deps.abortSignal?.aborted) return { kind: "aborted" };
      return { kind: "failed", diagnostic: String(error), error, modelId };
    }
    if (deps.abortSignal?.aborted) return { kind: "aborted" };
    if (result.finishReason === "length") {
      // Its own warning, not just a diagnostic string: hitting the output ceiling
      // is a tuning signal about `config.model.maxOutputTokens`, distinct from the
      // model producing bad output, and the two are indistinguishable once folded
      // into the "recipe exhausted" message.
      console.warn("[recipe-runner] model output truncated", {
        model: modelId,
        maxOutputTokens: deps.maxOutputTokens
      });
      return {
        kind: "failed",
        diagnostic: "truncated (finish_reason=length)",
        modelId
      };
    }
    if (result.finishReason === "stop") {
      const text = result.text.trim();
      return text === ""
        ? { kind: "failed", diagnostic: "empty final reply", modelId }
        : { kind: "completed", text, modelId };
    }
    // Not a final answer (e.g. finish_reason=tool-calls): a stop condition fired
    // mid-loop — the chunk yielded a durable boundary with more work to do.
    return { kind: "yield" };
  };

  let a = await attempt(deps.models.primary, deps.models.primaryId());
  if (a.kind === "aborted") return yielded();
  if (a.kind === "failed") {
    // Checked before the fallback, not after: the second slot would present the
    // same rejected credential. Returned rather than thrown — a throw here is
    // retried by the Workflow step, which is the other cost this avoids. The
    // chunk fails, and the parent's next round classifies it properly.
    const blocked = nonRecoverableKind(a.error);
    if (blocked) {
      return nonRecoverableOutcome(
        state,
        deps,
        a.modelId,
        blocked,
        a.diagnostic
      );
    }

    console.warn("[recipe-runner] primary attempt failed, trying fallback", {
      model: a.modelId,
      diagnostic: a.diagnostic
    });
    const primaryFailure = a;
    a = await attempt(deps.models.fallback, deps.models.fallbackId());
    if (a.kind === "aborted") return yielded();

    if (a.kind === "failed") {
      // Both attempts failed. A transient fault anywhere means a retry could
      // succeed — throw it for the Workflow step (most recent first).
      for (const failed of [a, primaryFailure]) {
        if (failed.error !== undefined && isTransientAiError(failed.error)) {
          throw failed.error;
        }
      }
      return {
        outcome: {
          done: true,
          result: {
            status: "failed",
            error:
              `recipe exhausted: primary (${primaryFailure.modelId}): ` +
              `${primaryFailure.diagnostic}; fallback (${a.modelId}): ${a.diagnostic}`,
            modelId: a.modelId
          },
          progress: deps.progress
        },
        state
      };
    }
  }

  if (a.kind === "completed") return completed(state, deps, a.text, a.modelId);

  // The chunk yielded. If the run budget is spent, force a final summary so the
  // run still returns useful output; otherwise ask the Workflow for another chunk.
  if (budgetSpent(state, deps)) {
    return summarizeBudget(state, deps);
  }
  return yielded();
}

/**
 * The run budget — turns or wall-clock — is exhausted mid-loop: run one final
 * no-tools call asking the model to produce its answer/report from the work so
 * far. Primary → fallback, same transient/deterministic split. This is what makes
 * "uncapped but bounded" safe — the ceiling yields a report instead of a dropped
 * run.
 *
 * The message deliberately does not name *which* budget ran out. The model can
 * do nothing differently either way, and the one instruction that matters —
 * report now, take no more actions — is the same.
 */
async function summarizeBudget(
  state: ChunkRunState,
  deps: ChunkRunDeps
): Promise<ChunkRunOutput> {
  const messages: ModelMessage[] = [
    ...state.messages,
    {
      role: "user",
      content:
        "You have reached your execution budget and can take no more actions. " +
        "Write your final answer or report now, based on the work so far."
    }
  ];

  const summarize = async (
    model: () => LanguageModel,
    modelId: string
  ): Promise<ChunkAttempt> => {
    state.llmCalls += 1;
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: model(),
        instructions: deps.system,
        messages,
        stopWhen: isStepCount(1),
        maxOutputTokens: deps.maxOutputTokens,
        // Retries on this model, honouring `retry-after`, before the fallback.
        // See `ModelConfig.maxRetries`.
        maxRetries: deps.maxRetries,
        abortSignal: deps.abortSignal
      });
    } catch (error) {
      if (deps.abortSignal?.aborted) return { kind: "aborted" };
      return { kind: "failed", diagnostic: String(error), error, modelId };
    }
    if (deps.abortSignal?.aborted) return { kind: "aborted" };
    const text = result.text.trim();
    return text === ""
      ? { kind: "failed", diagnostic: "empty summary", modelId }
      : { kind: "completed", text, modelId };
  };

  // An abort yields with no terminal result, exactly as in the main loop: the
  // budget summary is output, and cancelled work publishes none.
  const yielded = (): ChunkRunOutput => ({
    outcome: { done: false, progress: deps.progress },
    state
  });

  let a = await summarize(deps.models.primary, deps.models.primaryId());
  if (a.kind === "aborted") return yielded();
  if (a.kind === "failed") {
    // Same rule as the work loop: no fallback on a credential the API already
    // rejected. A summary is the cheapest call in the run, but it is not free.
    const blocked = nonRecoverableKind(a.error);
    if (blocked) {
      return nonRecoverableOutcome(
        state,
        deps,
        a.modelId,
        blocked,
        a.diagnostic
      );
    }

    const primaryFailure = a;
    a = await summarize(deps.models.fallback, deps.models.fallbackId());
    if (a.kind === "aborted") return yielded();
    if (a.kind === "failed") {
      for (const failed of [a, primaryFailure]) {
        if (failed.error !== undefined && isTransientAiError(failed.error)) {
          throw failed.error;
        }
      }
      // Even the summary failed: return a plain budget-exhausted notice.
      const text =
        "Reached the execution budget without producing a final report.";
      return completed(state, deps, text, a.modelId);
    }
  }
  return a.kind === "completed"
    ? completed(state, deps, a.text, a.modelId)
    : completed(
        state,
        deps,
        "Reached the execution budget.",
        deps.models.fallbackId()
      );
}

/** Everything a whole-run (non-chunked) execution needs — for tests and callers
 * that want a single terminal result rather than driving chunks themselves. */
export interface RecipeRunDeps {
  models: ModelPair;
  tools: ToolSet;
  now?: () => number;
  /** The capability boundary a recipe is re-validated against inside the child. */
  policy: RecipePolicy;
  /** `CoreConfig.toolOutputWindow`. */
  toolOutputWindow: number;
  /** `CoreConfig.model.maxOutputTokens`. */
  maxOutputTokens: number;
  /** `CoreConfig.model.maxRetries`. */
  maxRetries: number;
}

/**
 * Run one recipe execution to a terminal result, driving {@link runResumableChunk}
 * chunk by chunk in memory. A run that fits its budget finishes in one chunk;
 * otherwise it loops until the budget yields a summary. Used by tests and any
 * caller wanting the whole outcome; the facet drives chunks durably instead, for
 * crash-safety across the Workflow.
 *
 * Throws only on a transient platform fault (as {@link runResumableChunk} does).
 */
export async function runRecipeExecution(
  request: RecipeExecutionRequest,
  deps: RecipeRunDeps
): Promise<RecipeExecutionResult> {
  if (request.prompt.trim() === "") {
    return { status: "failed", error: "empty subtask prompt", modelId: null };
  }

  const recipe = validateRecipe(request.recipe, deps.policy);
  const { system, prompt } = renderSubagentPrompt({ ...request, recipe });
  const now = deps.now ?? Date.now;

  let state: ChunkRunState | null = null;
  // A chunk always advances ≥1 turn unless it completes, so `maxTurns` chunks is
  // the ceiling and this can never spin. Turn-derived on purpose: `maxWallMs` and
  // `chunkSoftMs` only ever end a run *sooner*, so neither can loosen the bound.
  const maxChunks = recipe.limits.maxTurns + 2;

  for (let chunk = 0; chunk < maxChunks; chunk++) {
    const chunkDeps: ChunkRunDeps = {
      system,
      seedPrompt: prompt,
      models: deps.models,
      tools: deps.tools,
      limits: recipe.limits,
      chunkSoftMs: CHUNK_SOFT_MS,
      historyWindow: recipe.historyWindow,
      toolOutputWindow: deps.toolOutputWindow,
      reportMetrics: recipe.reportMetrics,
      maxOutputTokens: deps.maxOutputTokens,
      maxRetries: deps.maxRetries,
      now,
      progress: [],
      checkpoint: () => {}
    };
    const { outcome, state: next } = await runResumableChunk(state, chunkDeps);
    if (outcome.done) return outcome.result;
    state = next;
  }

  return {
    status: "failed",
    error: `recipe did not terminate within ${maxChunks} chunks`,
    modelId: null
  };
}
