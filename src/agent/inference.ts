import type { FinishReason, StepResult, ToolSet } from "ai";
import { RetryError } from "ai";
// Type-only would not work: this is a runtime guard. `errors.ts` is the neutral
// sibling of `model.ts` and imports nothing, so this reaches no provider.
import { CredentialRejectedError } from "./errors.js";

/**
 * Shared plumbing for the agent's inference operations — the pieces every model
 * call needs regardless of *which* operation it belongs to.
 *
 * The two loops themselves are deliberately separate, not layered on a common
 * one: the main agent's Session-coupled round lives in
 * {@link file://../round/turn.ts turn.ts}, and the Session-less subagent loop in
 * {@link file://../subagent/run.ts run.ts}. They share error classification and
 * progress streaming; their control flow has nothing in common worth abstracting.
 */

/**
 * Called with each **intermediate** assistant content message — text the model
 * emits in a step that also makes tool calls (`finishReason:"tool-calls"`), i.e.
 * before the final reply. Used to stream those messages out live; the final reply
 * is the operation's return value, not an `onContent` call. `stepIndex` is the
 * 0-based step ordinal (stable enough across a primary→fallback re-run for the
 * gatekeeper to dedupe on). Best-effort — the caller must swallow its own failures.
 */
export type OnContent = (
  text: string,
  stepIndex: number
) => void | Promise<void>;

/**
 * The attempt a call actually ended on.
 *
 * The SDK retries a retryable failure on the same model and, when it gives up,
 * throws a `RetryError` carrying every attempt it made. What the call ended on
 * is the last of them, and it need not be retryable at all: `maxRetriesExceeded`
 * is raised on the attempt count without re-reading the error that arrived with
 * it. So both classifications below unwrap first, or a malformed request behind
 * two rate limits reads as a rate limit, and a refused credential behind one
 * reads as neither.
 */
const lastAttempt = (err: unknown): unknown => {
  let error = err;
  while (RetryError.isInstance(error)) error = error.lastError;
  return error;
};

/**
 * Whether the error carries a provider's own "wait and try again", read as a
 * property rather than as a class.
 *
 * `APICallError` is the shape core's provider raises, but the SDK's retry
 * predicate honours `@ai-sdk/gateway`'s `GatewayError` on the same flag, and a
 * consumer whose {@link file://./model.ts ModelRuntime} returns a bare model id
 * gets exactly those. Core cannot name that class — it is not a dependency here,
 * and importing one npm happens to have hoisted into place is the mistake
 * `AGENTS.md` records twice. Matching on the property instead covers both, and
 * covers a provider written outside the SDK's own set, the same way
 * {@link file://./errors.ts CredentialRejectedError} is matched structurally.
 */
const saysRetry = (err: unknown): boolean =>
  err instanceof Error &&
  (err as { readonly isRetryable?: unknown }).isRetryable === true;

/**
 * Whether an error is a transient availability condition rather than a
 * deterministic bad-output one.
 *
 * Read **after** both model slots have already failed, which is the level that
 * gives it its meaning: see {@link file://./fallback.ts withFallback} for the
 * question asked before this one. What is left to decide is whether the whole
 * round is worth running again — transient throws out of the attempt loop so the
 * Workflow step retries it, while everything else ends the round.
 *
 * Classifying a capacity blip as deterministic is the expensive mistake: it fails
 * a Task that would have succeeded a second later. The opposite mistake spends a
 * step's retries on a fault no retry can clear, and ends the Task saying nothing
 * was decided.
 *
 * The model's own verdict decides it and nothing else: `isRetryable` on the
 * error the call ended on, read by {@link saysRetry}. It is the same flag the
 * SDK's in-place retry reads and the same one the other slot was offered on, so
 * no two levels can disagree about it — and a failure arriving here has already
 * been waited out as far as the provider said was worth waiting. See
 * {@link file://./model.ts ModelRuntime} for what a provider owes this.
 *
 * An error that carries no such flag is deterministic. Reading its message
 * instead is how a `403` whose text said "service unavailable" — an account
 * blocked until a human clears it — spent a step's retries and abandoned a Task.
 */
export function isTransientAiError(err: unknown): boolean {
  return saysRetry(lastAttempt(err));
}

