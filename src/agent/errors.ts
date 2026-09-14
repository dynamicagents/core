/**
 * Failures the loops must treat specially, whichever provider raised them.
 *
 * A sibling of {@link file://./model.ts model.ts} and neutral for the same
 * reason: a provider directory may throw these, and nothing here may know that
 * any particular one exists. `nonRecoverableKind` in
 * {@link file://./inference.ts inference.ts} keys on this file, so a provider
 * written outside core — the thing `ModelRuntimeFactory` exists to make cheap —
 * gets the same handling as core's own, with no change to core.
 *
 * ## Why a third classification was needed at all
 *
 * Core answers two questions about a failed call, and an expired credential is
 * the wrong answer to both. **Is the other slot worth asking?** —
 * {@link file://./fallback.ts withFallback}, and it is not, because both slots
 * sit behind the one rejected token. **Is the whole round worth retrying?** —
 * {@link file://./inference.ts isTransientAiError}, and it is not, because the
 * Workflow would spend its budget on a request that can never succeed.
 *
 * So neither "transient" nor "not transient" expresses it: the first retries
 * forever and the second spends the second slot proving the obvious. It has to
 * stop the round and say what a human must do, which is the third
 * classification this file exists for.
 */

/**
 * Who refused the request, when a `401` came back.
 *
 * Two authorities sit on the path, each with its own credential: the AI Gateway
 * (`cf-aig-authorization`) and the model provider itself (`Authorization`). They
 * fail with the same status code and have completely different remedies, so a
 * rejection that does not say which one it was sends an operator to rotate the
 * wrong secret — which is exactly what happened before this existed.
 *
 * `"unknown"` is a real answer and the default. Guessing `"provider"` for an
 * unrecognised body is how the misdiagnosis happens; saying "one of these, here
 * is how to check each" is worse copy and better information.
 *
 * A third arm, `"proxy"`, named an optional intermediary between the two — the
 * shape where a deployment terminates the AI Gateway request at its own Worker to
 * attach a credential. It was removed in 0.8.0 with the deployment that had one.
 * If you build that topology again, the honest classification for its refusals
 * is `"unknown"` until you widen this union, because the remedy genuinely
 * differs: an intermediary minting its caller credential per request fails for
 * reasons upstream of any stored secret, so the fix is to look rather than to
 * rotate.
 */
export type CredentialRejectedBy = "provider" | "gateway" | "unknown";

/**
 * A credential on the path to the model was rejected (HTTP 401 / 403).
 *
 * Deliberately not an `APICallError`: that is the shape a provider uses to say a
 * failure is worth another attempt, and this one never is.
 * {@link file://./inference.ts nonRecoverableKind} maps it to one of the
 * credential kinds — which one depends on {@link source} — and that is what both
 * the model wrapper and the round read to leave the second slot unspent.
 * `isTransientAiError` reads it as deterministic for the same reason it is not
 * an `APICallError`.
 *
 * The round then fails carrying that kind, and the host supplies the
 * operator-facing copy through `HandleTaskDeps.failureCopy` — core owns the
 * signal and the delivery, never the wording.
 */
export class CredentialRejectedError extends Error {
  readonly name = "CredentialRejectedError";
  /** The upstream status, when one was available. */
  readonly status: number | undefined;
  /** Which authority rejected it. See {@link CredentialRejectedBy}. */
  readonly source: CredentialRejectedBy;

  constructor(
    message: string,
    options?: {
      status?: number;
      source?: CredentialRejectedBy;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options?.cause });
    this.status = options?.status;
    this.source = options?.source ?? "unknown";
  }

  /**
   * Structural check rather than `instanceof`.
   *
   * A Worker bundle can end up with two copies of this module (core linked as a
   * tarball while a plugin resolves its own), and `instanceof` fails across
   * them — the same realm hazard `AGENTS.md` calls out for `agents`. The name is
   * a readonly literal, so this is as strong in practice and survives bundling.
   *
   * It is also what lets a provider outside core raise one: anything named
   * `CredentialRejectedError` with a `source` is honoured, no shared class
   * identity required.
   */
  static isInstance(err: unknown): err is CredentialRejectedError {
    return err instanceof Error && err.name === "CredentialRejectedError";
  }
}
