import { describe, it, expect } from "vitest";
import { APICallError, RetryError } from "ai";
import { CredentialRejectedError } from "./errors.js";
import { isTransientAiError, nonRecoverableKind } from "./inference.js";

/**
 * How a failed model call is classified — the decision that routes it.
 *
 * Three outcomes hang off these two functions: retry the whole Workflow step,
 * spend the fallback slot, or end the round and tell an operator what to fix.
 * Both ladders — {@link file://../round/turn.ts turn.ts} and
 * {@link file://../subagent/run.ts run.ts} — read exactly these and re-derive
 * nothing, so this file is where the rules are pinned.
 *
 * The classification is **structural**: a model says "wait and try me again" by
 * throwing an `APICallError` carrying `isRetryable`, which is the signal the
 * SDK's own in-step retry reads, so what waits in place and what retries the
 * step cannot disagree. Message text is never read — the sentences below are
 * the ones that used to be, and each of them was read wrong.
 */

/** What a provider must map its failures into. See `ModelRuntime`. */
const apiError = (
  statusCode: number | undefined,
  message: string,
  isRetryable?: boolean
) =>
  new APICallError({
    message,
    url: "workers-ai:binding/run/test:primary",
    requestBodyValues: {},
    statusCode,
    responseBody: message,
    ...(isRetryable === undefined ? {} : { isRetryable })
  });

/** What the SDK throws once its own retries are done with a call. */
const retried = (
  reason: "maxRetriesExceeded" | "errorNotRetryable",
  errors: unknown[]
) => new RetryError({ message: "retries exhausted", reason, errors });

const rateLimited = () => apiError(429, "3040: Capacity temporarily exceeded");

describe("classifying a failed model call", () => {
  it("waits out a capacity failure the provider marked retryable", () => {
    // Workers AI's out-of-capacity code reaches core as a 429 because
    // `workers-ai-provider` maps it; that mapping is what makes it retryable.
    expect(isTransientAiError(rateLimited())).toBe(true);
  });

  it("reads a blocked account off its status rather than its sentence", () => {
    // Blocked until a human clears it, and the status says so. The *message*
    // says "Service unavailable", which is the reading that had the Workflow
    // step retry a round to exhaustion and abandon the task instead of failing
    // it.
    expect(
      isTransientAiError(apiError(403, "3023: Service unavailable for account"))
    ).toBe(false);
  });

  it("honours a provider that says a server error is not worth retrying", () => {
    // The status alone used to decide, which overruled the provider on the one
    // judgement only it can make.
    expect(
      isTransientAiError(apiError(503, "upstream is draining", false))
    ).toBe(false);
  });

  it("treats an unmapped failure as deterministic, whatever it says", () => {
    // A provider throwing raw is telling core the failure is deterministic.
    // Mapping is the provider's job — see {@link file://./model.ts ModelRuntime}
    // — and reading the sentence instead is what let a 403 pass for a 429.
    expect(
      isTransientAiError(new Error("3040: Capacity temporarily exceeded"))
    ).toBe(false);
  });

  it("classifies a retried call by the attempt that ended it", () => {
    expect(
      isTransientAiError(
        retried("maxRetriesExceeded", [
          rateLimited(),
          rateLimited(),
          rateLimited()
        ])
      )
    ).toBe(true);

    // The SDK raises `maxRetriesExceeded` on the attempt count alone, without
    // asking whether the attempt that ended it was retryable. A malformed
    // request behind two rate limits is still malformed, and retrying the step
    // sends it again.
    expect(
      isTransientAiError(
        retried("maxRetriesExceeded", [
          rateLimited(),
          rateLimited(),
          apiError(400, "3003: Request is missing headers or body")
        ])
      )
    ).toBe(false);
  });

  it("sees a rejected credential through the retries that preceded it", () => {
    // A rate limit first, so the SDK retried and wrapped what came next. Left
    // wrapped, the round spends its fallback slot presenting the same dead
    // token and then throws for the step to retry it again.
    const err = retried("errorNotRetryable", [
      rateLimited(),
      new CredentialRejectedError("401 Unauthorized", {
        status: 401,
        source: "provider"
      })
    ]);

    expect(nonRecoverableKind(err)).toBe("credential");
    expect(isTransientAiError(err)).toBe(false);
  });
});
