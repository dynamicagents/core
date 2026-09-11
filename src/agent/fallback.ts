import type { LanguageModel, LanguageModelMiddleware } from "ai";
import { wrapLanguageModel } from "ai";
import { isTransientAiError, nonRecoverableKind } from "./inference.js";
import type { ModelPair } from "./model.js";

/**
 * The fallback slot, inside the model.
 *
 * A pair wrapped here recovers at the **step**: the SDK hands the second slot
 * the same call the first was given, with every completed step and tool result
 * already in it, and the loop above never learns the slot changed. Recovering a
 * level up cannot do that. It can only run the call again from the top, which
 * repeats every side effect the first attempt already had — a round that cloned
 * a repository and then lost its model clones it twice.
 *
 * What that leaves a loop's own ladder is the failure a second model genuinely
 * answers and this one cannot: a call that **succeeded** and produced nothing
 * usable — no control call, output cut off at the token ceiling, an empty
 * summary. None of those reaches `doGenerate`'s rejection.
 */

/** The model that failed, and what it failed with, for the caller to log. */
export interface FallbackNotice {
  /** The slot's configured id — what {@link ModelPair.primaryId} reports. */
  modelId: string;
  /** Unclassified: the caller decides what to say about it, and whether to. */
  error: unknown;
}

export interface FallbackOptions {
  /**
   * Fires when the primary has failed and the fallback is about to be asked —
   * once per step that falls through, since no step is bound to the slot the
   * last one used.
   *
   * It is the only account of a spent primary the caller gets. The error the
   * call finally throws is the one worth classifying, which is not always the
   * one the primary raised, and a call the fallback rescues throws nothing at
   * all.
   */
  onFallback?: (notice: FallbackNotice) => void;
  /**
   * Fires with the error the call is about to throw, and the slot it came from
   * — which is not always the slot that was asked first.
   *
   * A caller that labels a failure with the model it *started* on will name the
   * primary for a credential the fallback refused, and send an operator to
   * rotate a working secret. That is the misdiagnosis
   * {@link file://./errors.ts CredentialRejectedBy} exists to prevent, so the
   * slot has to travel with the error rather than be inferred from the call.
   *
   * Silent on a cancelled call: nothing failed.
   */
  onFailure?: (notice: FallbackNotice) => void;
}

/**
 * A model id is a string the SDK resolves through its gateway when the call is
 * made — after the point where a wrapper would have to exist. There is nothing
 * to wrap, so each slot says so as it is resolved, rather than leaving a
 * fallback that was never there to look like one that did not help.
 */
function built(model: LanguageModel, slot: string) {
  if (typeof model === "string")
    throw new TypeError(
      `the ${slot} slot returned the model id "${model}" rather than a built ` +
        `model, and a fallback has nothing to wrap: build it in the ModelRuntime`
    );
  return model;
}

/**
 * A model that answers from `pair`'s primary and, when a call fails, from its
 * fallback — for a `generateText` that then needs no ladder of its own.
 *
 * **What falls through: anything but a refused credential or a cancel.** A
 * rate limit included, which is the one worth stating: the two slots are
 * different models and the second may have capacity the first does not, so it
 * is offered the call before the SDK spends its retries waiting on the model
 * that hit the limit. What that costs when neither has capacity is a step's
 * retries against *both* slots — pinned in `fallback.spec.ts` and budgeted for
 * at {@link file://../platform.ts CHUNK_SOFT_MS}. A
 * {@link file://./errors.ts CredentialRejectedError} is the exception for the
 * reason {@link nonRecoverableKind} gives: both slots sit behind one credential,
 * so the second can only present the same refused token.
 *
 * **Whichever error it throws is still the one to classify.** A pair that both
 * failed throws the transient one if either is — the answer the loops above
 * already reach for, since a fault a retry could clear is worth retrying the
 * step for whichever slot hit it.
 *
 * **The primary is preferred again on every step.** A model that is merely
 * unwell is not demoted for the rest of a round by one blip; the cost is one
 * wasted call per step while it stays broken, which the `onFallback` warning
 * makes visible.
 *
 * Lazy, like the pair it wraps: resolving a model can throw (a missing binding,
 * a bad id), and that has to count as the attempt failing rather than as the
 * loop above crashing.
 */
export function withFallback(
  pair: ModelPair,
  options: FallbackOptions = {}
): () => LanguageModel {
  return () => {
    const fallbackId = pair.fallbackId();
    const primaryId = pair.primaryId();

    /**
     * The second slot, resolved no earlier than the first call that needs it —
     * a slot that cannot be built at all must not stop the other one from
     * answering, which is the whole reason `ModelPair` hands out thunks.
     *
     * Normalized through an empty wrap because `doGenerate` is called directly
     * below and the SDK's own upgrade helper is not exported. That is also what
     * lets a model built against an older specification version — every mock in
     * `/testing`, among others — serve this slot.
     */
    let resolved: ReturnType<typeof wrapLanguageModel> | undefined;
    const fallback = () =>
      (resolved ??= wrapLanguageModel({
        model: built(pair.fallback(), "fallback"),
        middleware: {}
      }));

    /**
     * Which model answered, for the caller's diagnostics — and in the pair's own
     * vocabulary, so it can be compared against `primaryId()`/`fallbackId()`.
     *
     * Nothing else carries it: the wrapper reports the primary's id as its own,
     * whichever slot served the step. A provider that sets an id of its own is
     * left alone — it knows which revision answered, and the slot does not.
     */
    const served = <T extends { response?: { modelId?: string } }>(
      result: T,
      modelId: string
    ) => ({
      ...result,
      response: {
        ...result.response,
        modelId: result.response?.modelId ?? modelId
      }
    });

    /** Announce whose error won, then hand it back to be thrown. */
    const failed = (modelId: string, error: unknown) => {
      options.onFailure?.({ modelId, error });
      return error;
    };

    const middleware: LanguageModelMiddleware = {
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return served(await doGenerate(), primaryId);
        } catch (error) {
          // Ahead of the classification, as everywhere else: an abort arrives as
          // a rejection, and spending the second slot on work nobody is waiting
          // for is exactly what cancelling asked us not to do.
          if (params.abortSignal?.aborted) throw error;
          if (nonRecoverableKind(error)) throw failed(primaryId, error);

          options.onFallback?.({ modelId: primaryId, error });
          try {
            return served(await fallback().doGenerate(params), fallbackId);
          } catch (fallbackError) {
            // A credential the second slot refused outranks a blip on the
            // first. Nothing clears it, and preferring the transient error
            // would send the step back to retry a token that is already dead —
            // exactly the spend {@link nonRecoverableKind} exists to prevent.
            if (nonRecoverableKind(fallbackError))
              throw failed(fallbackId, fallbackError);
            if (isTransientAiError(fallbackError))
              throw failed(fallbackId, fallbackError);
            if (isTransientAiError(error)) throw failed(primaryId, error);
            throw failed(fallbackId, fallbackError);
          }
        }
      }
    };

    return wrapLanguageModel({
      model: built(pair.primary(), "primary"),
      middleware
    });
  };
}
