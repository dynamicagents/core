import { describe, it, expect } from "vitest";
import { APICallError, generateText } from "ai";
import { createWorkersAIModelRuntime, workersAIModels } from "./runtime.js";
import { isTransientAiError } from "../inference.js";
import { resolveConfig } from "../../config.js";
import { TEST_MODELS } from "../../testing/fixtures.js";
import type { AiEnv } from "../../env.js";

/**
 * Core's default provider, which nothing else covers and every agent that does
 * not override `modelRuntime()` depends on.
 *
 * The property worth a test is the **laziness**, not the ids. `createWorkersAI`
 * throws "you must provide either a binding or credentials" when handed nothing,
 * and `wrangler deploy` evaluates module scope with bindings unpopulated to
 * validate a new version. So the provider must not be constructed until a model
 * is actually asked for — a refactor that hoists it out of the thunk
 * type-checks, passes every other spec, and then fails at deploy time on a
 * message that names neither this file nor the agent that triggered it.
 *
 * Which is why these assert against a **missing** binding rather than a spy: a
 * provider built eagerly over a present-but-unused binding is indistinguishable
 * from a lazy one, since `createWorkersAI` only stores the reference. Absence is
 * the state that tells the two apart, and it is also the real deploy-time state.
 */

const config = resolveConfig({ model: TEST_MODELS }).model;

/** The deploy-time env: the binding exists on the type, not at runtime. */
const unpopulated = { AI: undefined } as unknown as AiEnv;

describe("workers-ai runtime", () => {
  it("builds over an unpopulated binding without touching it", () => {
    // Module scope during `wrangler deploy`. Neither of these may throw.
    const runtime = workersAIModels(unpopulated, config);
    const pair = runtime.createModelPair();

    // The ids are known without the provider, which is what makes `primaryId()`
    // safe to log on a path that has not called the model yet.
    expect(pair.primaryId()).toBe(TEST_MODELS.chatModelId);
    expect(pair.fallbackId()).toBe(TEST_MODELS.fallbackChatModelId);
  });

  it("throws only once a model is actually requested", () => {
    const pair = workersAIModels(unpopulated, config).createModelPair();

    // The other half of the same property: the failure is deferred, not gone.
    expect(() => pair.primary()).toThrow();
  });

  it("reports the ids a recipe overrides, not the configured pair", () => {
    const pair = workersAIModels(unpopulated, config).createModelPair({
      primaryModelId: "recipe:primary",
      fallbackModelId: "recipe:fallback"
    });

    expect(pair.primaryId()).toBe("recipe:primary");
    expect(pair.fallbackId()).toBe("recipe:fallback");
  });

  it("passes injected models through without building a provider", () => {
    const model = { modelId: "injected" } as never;

    const pair = createWorkersAIModelRuntime({
      ai: unpopulated.AI,
      config
    }).createModelPair({ model });

    // The test-override path the error-path specs rely on: a pair that never
    // reaches the binding, so a throwing model can be handed in without a live
    // `AI` — which is exactly the case that would break if the provider were
    // built up front.
    expect(pair.primary()).toBe(model);
    expect(pair.fallback()).toBe(model);
  });
});
/**
 * The other half of what this provider is for: how its failures arrive.
 *
 * Core classifies a failed model call on structure alone — `isRetryable` on an
 * `APICallError`, and nothing else (see
 * {@link file://../inference.ts isTransientAiError}). The binding does not throw
 * those. It throws plain `Error`s carrying an internal code, and
 * `workers-ai-provider` is what maps them onto the documented HTTP status the
 * flag is derived from.
 *
 * So that mapping is load-bearing for every round this package runs, and it
 * lives in a peer dependency. If a bump ever dropped it, nothing else here would
 * fail: capacity blips would quietly stop being retried, spend the fallback slot
 * and fail Tasks that a second's wait would have answered. These two assert the
 * contract in both directions.
 */
describe("workers-ai failures", () => {
  /** A binding that fails the way the platform does: a code inside a sentence. */
  const failing = (message: string) =>
    createWorkersAIModelRuntime({
      ai: {
        run: async () => {
          throw new Error(message);
        }
      } as unknown as Ai,
      config
    })
      .createModelPair()
      .primary();

  /**
   * `maxRetries: 0` is the SDK's own knob, and this is the only place in the
   * package that sets it: it is what makes the error arrive as the provider
   * raised it rather than wrapped in a retry error, and skips a backoff the
   * binding gives no `retry-after` to shorten. Nothing in the runtime configures
   * retries at all.
   */
  const failure = async (message: string): Promise<unknown> => {
    try {
      await generateText({
        model: failing(message),
        prompt: "hello",
        maxRetries: 0
      });
    } catch (error) {
      return error;
    }
    throw new Error("expected the model call to fail");
  };

  it("raises a capacity failure as one core waits out", async () => {
    const error = await failure(
      "3040: Capacity temporarily exceeded, please try again."
    );

    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(429);
    expect(isTransientAiError(error)).toBe(true);
  });

  it("raises a blocked account as the deterministic failure it is", async () => {
    // Its sentence reads like an outage and its status does not. Core reads the
    // status, so the round fails instead of retrying until the step gives up.
    const error = await failure("3023: Service unavailable for account");

    expect((error as APICallError).statusCode).toBe(403);
    expect(isTransientAiError(error)).toBe(false);
  });
});
