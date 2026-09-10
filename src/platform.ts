import type { WorkflowStepConfig } from "cloudflare:workers";

/**
 * What the Cloudflare Workflows runtime imposes, and the two numbers derived from
 * it. Nothing here is a budget or a preference — see {@link file://./config.ts}
 * for those, and note that no Recipe can reach these. They change when the
 * platform changes, and for no other reason.
 *
 * The distinction is worth keeping sharp, because collapsing it produces a
 * specific bug: using a *turn count* to keep a step under the step timeout only
 * works if you can predict how long a turn takes. You cannot. Time bounds time
 * here; turns bound cost, over in `config.ts`.
 */

/**
 * The step timeout **we configure**, passed as `WorkflowStepConfig.timeout` on
 * every step that can hold a model call or a container command.
 *
 * This is the one value in this file that is **not** a platform fact, and
 * treating it as one is the mistake to avoid: ten minutes is Workflows'
 * *default* step timeout, not its ceiling, and a step that never passes a config
 * inherits it silently. Sizing {@link CHUNK_SOFT_MS} against that inherited
 * default is what once ran a production task as ten four-minute slices, one of
 * which blew the ten minutes anyway and was retried whole.
 *
 * The genuine platform facts are narrower and do not bind us: wall-clock time per
 * step is effectively unlimited, and a step is bounded by **CPU** time. Measured
 * over a 59-minute task, the chunk steps used ~100 ms of CPU against 3,146 s of
 * wall — this ceiling is nowhere near the real one.
 *
 * It is still a ceiling worth having, because it is what turns a hung container
 * into a retry rather than a task that never ends. {@link CHUNK_SOFT_MS} is sized
 * against it, and that relationship is asserted in `platform.spec.ts`.
 */
export const STEP_TIMEOUT_MS = 30 * 60_000;

/**
 * Platform fact: a single Workflow instance may run 10,000 steps by default on the
 * paid plan. Cloudflare will raise it to 25,000 on request — worth knowing, and
 * worth not relying on: {@link MAX_CHUNKS_PER_BRANCH} is sized against the default
 * so nothing here needs an account-level exception to be correct. See the
 * worst-case product asserted in `platform.spec.ts`.
 */
export const STEPS_PER_INSTANCE = 10_000;

/**
 * How long one durable chunk may run before it checkpoints and yields a fresh
 * step. Comfortably inside {@link STEP_TIMEOUT_MS} so a slow model turn in flight
 * when the soft limit trips still has room to finish.
 *
 * This is the *only* thing keeping a step under the timeout. A subagent otherwise
 * runs until its turn or wall-clock budget is spent, however many turns that takes
 * — which is the point: the runner no longer guesses at turn duration.
 *
 * ## Why this is 15 minutes and not 4
 *
 * A chunk boundary is not free. It checkpoints, returns through two RPC hops,
 * starts a fresh step, and re-hydrates the subagent — and for a coding agent it
 * also means the container connection is re-established. Four minutes bought a
 * boundary roughly every third tool call: a task that edited one README line spent
 * 59 minutes across **ten** chunks, and the model was idle for most of each one,
 * blocked on a single `sb_exec` running the project's test gate.
 *
 * ## Why it is not larger, which is the part that bit us
 *
 * This is a **soft** deadline, checked between turns (`stopWhen` in
 * `subagent/run.ts`). A turn that starts one millisecond before it trips still runs
 * to completion, so the real worst case is:
 *
 *     chunk wall  ≤  CHUNK_SOFT_MS + one whole turn
 *
 * and one turn is a model call plus a tool call. The old pair ignored that: four
 * minutes soft under a ten-minute timeout looked like six minutes of headroom, but
 * a single `sb_exec` may run for {@link MAX_TOOL_CALL_MS}, so a turn could add ten.
 * That is not a hypothetical — it is the `WorkflowTimeoutError` that cost a
 * production task ten minutes and a full chunk replay.
 *
 * So the headroom is sized against a whole turn, not against a guess:
 * `STEP_TIMEOUT_MS - CHUNK_SOFT_MS` is 15 minutes, covering
 * {@link MAX_TOOL_CALL_MS} of tool call plus five minutes for the model call and
 * its provider retries. Those retries are the AI SDK's own defaults — core
 * configures none — and it caps a single honoured `retry-after` at 60s, so an SDK
 * release that retries more moves this worst case with nothing here to say so.
 * Asserted in `platform.spec.ts` — raise the step timeout before raising this.
 */
