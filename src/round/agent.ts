import type { ToolSet } from "ai";
import { TaskState } from "@a2a-js/sdk";
import { validateRecipe } from "../contract/validation.js";
import type { ResolvedRecipe } from "../contract/recipe.js";
import type { AiEnv, A2ASecretsEnv } from "../env.js";
import { stateOf } from "../db/index.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import type { TurnPushContext } from "../a2a/push.js";
import type { SessionLike } from "../agent/session.js";
import {
  finalReplyMessageId,
  roundAckMessageId,
  sessionText
} from "../agent/history.js";
import { newTurnBudget, type TurnBudget } from "../agent/budget.js";
import type { AiGatewayMetadata } from "../agent/model.js";
import { FINGERPRINT_MISMATCH, subagentName } from "../subagent/index.js";
import type {
  CompositionBranch,
  RecipeChunkResult,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  Subtask,
  SubtaskChunkOutcome,
  SubtaskId,
  SubtaskRuntime,
  SubtaskScan,
  TurnTaskResult,
  TurnVerdict
} from "../subtasks/types.js";
import { DynamicAgent } from "../host/agent.js";
import type { SubagentClass } from "./subagent.js";
import type { FinalRoundReason, RoundPolicy } from "./policy.js";
import {
  buildTurnInstructions,
  runTurn,
  type RoundMode,
  type TurnInstructions
} from "./turn.js";

/**
 * A **delegating** agent: the round loop, the durable Subtasks it hands out, and
 * the isolated subagent execution beneath them.
 *
 * Everything {@link DynamicAgent} gives every agent, plus the half that only a
 * delegating one needs — and it is all mechanism. A Workflow drives it through
 * native Cloudflare RPC (`runTaskTurn`, `scanSubtasks`, `executeSubtaskChunk`,
 * …), never HTTP: the DO is a private implementation detail of the Worker.
 *
 * ## Why core owns this
 *
 * Every method below is either idempotent recovery, cancellation ordering, or
 * child lifecycle, and each one has an ordering that is load-bearing and
 * invisible: the acknowledgment is appended *before* the rows exist; a fresh
 * execution deletes its stale child but an ambiguous retry must not; a successful
 * chunk defers its child's deletion to a single post-delivery sweep. Get any of
 * them backwards and nothing fails to compile, nothing fails a lint, and the
 * damage shows up as a duplicated reply or a false-positive error weeks later.
 *
 * None of it varies between agents. What varies is the {@link RoundPolicy} — the
 * words — and the plugins.
 *
 * ## What this class does not know
 *
 * Nothing here names a domain. `resolveRuntime`, `enrichResult` and `onAbort` are
 * hooks on `AgentPlugin`, so a plugin that leases an external session or scores a
 * result gets that without a branch anywhere in this file. That inversion is what
 * lets one class body serve every delegating agent.
 */
/**
 * How much of a failed branch's message the loop compares two rounds on.
 *
 * Two reasons pointing the same way: the comparison crosses a Workflow step
 * return, which is capped, and a wall whose first three hundred characters repeat
 * is the same wall even when a trailing duration or id does not. Volatility at
 * the *start* of a message makes the comparison miss instead — which is the safe
 * direction, since the loop's other two ceilings still hold.
 */
const FAILURE_EXCERPT_CHARS = 300;

export abstract class RoundAgentBase<
  TEnv extends Cloudflare.Env & AiEnv & A2ASecretsEnv = Cloudflare.Env &
    AiEnv &
    A2ASecretsEnv
