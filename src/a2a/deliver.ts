import type { WorkflowStep } from "cloudflare:workers";
import { buildFailedTask } from "./notify.js";
import { createPushChannel, type TurnPushContext } from "./push.js";
import type { PlainTask } from "./task.js";

/** What {@link deliverTerminalTask} needs to finish a turn. */
export interface DeliverTerminalOptions {
  /** Which Task this is about, and where its callback goes. */
  push: TurnPushContext;
  /** The agent's card-signing key, for the callback JWT. */
  signingKey: string;
  /**
   * The guarded write, and **the cancellation check**. Return whether it
   * applied: `false` must mean the row was already terminal (canceled), which is
   * what suppresses the callback.
   *
   * Resolve any Durable Object stub *inside* this function, never above it — a
   * stub hoisted out of a step body is a live connection that a replay cannot
   * reconnect.
   */
  saveTask: (task: PlainTask) => Promise<boolean>;
  /**
   * Build the terminal Task. Called **inside** the `complete` step so that what
   * gets notified is exactly what was persisted: building it outside would
   * re-stamp `new Date()` on every replay and post a Task that differs from the
   * stored one.
   */
  terminal: () => PlainTask;
  /**
   * Optional best-effort cleanup, run after the write and before the callback.
   * An agent with no managed children omits it and no `sweep` step appears.
   */
  sweep?: () => Promise<void>;
  /**
   * Prefix for this delivery's three step names. Empty by default, which is the
   * only value an ordinary turn may use.
   *
   * **Step names are durable cache keys**, so this is not cosmetic. A workflow
   * that delivers twice — an ordinary delivery, then
   * {@link deliverAbandonedTask} from a `catch` above it — would otherwise call
   * `step.do("complete")` a second time and be handed the *first* call's cached
   * result, so the failed Task it built would never be written and the outcome
   * would depend on Workflows' caching semantics for a step whose failure was
   * caught. A distinct prefix makes the second delivery its own set of steps,
   * where the guarded write decides the outcome as it is supposed to.
   */
  stepPrefix?: string;
}

/**
 * Thrown when a delivery failed *after* its terminal Task was durably saved.
 *
 * The distinction it carries is the difference between "this turn produced
 * nothing" and "this turn produced a result the gatekeeper has not heard about
 * yet", and only the first of those is an abandoned task.
 *
 * Without it, an ordinary delivery whose `notify` step exhausted its retries
 * would unwind into an abandoned-task recovery, which would write a generic
 * failure over a real answer. The guarded write refuses that now
 * ({@link file://../db/models/tasks.ts}), but refusing it is not enough on its
 * own: the recovery would then succeed at doing nothing, swallow a genuine
 * callback failure, and log the word "abandoned" about a turn that completed.
 * So the two work together — this stops the recovery being attempted, and the
 * guard is the backstop for the narrow window where a `complete` step throws
 * without saying whether its write applied.
 */
export class TaskAlreadyTerminalError extends Error {
  constructor(cause: unknown) {
    super("the terminal Task was saved; the callback after it failed", {
      cause
    });
    this.name = "TaskAlreadyTerminalError";
  }
}

/**
 * Persist a turn's terminal Task, then notify the gatekeeper.
 *
 * **The guarded write is the cancellation check.** `saveTask` refuses to write a
 * terminal state over a `canceled` row and says so, doing that read and write in
 * one synchronous pass inside the Durable Object. Probing first and saving
 * second would leave a window — between the two calls, and again between this
 * step and `notify` — in which a `tasks/cancel` lands and the gatekeeper still
 * receives a `completed` callback. Keying the notify on "did the write apply"
 * closes it, and that has already been got wrong once.
 *
 * In `/a2a` rather than `/round` because the shape is not a round's: an agent
 * whose turn is a single inference ends it the same way, and importing this from
 * `/round` would put the whole delegation engine in a bundle that must not carry
 * it. Everything it calls already lives here.
 *
 * Returns whether it delivered: `false` is that cancellation, and it is the only
 * way a caller can tell "this turn ended and the user was told" from "this turn
 * ended and the user had already stopped listening". A caller with nothing to
 * record may ignore it, as every caller did before there was anything to record.
 */