/**
 * Why a round stopped without a second attempt being worth making.
 *
 * A stable string rather than the error itself, because this value crosses two
 * serialization boundaries — the DO's RPC return and a Workflow step result —
 * and an `Error` survives neither reliably. The host maps it to operator-facing
 * copy; core never owns that wording.
 *
 * The credential kinds are separate strings rather than one, because they have
 * different remedies and the host cannot tell them apart afterwards:
 *
 * - `credential` — the model provider rejected the token. Rotate that one.
 * - `gateway-credential` — the AI Gateway *in front of* the provider rejected the
 *   request, which the provider therefore never saw. Rotate the AI Gateway token
 *   (`cf-aig-authorization`) instead; the model credential is very likely fine.
 * - `unknown-credential` — a `401`/`403` matching none of the shapes. Says so,
 *   rather than picking one and sending an operator to rotate a working secret.
 *
 * A fourth, `proxy-credential`, was removed in 0.8.0 along with
 * {@link file://./errors.ts CredentialRejectedBy}'s `"proxy"` arm. Adding a kind
 * back is a breaking change for every consumer, because the `Record` they map it
 * with is total — which is the property that makes a new kind impossible to
 * ignore, and the reason to remove one rather than leave it unreachable.
 */
export type NonRecoverableKind =
  "credential" | "gateway-credential" | "unknown-credential";

/**
 * Why a round ended with no answer — one terminal status, two situations.
 *
 * `exhausted` is the ladder run to the end: both slots tried, every repair
 * spent, nothing usable produced. Every other member is the ladder stopping
 * early, because nothing further could have cleared the fault — see
 * {@link nonRecoverableKind}.
 *
 * The distinction is a *reason*, not an outcome: both deliver a failed Task with
 * the same shape. What it decides is the words, and only the host has those (see
 * `HandleTaskDeps.failureCopy`) — which is why this is a total union rather than
 * an optional field. A consumer that maps kinds to copy is then a `Record` the
 * compiler checks, and a new kind cannot be silently ignored by any of them.
 */
export type RoundFailureKind = "exhausted" | NonRecoverableKind;

/**
 * Whether an error is one that **no** further attempt can clear, and the reason.
 *
 * This is the third classification, and the one the other two cannot express.
 * {@link isTransientAiError} decides whether the round is worth running again,
 * and a rejected credential is worth neither that nor the other slot: retrying
 * spends the Workflow's budget on a request that can never succeed, and the
 * second slot can only present the *same* dead token, since both sit behind it.
 *
 * So this is read twice and stops the call both times — by
 * {@link file://./fallback.ts withFallback} before the other slot is offered
 * anything, and by the attempt ladders before they repair or spend a second
 * slot of their own. `runHandleTask` then ends the Task with copy the host
 * supplies. Nothing is retried and nothing is spent proving the obvious twice.
 *
 * Keyed on {@link file://./errors.ts CredentialRejectedError}, which is neutral
 * and structurally matched — so a provider outside core raises one and gets this
 * handling with nothing here to change. Read through
 * {@link lastAttempt}, because a credential refused after a rate limit reaches
 * the ladder wrapped in the SDK's retry error.
 */
export function nonRecoverableKind(
  err: unknown
): NonRecoverableKind | undefined {
  const error = lastAttempt(err);
  if (!CredentialRejectedError.isInstance(error)) return undefined;
  switch (error.source) {
    case "provider":
      return "credential";
    case "gateway":
      return "gateway-credential";
    // Includes an error that crossed a realm boundary carrying no `source` at
    // all: `isInstance` is structural, so that is reachable, and "unknown" is
    // the honest reading of it.
    default:
      return "unknown-credential";
  }
}

/** A step is "intermediate" when it makes tool calls — more content follows. */
function isIntermediateStep(step: { finishReason: FinishReason }): boolean {
  return step.finishReason === "tool-calls";
}

/**
 * Returns a fresh `onStepEnd` callback for one `generateText` attempt.
 * Fires `onContent` for each intermediate step (text that accompanies tool
 * calls); the final step is skipped because its text is the operation's return
 * value. A fresh handler per attempt resets the 0-based `stepIndex` counter so a
 * primary→fallback re-run reuses the same indices and the gatekeeper dedupes.
 *
 * `terminalToolNames` are the loop's **halting** control tools (e.g. the main
 * agent's `delegate`): a step that calls one still has `finishReason:"tool-calls"`,
 * but it is the round's *final* step, and its accompanying text is the round's
 * acknowledgment — which the caller publishes separately as a milestone. Streaming
 * it here too would double-post the same text under a second messageId, so those
 * steps are skipped. Default `[]` (the subagent loop has no control tools).
 */
export function buildIntermediateContentHandler(
  onContent: OnContent,
  terminalToolNames: string[] = []
): (step: StepResult<ToolSet>) => Promise<void> {
  let stepIndex = 0;
  return async (step) => {
    const i = stepIndex++;
    if (!isIntermediateStep(step)) return;
    if (step.toolCalls.some((c) => terminalToolNames.includes(c.toolName)))
      return;
    const content = step.text.trim();
    if (content) await onContent(content, i);
  };
}