> extends DynamicAgent<TEnv> {
  private _instructions?: TurnInstructions;

  // --- the two extra seams a delegating agent fills ------------------------

  /**
   * The words: the round contract, the forced-answer notes, and the strings a user
   * reads. Core ships none of them — see {@link RoundPolicy}.
   */
  protected abstract roundPolicy(): RoundPolicy;

  /**
   * The facet class this agent's subtasks execute in.
   *
   * A seam because each agent's children must reach that agent's plugins, and a
   * facet cannot be handed a runtime: `parentAgent()` is an RPC stub, and a
   * `SubtaskRuntime` is mostly functions. So the class itself carries the
   * binding — see {@link file://./subagent.ts RecipeSubagentHost}.
   */
  protected abstract subagentClass(): SubagentClass;

  /** The prompt suffixes, built once from this agent's installed subtask types. */
  private get instructions(): TurnInstructions {
    return (this._instructions ??= buildTurnInstructions(
      this.roundPolicy(),
      this.runtime.types,
      this.config.maxSubtasks,
      this.config.mainAgentLimits
    ));
  }

  /**
   * The main agent's **work tools** for this caller — the `execute`-bearing tools
   * every round runs its loop over. The control tools that *end* a round are not
   * here; `runTurn` adds those.
   *
   * The Session's own `set_context`/`load_context` come first, with the installed
   * plugins' tools layered over them: a soul that instructs the model to record
   * durable facts with `set_context` needs it actually on the call.
   *
   * Which plugin tools appear is the plugins' business, not this class's. A
   * plugin may shape its surface from durable state — offering a search only once
   * there is something to search, because a tool whose only possible answer is
   * "nothing here yet" costs a call to discover that and costs every round the
   * tokens to describe it.
   */
  private async mainAgentTools(session: SessionLike): Promise<ToolSet> {
    return {
      ...(await session.tools()),
      ...(await this.runtime.mainAgentTools({ session }))
    };
  }

  /** Age out this agent's subtask and observation rows alongside the task rows. */
  protected override cleanupAgentState(): void {
    this.db.subtasks.cleanup();
    this.db.observations.cleanup();
  }

  // --- The task round loop (turn → execute → turn → …) ---------------------
  //
  // The parent-owned half of the Task flow. The Workflow drives these over DO RPC
  // (it cannot touch this SQLite or this Session directly); each is a durable
  // step, so every method here is safe to call again after a crash — a round is
  // idempotent on its durable output, and execution recovers from either the
  // parent row or the child's cached result.

  /**
   * One main-agent round: answer the user, or delegate a durable set of Subtasks
   * and return the acknowledgment the user sees while it runs.
   *
   * This is the RPC boundary, so it is where the round's cost becomes a field. The
   * budget is created here, handed to {@link decideRound} to be spent, and read
   * back exactly once — so no branch of the round has to remember to report a
   * number, and none can report the wrong one.
   */
  async runTaskTurn(input: {
    taskId: string;
    text: string;
    identity: GatekeeperIdentity;
    round: number;
    mode: RoundMode;
    /** Why a `final` round is final. See {@link FinalRoundReason}. */
    finalReason?: FinalRoundReason;
    /** What the Task has left. Bounds this round. */
    turnsRemaining: number;
    push?: TurnPushContext;
  }): Promise<TurnTaskResult> {
    // Before anything can reach a model: a round that calls out mint-signed
    // needs this deployment's own origin, and this is where it arrives.
    this.noteSelfOrigin(input.push?.jku);
    const budget = newTurnBudget(input.turnsRemaining);
    const verdict = await this.decideRound(input, budget);
    return { ...verdict, turns: budget.spent };
  }

  /**
   * The round itself, charging `budget` as it goes.
   *
   * Idempotent, and the recovery order is the contract:
   *
   * 1. A canceled Task stops here.
   * 2. A durable **final reply** means some round already answered — return it
   *    without inference. Re-answering could produce different words for a reply
   *    the user may already have received.
   * 3. Durable **rows for this round** mean this round already delegated —
   *    recover its acknowledgment from the Session, with no inference and no
   *    duplicate rows.
   * 4. Otherwise, infer.
   *
   * Cancellation is re-read **after** inference too, not just before it: the model
   * call is the widest window in the round, and neither the Subtask rows nor the
   * callback may land for a Task the caller already gave up on. The reply is
   * already in the Session by then (`runTurn` appends under deterministic ids
   * before returning) — that is durable history, not output the user sees.
   *
   * Returns a typed `failed` result when both models produce unusable output and
   * no durable work exists to fall back on (the Workflow routes it to failed
   * delivery); throws only on a transient fault, for the step to retry.
   */
  private async decideRound(
    input: {
      taskId: string;
      text: string;
      identity: GatekeeperIdentity;
      round: number;
      mode: RoundMode;
      finalReason?: FinalRoundReason;
      push?: TurnPushContext;
    },
    budget: TurnBudget
  ): Promise<TurnVerdict> {
    const { taskId, text, identity, round, mode, finalReason, push } = input;
    const session = this.getSession(identity);
    const policy = this.roundPolicy();
    const channel = push ? this.push(push) : undefined;

    if (await this.isTaskCanceled(taskId)) return { status: "canceled" };

    const answered = await session.getMessage(finalReplyMessageId(taskId));
    if (answered) {
      return { status: "replied", reply: sessionText(answered) };
    }

    const existing = this.db.subtasks.listRound(taskId, round);
    if (existing.length > 0) {
      const stored = await session.getMessage(roundAckMessageId(taskId, round));
      const reply = stored ? sessionText(stored) : policy.copy.recoveredReply;
      if (!stored) {
        // Unreachable: the ack is appended before the rows are persisted. Warn
        // and deliver a neutral acknowledgement rather than poisoning a Task
        // whose subtasks are valid and ready to run.
        console.warn("[agent] round ack missing on recovery", {
          taskId,
          round
        });
      }
      await channel?.working(reply, `ack:${round}`);
      return { status: "delegated", reply, subtasks: existing };
    }

    const metadata: AiGatewayMetadata = { taskId, round };
    const outcome = await runTurn({
      session,
      taskId,
      round,
      text,
      mode,
      finalReason,
      budget,
      systemSuffix: this.callerContext(identity),
      tools: await this.mainAgentTools(session),
      models: this.modelPair(metadata),
      branches: this.compositionBranches(taskId),
      observations: this.db.observations.recent(
        taskId,
        round,
        this.config.roundObservationWindow
      ),
      toolOutputWindow: this.config.toolOutputWindow,
      types: this.runtime.types,
      maxSubtasks: this.config.maxSubtasks,
      maxOutputTokens: this.config.model.maxOutputTokens,
      maxRetries: this.config.model.maxRetries,
      instructions: this.instructions,
      partialNote: policy.copy.partialNote,
      // The key carries the round so two rounds of one Task cannot collide on
      // the gatekeeper, which a bare step index would.
      onContent: channel?.stream((step) => `r${round}:step:${step}`)
    });
    // Terminal for this round with nothing to persist — the kind rides out with
    // it, and the Workflow turns it into words.
    if (outcome.status === "failed") return outcome;

    // Cancelled while the model worked: persist nothing and publish nothing. The
    // turns stay charged — the model ran, whatever became of its output.
    if (await this.isTaskCanceled(taskId)) return { status: "canceled" };

    if (outcome.status === "replied") {
      return { status: "replied", reply: outcome.reply };
    }

    // The ack is durable in the Session before the rows exist. A crash in this
    // window re-runs the round and persists the *retry's* drafts under the
    // *first* attempt's ack — both are valid outputs of the same input, and no
    // invariant breaks. The reverse order could strand persisted subtasks with no
    // recoverable acknowledgment.
    const subtasks = this.db.subtasks.createDecomposition(
      taskId,
      round,
      outcome.drafts
    );
    // What this round saw, for the rounds after it. Written beside the rows and
    // after them: a crash between the two costs the next round its evidence,
    // which degrades it to the behaviour it had before observations existed —
    // where losing the rows would strand a delegation nothing will ever run.
    this.db.observations.put(taskId, round, outcome.observations);
    await channel?.working(outcome.reply, `ack:${round}`);
    return { status: "delegated", reply: outcome.reply, subtasks };
  }

  /**
   * Every round's branches for a Task, in stable ordinal order — what a round
   * needs to reunite each earlier `delegate` call with its result. Built inside
   * the DO and consumed here, so the 1 MiB Workflow-step cap that keeps
   * {@link SubtaskScan} down to ids does not apply.
   */
  private compositionBranches(taskId: string): CompositionBranch[] {
    return this.db.subtasks.list(taskId).map((s) => ({
      subtaskId: s.id,
      round: s.round,
      ordinal: s.ordinal,
      type: s.type,
      prompt: s.prompt,
      params: s.params,
      status: s.status,
      resultParts: s.resultParts,
      error: s.error
    }));
  }

  /** A Task's Subtasks, every round, in stable ordinal order. */
  async listSubtasks(taskId: string): Promise<Subtask[]> {
    return this.db.subtasks.list(taskId);
  }

  /**
   * The Workflow's scan for **one round's** Subtasks: report a cancellation, or
   * return the ids that still owe an outcome, in ordinal order.
   *
   * Scoped to the round because the Workflow drives one round at a time: an
   * earlier round's rows are already terminal and would only widen a projection
   * that has a size cap.
   *
   * `running` counts alongside `pending` on purpose. `executeSubtaskChunk`
   * accepts a row that is either: the latter is its ambiguous-retry path, where a
   * previous attempt crashed mid-execution and the managed child's fingerprint
   * cache may still hold the terminal result that makes the retry free. So a row
   * stranded `running` is re-runnable, and omitting it here would abandon it.
   *
   * Ordinal order comes from {@link listRound} and is not incidental: these ids
   * become durable Workflow step names, so the traversal that produces them has
   * to be deterministic.
   *
   * The cancellation verdict rides along rather than being probed separately, so
   * the scan costs one round trip and cannot act on a stale answer.
   */
  async scanSubtasks(taskId: string, round: number): Promise<SubtaskScan> {
    if (await this.isTaskCanceled(taskId)) return { canceled: true };
    const ids = this.db.subtasks
      .listRound(taskId, round)
      .filter((s) => s.status === "pending" || s.status === "running")
      .map((s) => s.id);
    return { canceled: false, ids };
  }

  /**
   * How one delegating round turned out, as the loop compares it against the
   * round before: one `type: error` line per branch, in ordinal order.
   *
   * **Empty unless every branch failed**, which is what makes this a no-progress
   * measure rather than a failure count. A round that completed anything moved
   * the Task forward whatever else went wrong beside it, and stopping a Task that
   * is producing work is worse than the loop it would prevent.
   *
   * Errors, not ids or prompts: the same wall reached twice is the signal, and a
   * Subtask's id differs every round by construction. The text is a facet's own
   * sentence about what it hit — already model-visible through
   * `delegateCallOutput` — so nothing here is disclosed that the round did not
   * already read. It is only ever compared; the words the user sees are the
   * model's. Bounded per line: see {@link FAILURE_EXCERPT_CHARS}.
   */
  async roundFailures(taskId: string, round: number): Promise<string[]> {
    const rows = this.db.subtasks.listRound(taskId, round);
    if (rows.length === 0) return [];
    if (!rows.every((s) => s.status === "failed")) return [];
    return rows.map(
      (s) => `${s.type}: ${(s.error ?? "").slice(0, FAILURE_EXCERPT_CHARS)}`
    );
  }

  /** Parent cancellation: cancel every still-pending Subtask. Returns the count. */
  async cancelPendingSubtasks(taskId: string): Promise<number> {
    return this.db.subtasks.cancelPending(taskId);
  }

  /**
   * Force one branch terminal after the Workflow gave up on it: its
   * `execute:<id>` step exhausted every retry, so `executeSubtaskChunk` will not
   * be called again and no one else will resolve the row.
   *
   * The Workflow fails the *branch* rather than the Task so composition can
   * disclose the gap while sibling branches keep their durable results. The
   * managed child releases its external state and is then swept, both
   * best-effort — nothing will read its cache now, but an abandoned run may still
   * hold something outside this system, and dropping the child is not a reason to
   * leak it. Idempotent: a no-op once the row is terminal.
   */
  async failSubtask(id: SubtaskId, error: string): Promise<void> {
    const subtask = this.db.subtasks.get(id);
    if (!subtask) return;
    // `fail` is a guarded `running|pending -> failed`, and **its verdict is the
    // whole idempotency claim above** — read it before tearing anything down. A
    // late workflow failure that lost the race to a real result would otherwise
    // still release the branch's runtime, abort its child and delete it, tearing
    // down a branch that had already succeeded.
    //
    // Cleanup for an already-terminal row belongs to `sweepTaskChildren`, which
    // runs after delivery and knows the whole task is done with — the same
    // teardown `executeSubtaskChunk` defers on its success path, because
    // aborting a facet in the same tick its RPC returned makes telemetry record
    // the success as a failure.
    if (!this.db.subtasks.fail(id, error)) return;
    const name = subagentName(subtask.taskId, id);
    await this.releaseRuntimeQuietly(subtask);
    await this.abortChildQuietly(name, this.toolFamiliesForType(subtask.type));
    await this.deleteChildQuietly(name);
  }

  /**
   * Run **one durable chunk** of a Subtask in an isolated, managed subagent,
   * posting any progress the chunk emitted and durably recording a terminal
   * outcome.
   *
   * The Workflow calls this repeatedly (chunk 0, 1, …) until it returns
   * `done: true` — a single-chunk recipe finishes on chunk 0, a long one spans
   * many. The row status distinguishes the cases with no chunk-number bookkeeping:
   * chunk 0 claims `pending → running` (fresh — delete any stale child); every
   * later chunk (and every retry) finds the row already `running` and leaves the
   * child alone so its checkpointed run state resumes.
   *
   * The lifecycle rules that make it safe to re-run:
   *
   * - A terminal row short-circuits: the result is already durable.
   * - A **fresh** execution deletes any stale child first.
   * - An **ambiguous retry** (row already `running`) must *not* delete the child.
   * - A **successful** chunk does *not* delete its child here — deletion is
   *   deferred to a single post-delivery {@link sweepTaskChildren}, so a facet is
   *   never aborted in the same tick its RPC returned (telemetry would mis-record
   *   that as a failure). The result is still copied into the parent before any
   *   delete; that now happens strictly later.
   *
   * Throws on a transient fault (the step retries and the child resumes from its
   * checkpoint) and when the row is in a status this cannot accept — a subtask
   * that is neither `pending` nor `running` nor already terminal. Both are bugs,
   * not outcomes.
   */
  async executeSubtaskChunk(
    id: SubtaskId,
    chunk: number,
    push?: TurnPushContext
  ): Promise<SubtaskChunkOutcome> {
    // Recorded here rather than left to `this.push(push)` below, which runs only
    // after the chunk has already executed — and the child is handed this
    // origin on the way in.
    this.noteSelfOrigin(push?.jku);
    const prepared = await this.prepareChunk(id);
    if (prepared.kind === "terminal") {
      return { done: true, status: prepared.subtask.status, progress: [] };
    }
    const { request, recipe, name, runtime } = prepared;

    const outcome = await this.executeChunkInChild(
      name,
      request,
      chunk,
      runtime
    );

    // The Task may have been canceled while the chunk ran — checked *before* any
    // progress is published, so a canceled Task emits nothing further. Applies to
    // a yield as much as to a terminal chunk: a run interrupted mid-flight by
    // cancellation yields rather than caching a bogus failure.
    if (await this.isTaskCanceled(request.taskId)) {
      this.db.subtasks.cancelRunning(id);
      await this.releaseRuntime(request);
      await this.abortChildQuietly(name, recipe.toolFamilies);
      await this.deleteChildQuietly(name);
      return {
        done: true,
        status: this.requireSubtask(id).status,
        progress: outcome.progress
      };
    }

    // Post progress the chunk emitted (best-effort; `working` never throws).
    // Deterministic keys let the gatekeeper dedupe a re-posted event on replay.
    if (push) {
      const channel = this.push(push);
      for (const event of outcome.progress) {
        await channel.working(event.text, event.key);
      }
    }

    if (!outcome.done) {
      return { done: false, status: "running", progress: outcome.progress };
    }

    // Let the owning plugin amend the terminal result before it is persisted —
    // e.g. append a score the subagent had no way to read. Returning the result
    // unchanged is always valid, and a plugin that declares no hook gets this for
    // free.
    const result = await this.runtime.enrichResult(
      { request, runtime },
      outcome.result
    );
    const persisted = this.persistResult(id, result);
    if (!persisted) {
      const current = this.requireSubtask(id);
      if (current.status === "pending" || current.status === "running") {
        throw new Error(
          `subtask ${id} could not record its result (status=${current.status})`
        );
      }
      await this.deleteChildQuietly(name);
      return { done: true, status: current.status, progress: outcome.progress };
    }

    // The result is durable in the parent now, but the child is **not** deleted
    // here. `deleteSubAgent` aborts the facet, and aborting it in the same tick
    // this `executeChunk` RPC returned stamps that already-successful invocation
    // `outcome:exception` in telemetry — a false-positive error on every
    // completed Subtask. The parent sweeps all of a Task's children once, after
    // delivery, when every `execute` step has unwound.
    return {
      done: true,
      status: this.requireSubtask(id).status,
      progress: outcome.progress
    };
  }

  /**
   * Delete every managed child this Task created — called **once**, from the
   * Workflow's delivery step, after the Task is terminal.
   *
   * Per-Subtask deletion is deferred to here rather than run right after each
   * successful chunk because `deleteSubAgent` aborts the facet: aborting a child
   * in the same tick its `executeChunk` RPC returned records that
   * already-successful invocation as `outcome:exception`, which is pure
   * false-positive error noise (one per completed Subtask). By delivery every
   * `execute` step has unwound, so these deletes hit **idle** facets and record
   * nothing. Best-effort and idempotent — a name with no live facet is a silent
   * no-op — so a Workflow replay of the sweep step is safe.
   *
   * Cancellation paths do their own child cleanup, so a canceled Task that never
   * reaches delivery does not leak.
   */
  async sweepTaskChildren(taskId: string): Promise<void> {
    for (const subtask of this.db.subtasks.list(taskId)) {
      await this.deleteChildQuietly(subagentName(taskId, subtask.id));
    }
  }

  /**
   * The shared front half of a chunk: resolve terminal/cancel short-circuits,
   * validate the Recipe, claim the row (fresh-vs-retry), and assemble the
   * execution request. Deterministic every chunk, so the request — and thus its
   * fingerprint — is identical across a run's chunks and their retries.
   */
  private async prepareChunk(id: SubtaskId): Promise<
    | { kind: "terminal"; subtask: Subtask }
    | {
        kind: "ready";
        request: RecipeExecutionRequest;
        recipe: ResolvedRecipe;
        name: string;
        runtime: SubtaskRuntime;
      }
  > {
    const subtask = this.db.subtasks.get(id);
    if (!subtask) throw new Error(`unknown subtask: ${id}`);
    const name = subagentName(subtask.taskId, id);

    if (subtask.status !== "pending" && subtask.status !== "running") {
      // Already terminal. Sweep the child in case a previous run persisted the
      // result and crashed before deleting it.
      await this.deleteChildQuietly(name);
      return { kind: "terminal", subtask };
    }

    if (await this.isTaskCanceled(subtask.taskId)) {
      // Start no new work. A row left `running` by a crashed attempt is resolved
      // here — `cancelPending` only reaches pending rows.
      if (subtask.status === "running") {
        this.db.subtasks.cancelRunning(id);
        await this.releaseRuntimeQuietly(subtask);
        await this.abortChildQuietly(
          name,
          this.toolFamiliesForType(subtask.type)
        );
        await this.deleteChildQuietly(name);
        return { kind: "terminal", subtask: this.requireSubtask(id) };
      }
      return { kind: "terminal", subtask };
    }

    let recipe: ResolvedRecipe | undefined;
    let validated;
    try {
      recipe = this.runtime.types.resolveRecipe(subtask.type);
      validated = validateRecipe(recipe, this.runtime.policy);
    } catch (err) {
      // An unknown/retired type or a disabled/soul-less Recipe is a
      // configuration bug, not a transient fault. Record it as a branch failure
      // so a later round can disclose the gap, rather than as a throw that would
      // be retried forever.
      const recipeId = recipe?.key ?? subtask.type;
      const recipeVersion = recipe?.version ?? 0;
      const message = recipe
        ? `recipe ${recipeId} unusable: ${String(err)}`
        : `unknown subtask type "${subtask.type}": ${String(err)}`;
      this.db.subtasks.start(id, { recipeId, recipeVersion });
      this.db.subtasks.fail(id, message);
      return { kind: "terminal", subtask: this.requireSubtask(id) };
    }

    // Claim the row. Winning the `pending → running` transition distinguishes a
    // fresh execution (chunk 0) from a retry/continuation — the difference that
    // decides whether the child may be deleted.
    const claimed = this.db.subtasks.start(id, {
      recipeId: validated.key,
      recipeVersion: validated.version
    });

    if (claimed) {
      await this.deleteChildQuietly(name);
    } else {
      const current = this.requireSubtask(id);
      if (current.status !== "running") {
        return { kind: "terminal", subtask: current };
      }
      // Ambiguous retry / later chunk: leave the child so its run state resumes.
    }

    const request: RecipeExecutionRequest = {
      taskId: subtask.taskId,
      subtaskId: id,
      type: subtask.type,
      recipe: validated,
      prompt: subtask.prompt,
      references: subtask.references,
      params: subtask.params
    };
    return {
      kind: "ready",
      request,
      recipe: validated,
      name,
      // Resolve the session state this execution needs and no model can supply —
      // a leased external resource, a session handle, a cookie jar — by asking
      // the plugin that owns the type. `{}` for a type whose plugin declares no
      // `resolveRuntime`, which is most of them.
      //
      // Called once per **chunk**, not once per run, and deliberately outside the
      // fingerprint: what it returns can legitimately change between two chunks
      // of one run, and must not make a retry look like different work.
      runtime: await this.runtime.resolveRuntime({
        taskId: subtask.taskId,
        subtaskId: id,
        type: subtask.type,
        params: subtask.params,
        toolFamilies: validated.toolFamilies
      })
    };
  }

  /**
   * Invoke the managed child for one chunk, recreating it once on a fingerprint
   * mismatch (a stale child from a *different* request — recoverable exactly once;
   * a second mismatch is a genuine lifecycle bug and must surface).
   */
  private async executeChunkInChild(
    name: string,
    request: RecipeExecutionRequest,
    chunk: number,
    runtime: SubtaskRuntime
  ): Promise<RecipeChunkResult> {
    // A facet has no request path of its own: it is reached only from here, so
    // this is the only way it can learn what this deployment is called. Passed
    // as its own argument, never folded into `request`, for the same reason
    // `chunk` is — the request is fingerprinted, and this is not part of what
    // the execution *is*, so it must not be able to make a retry look like a
    // different one. Pinned on both sides, so it cannot change under a run;
    // undefined only on an instance no turn has reached, where the facet's own
    // `requireSelfOrigin` produces the readable error.
    const selfOrigin = this.selfOrigin();
    const child = await this.subAgent(this.subagentClass(), name);
    try {
      return await child.executeChunk(request, chunk, runtime, selfOrigin);
    } catch (err) {
      if (!String(err).includes(FINGERPRINT_MISMATCH)) throw err;
      console.warn("[agent] stale subagent state, recreating", { name });
      await this.deleteSubAgent(this.subagentClass(), name);
      const fresh = await this.subAgent(this.subagentClass(), name);
      return await fresh.executeChunk(request, chunk, runtime, selfOrigin);
    }
  }

  /** Let the owning plugin release whatever `resolveRuntime` acquired. */
  private releaseRuntime(request: RecipeExecutionRequest): Promise<void> {
    return this.runtime.onAbort({
      taskId: request.taskId,
      subtaskId: request.subtaskId,
      type: request.type,
      params: request.params,
      toolFamilies: request.recipe.toolFamilies
    });
  }

  /** The same, from a durable row rather than a built request. Best-effort. */
  private async releaseRuntimeQuietly(subtask: Subtask): Promise<void> {
    try {
      await this.runtime.onAbort({
        taskId: subtask.taskId,
        subtaskId: subtask.id,
        type: subtask.type,
        params: subtask.params,
        toolFamilies: this.toolFamiliesForType(subtask.type)
      });
    } catch (err) {
      console.warn("[agent] plugin runtime release failed", {
        subtaskId: subtask.id,
        err: String(err)
      });
    }
  }

  /** The validated tool families for a Subtask type, or none if unusable. */
  private toolFamiliesForType(type: string): string[] {
    try {
      return validateRecipe(
        this.runtime.types.resolveRecipe(type),
        this.runtime.policy
      ).toolFamilies;
    } catch {
      return [];
    }
  }

  /**
   * Best-effort release of a child's external state on cancellation (e.g. close a
   * leased resource recorded in its workspace). Swallows failures — an unreleased
   * resource is a documented residual, not a reason to fail cancellation.
   */
  private async abortChildQuietly(
    name: string,
    toolFamilies: string[]
  ): Promise<void> {
    if (toolFamilies.length === 0) return;
    try {
      const child = await this.subAgent(this.subagentClass(), name);
      await child.abortExecution(toolFamilies);
    } catch (err) {
      console.warn("[agent] subagent abort failed", { name, err: String(err) });
    }
  }

  /** Persist a child's terminal outcome. Returns whether the guarded write applied. */
  private persistResult(id: SubtaskId, result: RecipeExecutionResult): boolean {
    if (result.status === "failed") {
      return this.db.subtasks.fail(id, result.error);
    }
    try {
      return this.db.subtasks.complete(id, result.resultParts);
    } catch (err) {
      // A "completed" result with no usable text breaks the child's contract.
      // Record it as a failure — retrying would only replay the same bad result
      // from the child's cache forever.
      console.warn("[agent] malformed completed result", {
        subtaskId: id,
        err: String(err)
      });
      return this.db.subtasks.fail(id, `malformed result: ${String(err)}`);
    }
  }

  /** Re-read a Subtask that must exist (it was just written). */
  private requireSubtask(id: SubtaskId): Subtask {
    const row = this.db.subtasks.get(id);
    if (!row) throw new Error(`subtask ${id} disappeared`);
    return row;
  }

  /** Delete a managed child, swallowing failures (used on best-effort sweeps). */
  private async deleteChildQuietly(name: string): Promise<void> {
    try {
      await this.deleteSubAgent(this.subagentClass(), name);
    } catch (err) {
      console.warn("[agent] subagent cleanup failed", {
        name,
        err: String(err)
      });
    }
  }

  /** Whether the parent Task has been canceled (checked before and after work). */
  private async isTaskCanceled(taskId: string): Promise<boolean> {
    const task = this.db.tasks.get(taskId);
    return task !== null && stateOf(task) === TaskState.TASK_STATE_CANCELED;
  }

  /**
   * Interrupt a canceled Task's live children: each `running` Subtask's managed
   * child gets `abortRun`, so a long recipe stops at its current model call
   * instead of at the next chunk boundary (up to `chunkSoftMs` later). A subtask
   * that already finished (e.g. one branch completed while another was
   * still running) is deliberately retained until the terminal-delivery sweep —
   * but a canceled Task never reaches delivery, so its idle child is deleted
   * here instead, or it would leak until the 30-day row cleanup regardless of
   * that row's own age.
   *
   * Only `running` rows have a live RPC to abort. `subAgent` *creates* a facet
   * that does not exist, so calling it for a `pending` row (no facet was ever
   * made) would materialize one just to delete it — `deleteChildQuietly` is a
   * silent no-op there, so it is called unconditionally instead of branching on
   * status. Bounded by `maxSubtasks`. Best-effort throughout: a child that
   * cannot be reached is logged, never fatal — cancellation must not fail
   * because cleanup did.
   *
   * The `pending` rows are transitioned here too, and that is not bookkeeping:
   * it is the only thing that resolves them. Nothing else is coming back to a
   * pending row once a Task is canceled — the Workflow's scheduler runs a
   * single pass and does not re-scan, and `prepareChunk` reports a canceled
   * Task's pending row as terminal *without* claiming it, so a branch whose RPC
   * had not yet reached the claim when the cancellation landed simply returns.
   * Left to the loop below, which only deletes the child, the row would sit
   * non-terminal until the 30-day cleanup.
   */
  protected override async onTaskCanceled(taskId: string): Promise<void> {
    // First, and outside the loop: `cancelPending` is one guarded bulk
    // `pending -> canceled`, so it cannot be skipped by a best-effort teardown
    // below throwing partway through, and a branch that won the claim a moment
    // ago is left alone to resolve through `cancelRunning` on its own path.
    this.db.subtasks.cancelPending(taskId);

    for (const subtask of this.db.subtasks.list(taskId)) {
      const name = subagentName(taskId, subtask.id);
      if (subtask.status !== "running") {
        await this.deleteChildQuietly(name);
        continue;
      }
      try {
        const child = await this.subAgent(this.subagentClass(), name);
        // `false` means there was no in-flight RPC to interrupt. That is not the
        // "nothing to do" case it looks like: a `running` row whose isolate was
        // evicted or crashed has no live promise, so nobody is coming back to
        // transition it. The chunk path resolves a running row when its result
        // returns; here the result never will.
        //
        // Left alone, the row stays `running` until the 30-day sweep, and — the
        // part that actually costs something — its child facet is never aborted
        // or deleted, so whatever external state the recipe's `abort` hook would
        // have released stays held. Finish the transition and run the same
        // cleanup the post-chunk cancellation path does.
        if (await child.abortRun()) continue;
        if (this.db.subtasks.cancelRunning(subtask.id)) {
          await this.releaseRuntimeQuietly(subtask);
          await this.abortChildQuietly(
            name,
            this.toolFamiliesForType(subtask.type)
          );
          await this.deleteChildQuietly(name);
        }
      } catch (err) {
        console.warn("[agent] subagent abortRun failed", {
          name,
          err: String(err)
        });
      }
    }
  }
}
