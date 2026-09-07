import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import {
  CHUNK_STEP,
  MAX_CHUNKS_PER_BRANCH,
  STEP_TIMEOUT_MS
} from "../platform.js";
import type { CoreConfig } from "../config.js";
import { buildCompletedTask, buildFailedTask } from "../a2a/notify.js";
import type { TurnPushContext } from "../a2a/push.js";
import { deliverAbandonedTask, deliverTerminalTask } from "../a2a/deliver.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import type { RoundFailureKind } from "../agent/inference.js";
import type { SubtaskId } from "../subtasks/types.js";
import type { RoundAgentBase } from "./agent.js";
import type { FinalRoundReason, RoundPolicy } from "./policy.js";
import type { RoundMode } from "./turn.js";

/**
 * The async task controller. The gatekeeper does not wait for a synchronous reply:
 * the Worker accepts a turn (returns a `submitted` Task) and hands the actual work
 * to this durable Workflow, which orchestrates it end to end and delivers the
 * reply to the gatekeeper's push-notification webhook.
 *
 * The shape is a **round loop**, not a fixed sequence of phases:
 *
 * 0. **Pre-work** — resolve the caller's agent, mark the Task working.
 * 1. **Round** — one main-agent inference that either answers the user (the Task
 *    is done) or delegates durable Subtasks plus the acknowledgment the user sees
 *    while they run.
 * 2. **Execute** — a delegating round's Subtasks all run at once, each in an
 *    isolated managed subagent. Then the loop returns to 1, where the model sees
 *    the results and decides again — answer, or delegate once more. Sequencing
 *    lives here, in the loop, not inside a round.
 * 3. **Deliver** — persist the terminal Task, then POST a signed callback.
 *
 * The main agent is never forced either way. A round the loop has stopped — out of
 * budget (`mainAgentLimits`, in turns or in wall clock) or out of progress
 * ({@link NO_PROGRESS_ROUNDS}) — is handed no tools but the answer, so it has to
 * give one; every other round chooses. That is the whole reason this is a loop,
 * and the whole termination argument. Both stops end in the model's own words:
 * the failure copy is for a round that could not answer, never for one the loop
 * decided to end.
 *
 * Why a Workflow (not a DO alarm or `waitUntil`): `step.do(...)` gives durable,
 * independently-retried steps that survive isolate eviction, and a future
 * `escalate` decision (ask the human, then continue) slots in cleanly as another
 * branch of the loop built on `step.waitForEvent(...)`.
 *
 * A Workflow is a separate entrypoint and cannot touch the agent DO's SQLite
 * directly, so: the task inputs travel as the workflow **payload**, and the agent
 * runtime plus task state are reached only through **native DO RPC**.
 *
 * Idempotency: the instance id is derived from the gatekeeper's `messageId`
 * (deterministic across dispatch retries), so a re-dispatch never starts a second
 * run. Within a run, every step is re-runnable: the Subtask rows and the Session
 * are the source of truth, and each round recovers from them rather than
 * re-inferring.
 */