export async function deliverTerminalTask(
  step: WorkflowStep,
  options: DeliverTerminalOptions
): Promise<boolean> {
  const at = options.stepPrefix ?? "";
  const task = await step.do(`${at}complete`, async () => {
    const terminal = options.terminal();
    return (await options.saveTask(terminal)) ? terminal : null;
  });
  // The guarded write refused, which on this path means one thing: the caller
  // canceled while this turn was working, and the Task is already terminal as
  // `canceled`. Nothing was persisted and nothing will be posted — so this
  // reports that it delivered nothing, rather than leaving every caller to infer
  // it from a `void` that looks identical to success.
  if (!task) return false;

  // Caught, not left to propagate: the terminal Task is already durably saved,
  // so a sweep that still fails once the step's own retries are exhausted must
  // not block the callback — the gatekeeper is owed its result either way.
  if (options.sweep) {
    const sweep = options.sweep;
    try {
      await step.do(`${at}sweep`, async () => {
        await sweep();
      });
    } catch (err) {
      console.error("[deliver] sweep failed after retries", {
        taskId: options.push.taskId,
        err: String(err)
      });
    }
  }

  // A card-key-signed callback POST. Retried by the step on a non-2xx; the
  // terminal messageId is deterministic and the gatekeeper is idempotent and
  // single-use, so retries are safe. If it ultimately fails, the gatekeeper's own
  // reaction backstop clears the pending marker.
  //
  // Wrapped, because by this line the Task is durably terminal: anything that
  // fails from here is a callback that did not land, never a turn that produced
  // nothing. See {@link TaskAlreadyTerminalError}.
  try {
    await step.do(`${at}notify`, async () => {
      await createPushChannel(options.signingKey, options.push).deliver(task);
    });
  } catch (err) {
    throw new TaskAlreadyTerminalError(err);
  }
  return true;
}

/**
 * The step-name prefix an abandoned delivery runs under.
 *
 * Its own namespace so it can never collide with the ordinary delivery's — see
 * {@link DeliverTerminalOptions.stepPrefix}.
 */
const ABANDONED_PREFIX = "abandoned:";

/** What {@link deliverAbandonedTask} needs to end a turn nobody else will. */
export interface AbandonedTaskOptions {
  /** Which Task this is about, and where its callback goes. */
  push: TurnPushContext;
  /** The agent's card-signing key, for the callback JWT. */
  signingKey: string;
  /** The guarded write — same contract as {@link DeliverTerminalOptions.saveTask}. */
  saveTask: (task: PlainTask) => Promise<boolean>;
  /**
   * The user-facing words. The host's, always: core ships no prompt copy and no
   * user-facing copy, and a paraphrase invented at the failure site is exactly
   * what this parameter exists to prevent.
   */
  text: string;
  /** Best-effort child cleanup. Omitted by an agent that delegates to nothing. */
  sweep?: () => Promise<void>;
  /** Log prefix — conventionally the agent's tenant id. */
  label?: string;
}