export const CHUNK_SOFT_MS = 15 * 60_000;

/**
 * The longest a **single plugin tool call** may hold the loop that made it. Core
 * enforces it whatever the tool does: every `generateText` in the round and the
 * recipe loop fires the call's signal {@link TOOL_CALL_GRACE_MS} before it, and
 * every plugin tool is wrapped where core assembles it, so a call still running at
 * this bound is abandoned and the loop moves on. See
 * {@link file://./runtime/bound-tools.ts boundToolCalls}.
 *
 * What core cannot stop is the tool's *work*. The SDK aborts a signal — it does
 * not cancel a promise — so an abandoned call runs on unattended. **A tool whose
 * work must not outlive its call (a container command, a write that must not start
 * late) still reads its signal and stops that work**, or bounds it at the source,
 * as starter's container `timeoutMs` does.
 *
 * It exists because {@link CHUNK_SOFT_MS} cannot be reasoned about without it. The
 * soft deadline is checked between turns, so a tool call that could hold the loop
 * for longer than the headroom under {@link STEP_TIMEOUT_MS} would reintroduce
 * exactly the step-timeout kill this pair is sized to prevent — invisibly, from
 * inside a plugin, a long way from this file. That is why core enforces it rather
 * than asking hosts to.
 */
export const MAX_TOOL_CALL_MS = 10 * 60_000;

/**
 * How far ahead of {@link MAX_TOOL_CALL_MS} a tool call's signal fires: the window
 * a tool that honours its signal has to stop its work and answer for itself.
 *
 * An answer inside it is the one the model reads, so the tool can say what it
 * stopped and what survived. Past it core abandons the call with a sentence of its
 * own, which can only say the tool may still be running. Taken out of the bound
 * rather than added to it, so nothing sized against `MAX_TOOL_CALL_MS` moves. It
 * needs to cover a kill sent over RPC, and nothing more.
 */
export const TOOL_CALL_GRACE_MS = 5_000;

/**
 * Hard ceiling on durable chunk steps for one Subtask branch. A backstop, not a
 * budget: the Workflow *fails* a branch that reaches it, so reaching it is a bug.
 * It is held unreachable by two constraints, both asserted in
 * `platform.spec.ts`:
 *
 * 1. It exceeds every Recipe's `maxTurns`. A chunk that yields always advanced at
 *    least one turn, so a run takes at most `maxTurns` chunks however short they
 *    are — and they do get short, because `CHUNK_SOFT_MS` and progress events both
 *    end one early. Counting turns is what makes the bound survive that; any
 *    estimate of turns-per-chunk would not, since neither of those two is
 *    predictable.
 * 2. The worst-case step product stays under {@link STEPS_PER_INSTANCE}.
 */
export const MAX_CHUNKS_PER_BRANCH = 40;

/**
 * What a step holding a model call or a container command configures instead of
 * inheriting Workflows' defaults. Both defaults were measured wrong for this
 * workload.
 *
 * **`timeout`.** The default is ten minutes. A step here holds a model call and
 * its provider retries, or a container command running a project's test suite;
 * neither fits in ten minutes reliably, and neither uses meaningful CPU while it
 * waits. Left inherited, that default silently became the ceiling
 * {@link CHUNK_SOFT_MS} was sized against.
 *
 * **`retries`.** The default is five attempts with exponential backoff from ten
 * seconds. Against a fault that is not transient — a severed Durable Object stub
 * — that produced five failures in under 10ms each, spread across 160 seconds of
 * backoff that bought nothing. Three attempts still cover a genuinely transient
 * fault, since the model call has its own provider-level retry underneath this,
 * and a flat five-second delay stops a fast permanent failure being paid for at
 * exponential rates.
 *
 * Here rather than in `/round` because the agent that most needs it may not be a
 * round agent: a single-inference agent runs one model call in one step and has
 * the same two problems, and importing this from `/round` would put the whole
 * delegation engine in its bundle.
 *
 * For the **short** bookkeeping steps — `working`, `complete`, `notify` and
 * friends — the defaults are fine and a shared config would only hide that.
 */
export const CHUNK_STEP: WorkflowStepConfig = {
  timeout: STEP_TIMEOUT_MS,
  retries: { limit: 3, delay: 5_000, backoff: "constant" }
};