export interface HandleTaskParams {
  /** The accepted task id (echoed back to the gatekeeper on the callback). */
  taskId: string;
  /** The user turn text to answer. */
  text: string;
  /** The verified calling gatekeeper-agent identity (keys the DO + the Session). */
  identity: GatekeeperIdentity;
  /** A2A context id, echoed on the completed Task. */
  contextId: string;
  /** Gatekeeper push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gatekeeper set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

/**
 * What distinguishes one agent's use of this loop from another's.
 *
 * The whole body below is agent-agnostic — it names no soul, no plugin and no
 * model. Two delegating agents differ only in these values, which is why they
 * share one workflow body behind two thin entrypoints rather than two copies of a
 * 250-line orchestration.
 */
export interface HandleTaskDeps {
  /**
   * Route to the right DO class for the verified caller.
   *
   * Called **once per step body**, not once per run, so it must stay a cheap
   * pure lookup — a namespace `get`, nothing cached and nothing awaited. See
   * {@link ResolveAgent} for why the result must never be hoisted.
   */
  resolveAgent: (identity: GatekeeperIdentity) => AgentStub;
  /** Resolved config — the loop reads `mainAgentLimits` and `maxSubtasks`. */
  config: CoreConfig;
  /** The user-facing copy. Only `copy.taskFailed` is read out here. */
  policy: RoundPolicy;
  /**
   * Terminal copy for a round that produced no answer, by {@link
   * RoundFailureKind} — an expired credential, models that could not do it, and
   * whatever that union grows to cover.
   *
   * A hook rather than more `RoundPolicy` copy, because the useful words are
   * deployment-specific ("run `claude setup-token`, then
   * `wrangler secret put …`") and most agents cannot hit these conditions at
   * all. Returning `undefined` — or omitting this — falls back to
   * `policy.copy.taskFailed`, so an agent that does not care changes nothing,
   * and one that only cares about *some* kinds answers for those alone.
   *
   * Core still owns the delivery: this supplies only the message, so the
   * guarded write that doubles as the cancellation check stays in one place.
   */
  failureCopy?: (kind: RoundFailureKind, detail: string) => string | undefined;
  /**
   * The deployment's Ed25519 private JWK, for the terminal callback. Passed
   * rather than read off a module-scope `env` so this stays a pure function of
   * its arguments — and so a Worker whose secret is named something else works
   * with no change here.
   */
  signingKey: string;
  /**
   * Log prefix for the abandoned-task line, conventionally the agent's tenant
   * id. Optional because nothing here needs it to work — but a deployment that
   * mounts several agents on one Worker gets one log stream, and without this
   * every one of them reports going quiet under the same name.
   */
  label?: string;
}

/**
 * The caller's agent DO stub — every phase runs through it.
 *
 * Typed on the abstract base rather than a concrete class: the orchestration
 * below calls only methods the base declares, and every delegating agent's stub
 * satisfies it.
 */
type AgentStub = DurableObjectStub<RoundAgentBase>;

/**
 * Get a **fresh** stub. Called inside a step body, never hoisted above one.
 *
 * A Durable Object stub is not a durable address, it is a live connection, and a
 * broken one stays broken: once the runtime severs it — a deploy replacing the
 * object's code is the ordinary way — every later call on that same stub rejects
 * immediately with the reason it broke, forever. It never reconnects. Only a new
 * stub from the namespace does.
 *
 * A Workflow is exactly where that matters, because it is the one caller that
 * outlives the object it is calling. A hoisted stub survives as a closure
 * variable across every step and every retry, so a single eviction poisons the
 * whole run: each retry re-enters the body, calls the same dead connection, and
 * fails in microseconds no matter how long the backoff waited. The retries look
 * like they ran. Nothing ran.
 *
 * That is not hypothetical — it cost a task in production. A deploy landed three
 * minutes before a turn; the object was collected 43 seconds into
 * `executeSubtaskChunk`; the five retries that followed each failed in under
 * 10ms across 160 seconds of backoff, and then `fail:<id>` — the handler meant to
 * salvage the branch — failed six more times on the same dead stub. The Subtask
 * never reached a terminal row, `deliver` was never reached, and the gatekeeper got
 * no callback at all. Not a failure message. Silence.
 *
 * Resolving per step body costs a namespace lookup and an object allocation, and
 * buys back the property the retries were supposed to have. `DurableTaskStore`
 * already resolves this way for the same reason.
 */
type ResolveAgent = () => AgentStub;

/**
 * The same retries, and a timeout a **round** can actually be measured against.
 *
 * A chunk and a round are bounded by different things, and sharing one constant
 * hid that. A chunk has {@link CHUNK_SOFT_MS}: it checkpoints and hands back a
 * fresh step, so `STEP_TIMEOUT_MS` is a ceiling it is sized to stay under. A
 * round has no soft deadline at all — `runTurn` runs up to
 * `mainAgentLimits.maxTurns` sequential model-plus-tool steps in one
 * `generateText`, and its only bound is that step count. Twenty turns whose
 * tools each take the {@link file://../platform.ts MAX_TOOL_CALL_MS} they are
 * permitted is hours, not half an hour, so a perfectly legal round could be
 * killed and replayed whole.
 *
 * So the ceiling comes from the agent's own patience: a round cannot usefully
 * outlive the wall clock its Task is allowed, because the `deadline:` step fails
 * the Task at that point anyway. Floored at `STEP_TIMEOUT_MS` so a deliberately
 * tight `maxWallMs` cannot produce a step timeout shorter than the single tool
 * call core tells hosts they may install.
 *
 * This remains a backstop against a hang, not a budget. What actually bounds
 * what a round *spends* is `TurnBudget`, and what bounds the Task is
 * `mainAgentLimits` — both of which are checked whatever this says.
 */
function turnStep(config: CoreConfig): WorkflowStepConfig {
  return {
    ...CHUNK_STEP,
    timeout: Math.max(config.mainAgentLimits.maxWallMs, STEP_TIMEOUT_MS)
  };
}

/**
 * The orchestration, split from the `WorkflowEntrypoint` wiring so it can be
 * driven with a fake `step` in tests (workerd forbids constructing a
 * `WorkflowEntrypoint` outside the runtime) — and so a second agent can reuse it
 * with different deps.
 *
 * ## What the wrapper adds, and why it is not the host's job
 *
 * Core distinguishes two ways a turn ends badly. A **typed** failure is a value
 * and {@link deliver} carries it. A **transient** fault throws, so the step
 * retries and recovers from the durable rows without paying for a second
 * inference. Neither covers a transient fault that never stops being one: the
 * step exhausts its retries, {@link orchestrate} unwinds, the delivery below is
 * never reached, and the instance errors with the Task still in `working` — the
 * user told nothing, and the runtime recording a hang. See
 * {@link deliverAbandonedTask}, which was written for a deployed agent that did
 * exactly this on 2026-08-19.
 *
 * This is caught **here** rather than left to each `WorkflowEntrypoint` because
 * everything the recovery needs is already in {@link HandleTaskDeps}: the stub
 * (typed on `RoundAgentBase`, so `saveTask` and `sweepTaskChildren` are both
 * reachable), `policy.copy.taskFailed`, and `signingKey`. A host has nothing to
 * add — so asking it to remember buys nothing and costs exactly what it cost the
 * starter, where three of four agents never wrote the `catch` at all.
 */
export async function runHandleTask(
  p: HandleTaskParams,
  step: WorkflowStep,
  deps: HandleTaskDeps
): Promise<void> {
  try {
    await orchestrate(p, step, deps);
  } catch (cause) {
    // Everything this needs is already in `deps` — which is the argument for it
    // living here rather than in each host's `catch`. Four agents in the starter
    // called this function and only one had written that `catch`; the other three
    // carried the 2026-08-19 failure silently. A guard nobody can forget is worth
    // more than a helper everybody must remember.
    await deliverAbandonedTask(step, cause, {
      push: {
        taskId: p.taskId,
        contextId: p.contextId,
        pushUrl: p.pushUrl,
        pushToken: p.pushToken,
        jku: p.jku
      },
      signingKey: deps.signingKey,
      // Resolved inside each closure, never hoisted — see {@link ResolveAgent}.
      saveTask: (task) => deps.resolveAgent(p.identity).saveTask(task),
      // The round never got far enough to say *which* credential or model was at
      // fault, so `failureCopy` has nothing to answer and the policy's own words
      // are the honest ones. The diagnostic is logged instead.
      text: deps.policy.copy.taskFailed,
      sweep: async () => {
        await deps.resolveAgent(p.identity).sweepTaskChildren(p.taskId);
      },
      label: deps.label
    });
  }
}

/**
 * Turns an `open` round needs before it is worth opening: one to spend on a work
 * tool, one to reach the control call that ends the round.
 *
 * A round is bounded by a step count and ends **only** on a control call, so a
 * round handed a single turn dies on that counter the moment it looks anything
 * up — no ending, no answer, and the fallback slot's one-step floor fails the
 * same way behind it. Not hypothetical: it is how a task spent the 60th call of
 * its 60-turn budget on a `repo_clone`, failed with `round produced no
 * decision`, and delivered the generic failure copy — having walked straight
 * past the forced-answer path that exists for exactly this ceiling.
 *
 * So the last turn is reserved for the answer rather than offered to a round
 * that cannot use it. {@link file://./turn.ts turn.ts} holds the same rule per
 * *attempt*, which is the half this one cannot reach: a primary that burns the
 * whole allowance leaves the fallback a single step no matter what was decided
 * here.
 */
const MIN_OPEN_ROUND_TURNS = 2;

/**
 * Rounds that may fail identically in a row before the loop stops delegating.
 *
 * The third bound on a Task, and the only one that measures *progress* rather
 * than spend. `maxTurns` and `maxWallMs` bound what a Task may consume, and a
 * Task consuming its budget on the same failing delegation over and over is
 * inside both of them the whole way: the run this exists for delegated the same
 * subtask thirteen times over twelve minutes — thirteen near-identical messages
 * to the user, each one claiming work was underway — against a three-hour wall
 * clock it never came close to, and ended on the turn budget by accident.
 *
 * "Identical" is meant strictly, and that is what keeps this from stopping work
 * that was going somewhere: every branch of the round failed, and the failures
 * match the previous round's line for line. A round that completed anything, or
 * that failed a different way, resets the count — a model reacting to a new error
 * is a model still working the problem.
 *
 * Three rather than two because a wall can be intermittent and the second look is
 * cheap; four rounds is still an early, honest stop rather than a budget spent.
 */
const NO_PROGRESS_ROUNDS = 3;

/**
 * The orchestration proper — every ordinary outcome ends inside here, and
 * anything that escapes is what {@link runHandleTask} turns into a delivered
 * failure.
 *
 * Every `step.do` return here is a small projection — a status, an id, a reply.
 * Never a Subtask row: a step return is capped at 1 MiB and a Subtask carries
 * verbatim history snapshots, so the rows stay in the DO and the Workflow carries
 * references to them.
 *
 * **Step names are durable cache keys.** Everything inside the round loop carries
 * its round for that reason: `turn:<round>`, `deadline:<round>`, `scan:<round>`,
 * `cancel:<round>`. Renaming one silently re-runs its effect on replay — and the
 * recovery path in {@link runHandleTask} runs under its own prefix for the same
 * reason, so a second delivery cannot be handed this one's cached results.
 */
async function orchestrate(
  p: HandleTaskParams,
  step: WorkflowStep,
  deps: HandleTaskDeps
): Promise<void> {
  const limits = deps.config.mainAgentLimits;
  // Pre-work. Routing is pure, so it needs no step of its own — but it is
  // deliberately *not* resolved here into a value the steps below close over.
  // See {@link ResolveAgent}.
  const agent: ResolveAgent = () => deps.resolveAgent(p.identity);
  const push: TurnPushContext = {
    taskId: p.taskId,
    contextId: p.contextId,
    pushUrl: p.pushUrl,
    pushToken: p.pushToken,
    jku: p.jku
  };

  const started = await step.do(
    "working",
    async () => (await agent().markWorking(p.taskId)) === "ok"
  );
  if (!started) return;

  // Main-agent turns spent so far, across every round. Summed from cached step
  // returns, so a replay reconstructs the identical number and the `mode` input
  // below stays deterministic.
  let turnsUsed = 0;

  // The other input to `mode`: how many rounds in a row came back failing the
  // identical way, and what they said. Accumulated from cached step returns for
  // the same reason `turnsUsed` is — a replay that reconstructed a different
  // count would hand a round a different mode than the one it ran under.
  let repeated = 0;
  let lastFailures = "";

  // The Task's own start, in a step so replays read the original instant rather
  // than restarting the clock — otherwise a Workflow that retried its way through
  // the night would never observe the deadline it had long since passed.
  //
  // When escalation lands, this is the line that needs care: a Task suspended on
  // `step.waitForEvent(...)` must **rebase** it on resume, or a human's thinking
  // time is charged to the agent and a Task that asked a question is dead before
  // the answer arrives. `turnsUsed` needs no such handling — waiting costs none.
  const startedAtMs = await step.do("started", async () => Date.now());

  // At most one round per turn of the budget, **plus one**: an `open` round always
  // spends at least one turn, so `maxTurns` of them exhaust the budget — and the
  // forced-answer round that follows needs an iteration of its own to happen in.
  // Off by one here and a Task of cheap rounds would fall out of the loop with no
  // reply instead of being made to give one.
  for (let round = 0; round <= limits.maxTurns; round++) {
    // The clock is read *inside a step* so its answer is cached with the round:
    // `mode` is a step input, and a replay that re-read `Date.now()` would
    // reconstruct a different one. Time is the budget a Task can spend without
    // spending the other — a round waiting on slow subtasks moves it while
    // `turnsUsed` does not.
    const overdue = await step.do(
      `deadline:${round}`,
      async () => Date.now() - startedAtMs >= limits.maxWallMs
    );

    // Out of turns or out of time ⇒ this round gets no tools at all and must
    // answer. Not a failure mode: it is how a ceiling returns the work instead of
    // dropping it. "Out of turns" is one turn early on purpose — see
    // {@link MIN_OPEN_ROUND_TURNS}.
    const turnsRemaining = limits.maxTurns - turnsUsed;
    const spent = turnsRemaining < MIN_OPEN_ROUND_TURNS || overdue;
    // …and so does a Task that is getting nowhere. Nothing is spent here: what
    // has run out is the evidence that another round would do anything
    // different. See {@link NO_PROGRESS_ROUNDS}.
    const stalled = repeated >= NO_PROGRESS_ROUNDS;
    const mode: RoundMode = spent || stalled ? "final" : "open";
    // Both reasons produce the same round and read to the user completely
    // differently, so the round is told which it is. A budget that ran out while
    // the work was also failing is reported as the budget: it is the harder
    // ceiling and the one that will still be there next round.
    const finalReason: FinalRoundReason | undefined =
      mode === "open" ? undefined : spent ? "budget" : "no-progress";
    if (mode === "final") {
      // Worth its own line either way: from the outside, a round that was forced
      // is indistinguishable from a model that simply chose to answer.
      if (spent) {
        console.warn("[handle-task] task budget spent, forcing an answer", {
          taskId: p.taskId,
          round,
          turnsUsed,
          turnsRemaining,
          overdue
        });
      } else {
        // The line whose absence made an incident take telemetry archaeology.
        // It carries the wall itself, because "which wall" is the first thing
        // anyone reading this will want and the Subtask rows are the only other
        // place it exists.
        console.warn(
          "[handle-task] no progress across rounds, forcing an answer",
          {
            taskId: p.taskId,
            round,
            repeated,
            failures: lastFailures
          }
        );
      }
    }

    // The main agent decides. `runTaskTurn` persists whatever the round produced
    // — a final reply, or the Subtask rows plus the acknowledgment it already
    // pushed — so this step returns only the verdict plus what it cost. A typed
    // `failed` is a real outcome (both models produced unusable output, with no
    // durable work to fall back on) and routes to failed delivery; a transient
    // fault throws and the step retries, recovering from the durable rows with no
    // second inference.
    const turn = await step.do(
      `turn:${round}`,
      turnStep(deps.config),
      async () => {
        // Projected to a plain object: an RPC return carries a `Disposable` brand a
        // step result cannot serialize. Every branch must carry `turns` — a field
        // this projection drops is a field the budget never sees.
        const result = await agent().runTaskTurn({
          taskId: p.taskId,
          text: p.text,
          identity: p.identity,
          round,
          mode,
          finalReason,
          turnsRemaining,
          push
        });
        if (result.status === "replied")
          return {
            status: result.status,
            reply: result.reply,
            turns: result.turns
          };
        if (result.status === "failed")
          return {
            status: result.status,
            kind: result.kind,
            error: result.error,
            turns: result.turns
          };
        return { status: result.status, turns: result.turns };
      }
    );

    turnsUsed += turn.turns;

    if (turn.status === "canceled") return;
    // The round produced no answer. `kind` is the whole difference between the
    // two ways that happens — models that could not do it, versus a fault that
    // stopped the round on its first attempt and that only a human can clear —
    // and it exists to be turned into words the reader can act on. Same
    // delivery either way; the diagnostic is logged, never shown.
    if (turn.status === "failed") {
      console.error("[handle-task] round failed", {
        taskId: p.taskId,
        round,
        kind: turn.kind,
        error: turn.error
      });
      await deliver(p, step, agent, null, deps, {
        kind: turn.kind,
        detail: turn.error
      });
      return;
    }
    if (turn.status === "replied") {
      await deliver(p, step, agent, turn.reply, deps);
      return;
    }

    // Delegated: run this round's Subtasks, then loop and let the model decide
    // again.
    const executed = await executeSubtasks(p, step, agent, round, push);
    if (executed === "canceled") return;

    // What that round actually achieved — the loop's only progress measure, and
    // empty for any round that completed something. Read in a step of its own for
    // the reason the clock is: it feeds `mode`, so a replay has to reconstruct
    // the identical answer rather than re-deriving one from rows that have since
    // moved on.
    const failures = await step.do(`failures:${round}`, () =>
      agent().roundFailures(p.taskId, round)
    );
    const fingerprint = failures.join("\n");
    if (fingerprint === "") repeated = 0;
    else repeated = fingerprint === lastFailures ? repeated + 1 : 1;
    lastFailures = fingerprint;
  }

  // Unreachable: a `final` round is handed only `final_reply`, so it either
  // answers or fails, and both return above. Reaching here means a round
  // delegated with no turns left to do it with.
  console.error("[handle-task] round budget exhausted without a reply", {
    taskId: p.taskId
  });
  await deliver(p, step, agent, null, deps);
}

/**
 * Run every Subtask one round delegated, concurrently, to termination.
 *
 * **One pass is the whole thing.** A round's Subtasks are independent of one
 * another, so they are all runnable the moment they exist, and `runBranch` is
 * contractually obliged to leave its row terminal — it resolves a deterministic
 * failure itself and has a `fail:<id>` backstop once the retries are gone. So
 * there is nothing left to re-scan afterwards, and no way for this to make no
 * progress. Sequencing between units of work is the round loop's job.
 *
 * Both step names carry the round, because step names are durable cache keys: two
 * rounds of the same Task reusing `scan` would replay the first round's cached
 * answer into the second.
 */
async function executeSubtasks(
  p: HandleTaskParams,
  step: WorkflowStep,
  agent: ResolveAgent,
  round: number,
  push: TurnPushContext
): Promise<"done" | "canceled"> {
  // One durable step: `scanSubtasks` reports cancellation and returns the ids
  // still owing an outcome — one round trip, one consistent answer. It writes
  // nothing, so a replay that re-runs it costs only the read.
  const scan = await step.do(`scan:${round}`, async () => {
    const result = await agent().scanSubtasks(p.taskId, round);
    return result.canceled
      ? { canceled: true as const, ids: [] }
      : { canceled: false as const, ids: result.ids };
  });

  if (scan.canceled) {
    await step.do(`cancel:${round}`, async () => {
      await agent().cancelPendingSubtasks(p.taskId);
    });
    return "canceled";
  }

  // Every Subtask runs concurrently — the per-round Subtask maximum is the only
  // fan-out bound. `runBranch` never rejects, so a single branch cannot fast-fail
  // `Promise.all` and strand its siblings' durable results.
  //
  // A cancellation arriving mid-pass is still honored, just not from here:
  // `onTaskCanceled` aborts the live children *and* transitions every row still
  // `pending` in the same sweep, and `executeSubtaskChunk` re-checks before
  // publishing. That transition is what lets this pass end without a second
  // scan. Without it, a branch whose RPC had not yet claimed its row when the
  // cancellation landed would return terminal while leaving the row `pending`,
  // and — since the next round's turn reports `canceled` and the workflow exits
  // — nothing would resolve it before the 30-day cleanup.
  await Promise.all(scan.ids.map((id) => runBranch(p, step, agent, id, push)));
  return "done";
}

/**
 * Run one Subtask to termination as a sequence of durable **chunk** steps, and
 * make sure the row ends terminal either way.
 *
 * `executeSubtaskChunk(id, chunk)` advances one chunk: a single-chunk recipe is
 * `done` on chunk 0 (step `execute:<id>`); a long recipe yields `done: false` and
 * the loop runs the next chunk (`execute:<id>:chunk:<n>`) until it terminates.
 * Each chunk is its own retryable step, and the child resumes from its
 * checkpoint — so no step approaches the {@link CHUNK_STEP} timeout. `CHUNK_SOFT_MS`
 * is what holds that true, and is sized against it rather than the other way
 * round; a boundary here is not free, so it wants to be rare, not frequent.
 *
 * It resolves a deterministic branch failure into a `failed` row itself and
 * throws only on a transient fault (retry me) or a lifecycle bug. So a throw that
 * survives every retry — or a run that never terminates within the chunk budget —
 * means nobody is left to resolve this row: fail *the branch* and let the next
 * round disclose the gap, rather than discarding the durable work its siblings
 * finished.
 *
 * What bounds a branch is its Recipe's turns and wall clock, both enforced inside
 * the child, both ending in a report rather than a kill. `MAX_CHUNKS_PER_BRANCH`
 * is a platform backstop held unreachable by design, so the `failSubtask` below
 * should never fire — if it does, a Recipe has been given more turns than the cap
 * allows.
 *
 * Step ids are unique across rounds (SQLite assigns them), so these names need no
 * round prefix.
 */
async function runBranch(
  p: HandleTaskParams,
  step: WorkflowStep,
  agent: ResolveAgent,
  id: SubtaskId,
  push: TurnPushContext
): Promise<void> {
  try {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_BRANCH; chunk++) {
      // Chunk 0 keeps the plain `execute:<id>` step name so single-chunk branches
      // replay identically; later chunks append `:chunk:<n>`.
      const stepName =
        chunk === 0 ? `execute:${id}` : `execute:${id}:chunk:${chunk}`;
      const done = await step.do(stepName, CHUNK_STEP, async () => {
        // The DO posts any progress itself; the step returns only the verdict.
        const outcome = await agent().executeSubtaskChunk(id, chunk, push);
        return outcome.done;
      });
      if (done) return;
    }
    // Unreachable while every Recipe's `maxTurns` stays under the cap: a chunk
    // that yields always advanced a turn, so the budget summary comes first.
    console.error("[handle-task] subtask exceeded its chunk budget", {
      taskId: p.taskId,
      subtaskId: id
    });
    await step.do(`fail:${id}`, async () => {
      await agent().failSubtask(
        id,
        `execution exceeded ${MAX_CHUNKS_PER_BRANCH} chunks`
      );
    });
  } catch (err) {
    console.error("[handle-task] subtask execution exhausted retries", {
      taskId: p.taskId,
      subtaskId: id,
      err: String(err)
    });
    await step.do(`fail:${id}`, async () => {
      await agent().failSubtask(
        id,
        `execution exhausted retries: ${String(err)}`
      );
    });
  }
}