/**
 * Turn an unrecoverable orchestration fault into a delivered failed Task.
 *
 * ## The failure this exists for
 *
 * A turn ends badly in two different ways. A **typed** failure — the models were
 * tried and nothing usable came back — is a value, and the ordinary delivery
 * path carries it. A **transient** fault instead throws, so the step retries and
 * recovers without paying for a second inference. That is the right default.
 *
 * What neither covers is a transient fault that never stops being one. `step.do`
 * retries a bounded number of times and then rethrows, and with nothing above it
 * to catch that, the orchestration unwinds, the delivery path is never reached,
 * and the Workflow instance errors with the Task still sitting in `working`. The
 * user is told nothing at all — and because the instance dies mid-`run`, the
 * runtime records it as *"your Worker's code had hung and would never generate a
 * response"*, which reads like a bug in the workflow rather than a provider that
 * was refusing every request.
 *
 * Observed exactly that way in a deployed agent on 2026-08-19: a turn step
 * exhausted its four attempts against a rate-limited provider, and the agent
 * simply went quiet.
 *
 * ## Three behaviours here are load-bearing
 *
 * **It resolves after a successful delivery — it does not rethrow.** Rethrowing
 * would reproduce the very "hung Worker" record this exists to remove, and the
 * instance genuinely has finished its job: the Task is terminal and the gatekeeper
 * has been told. It resolves `false` when the guarded write refused, which means
 * the caller canceled while the retries were burning: nothing was abandoned to
 * the user, because the user had already gone.
 *
 * **It rethrows the *original* `cause` when the delivery itself fails.**
 * Swallowing there would mark the instance successful while the user got
 * nothing — strictly worse than the erroring instance being replaced, because it
 * would also be silent in the Workflows console. `cause` is what an operator
 * needs to see, not the delivery's own secondary fault.
 *
 * **It refuses to run at all once a terminal Task exists.** A
 * {@link TaskAlreadyTerminalError} means the ordinary delivery persisted its
 * result and only the callback failed, so the original fault is rethrown and
 * nothing is written. An earlier draft of this claimed the guarded write alone
 * made that safe; it did not. The write refused only cancellation conflicts, so
 * `completed → failed` applied cleanly and a turn that succeeded would have been
 * rewritten as a generic failure because a webhook was flaky. The guard now
 * refuses any terminal-over-different-terminal write as a backstop, and this
 * check is what stops the attempt being made in the first place — without it the
 * recovery would quietly succeed at doing nothing, swallowing a real callback
 * failure and logging "abandoned" about a completed turn.
 *
 * ## Why it is exported rather than private to `/round`
 *
 * `runHandleTask` wraps itself in it, so every round agent gets this without
 * asking. But an agent whose turn is a single inference writes its own workflow
 * body and has the identical exposure — and the alternative to exporting this is
 * that each such host reimplements the delivery, which is precisely the mistake
 * this function was extracted from.
 */
export async function deliverAbandonedTask(
  step: WorkflowStep,
  cause: unknown,
  options: AbandonedTaskOptions
): Promise<boolean> {
  // Nothing was abandoned: the ordinary delivery already persisted a terminal
  // Task and only its callback failed. Rethrow the fault that actually
  // happened, so the instance still errors exactly as it did before any
  // recovery existed and the gatekeeper's own backstop clears the pending marker.
  //
  // Checked **here** rather than in each caller's `catch` on purpose. This whole
  // change exists because a recovery every host had to remember to wire was one
  // three hosts forgot; a caveat every host had to remember to check would be
  // the same mistake a second time.
  if (cause instanceof TaskAlreadyTerminalError) throw cause.cause;

  const label = options.label ?? "agent";

  // Logged before anything is attempted: if the delivery below also fails, this
  // line is the only record of what actually went wrong.
  console.error(`[${label}] task abandoned after retries were exhausted`, {
    taskId: options.push.taskId,
    error: String(cause)
  });

  try {
    return await deliverTerminalTask(step, {
      push: options.push,
      signingKey: options.signingKey,
      saveTask: options.saveTask,
      terminal: () =>
        buildFailedTask(
          options.push.taskId,
          options.push.contextId,
          options.text
        ),
      sweep: options.sweep,
      stepPrefix: ABANDONED_PREFIX
    });
  } catch (deliveryFailed) {
    console.error(`[${label}] could not deliver the failed Task`, {
      taskId: options.push.taskId,
      error: String(deliveryFailed)
    });
    throw cause;
  }
}