/**
 * Persist the terminal Task, then notify the gatekeeper. A null `reply` delivers a
 * `failed` Task with the policy's user-safe text; the diagnostic is already
 * logged. Given a `failure`, the host's {@link HandleTaskDeps.failureCopy} may
 * replace that text — same delivery, different words.
 *
 * `failure` is optional because only a round's own inference carries a kind. The
 * other path here — a budget that ran out mid-delegation — is not a model failure
 * and is deliberately not given a kind of its own until something needs to tell
 * it apart.
 *
 * The delivery itself is {@link deliverTerminalTask}, which is shared with agents
 * that never delegate. What is a round's own is the two things passed to it: the
 * choice of terminal Task, and the child sweep.
 */
async function deliver(
  p: HandleTaskParams,
  step: WorkflowStep,
  agent: ResolveAgent,
  reply: string | null,
  deps: HandleTaskDeps,
  failure?: { kind: RoundFailureKind; detail: string }
): Promise<void> {
  // Resolved outside the step body so a replay cannot take a different branch
  // than the write it is replaying.
  const failedText =
    (failure && deps.failureCopy?.(failure.kind, failure.detail)) ||
    deps.policy.copy.taskFailed;

  await deliverTerminalTask(step, {
    push: {
      taskId: p.taskId,
      contextId: p.contextId,
      pushUrl: p.pushUrl,
      pushToken: p.pushToken,
      jku: p.jku
    },
    signingKey: deps.signingKey,
    // `agent()` inside the body, never hoisted: a stub is a live connection and
    // a severed one never reconnects.
    saveTask: (task) => agent().saveTask(task),
    terminal: () =>
      reply !== null
        ? buildCompletedTask(p.taskId, p.contextId, reply)
        : buildFailedTask(p.taskId, p.contextId, failedText),
    // Sweep this Task's managed children now that it is terminal and every
    // `execute` step has unwound. Deleting them here — rather than right after
    // each successful chunk — keeps `deleteSubAgent`'s facet-abort from landing
    // on a still-open `executeChunk` RPC, which telemetry mis-records as a
    // failure. Best-effort and idempotent, so it is safe on replay.
    sweep: async () => {
      await agent().sweepTaskChildren(p.taskId);
    }
  });
}
