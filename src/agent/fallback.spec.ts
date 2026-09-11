import { describe, it, expect } from "vitest";
import { APICallError, generateText, RetryError, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { withFallback } from "./fallback.js";
import { CredentialRejectedError } from "./errors.js";
import type { ModelPair } from "./model.js";
import {
  countingModel,
  finalReply,
  throwingModel
} from "../testing/mock-model.js";
import { TEST_MODELS } from "../testing/fixtures.js";

/**
 * The fallback slot as a model wrapper.
 *
 * Two of these assert something no loop above can see, and they are the reason
 * this exists rather than a shared ladder helper: **which** model answered a
 * given step, and that a fallback reached mid-call is handed the work the
 * primary already did instead of starting the call again.
 */

/** Zeroed usage, in the shape a `doGenerate` result must carry. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

const rateLimit = () =>
  new APICallError({
    message: "429 rate limited",
    url: "mock:chat:test",
    requestBodyValues: {},
    statusCode: 429,
    // Zero for the reason `rateLimitedModel` gives: the SDK honours the header,
    // and these specs are about which model is asked, not about waiting.
    responseHeaders: { "retry-after": "0" }
  });

const badRequest = () =>
  new APICallError({
    message: "400 malformed request",
    url: "mock:chat:test",
    requestBodyValues: {},
    statusCode: 400
  });

/** A pair over two scripted models, shaped like a runtime's. */
function pair(
  primary: MockLanguageModelV3,
  fallback: MockLanguageModelV3
): ModelPair {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => TEST_MODELS.chatModelId,
    fallbackId: () => TEST_MODELS.fallbackChatModelId
  } as unknown as ModelPair;
}

/**
 * A model whose behaviour changes with the call number, which neither
 * `/testing` helper can express — and which is the whole of the mid-call case:
 * a primary that works, does something with a tool, and only then fails.
 */
function scripted(...calls: Array<"tool-call" | "reply" | Error>): {
  model: MockLanguageModelV3;
  calls: () => number;
} {
  let n = 0;
  return {
    model: new MockLanguageModelV3({
      doGenerate: async () => {
        const step = calls[Math.min(n, calls.length - 1)];
        n += 1;
        if (step instanceof Error) throw step;
        if (step === "reply")
          return {
            content: [{ type: "text" as const, text: "answered" }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: USAGE,
            warnings: []
          };
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call_${n}`,
              toolName: "ping",
              input: "{}"
            }
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USAGE,
          warnings: []
        };
      }
    }),
    calls: () => n
  };
}

describe("withFallback", () => {
  it("answers from the fallback when the primary's call fails", async () => {
    const primary = throwingModel(badRequest());
    const fallback = countingModel(finalReply("from the fallback"));

    const result = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello"
    });

    expect(result.toolCalls[0]?.toolName).toBe("final_reply");
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  it("names the model that answered, not the slot that was asked", async () => {
    const primary = throwingModel(badRequest());
    const fallback = countingModel(finalReply("from the fallback"));

    const result = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello"
    });

    // The only record of the swap that survives the call. Without it every log
    // and every `RecipeExecutionResult` names the configured primary, whichever
    // model produced the answer — the wrapper reports the primary's id as its
    // own, and these mocks set no response metadata of their own.
    expect(result.finalStep.response.modelId).toBe(
      TEST_MODELS.fallbackChatModelId
    );
  });

  it("hands a fallback reached mid-call the work the primary already did", async () => {
    let pings = 0;
    // Works once, then fails: the shape that used to cost a round its progress.
    const primary = scripted("tool-call", badRequest());
    const fallback = scripted("reply");

    const result = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello",
      tools: {
        ping: tool({
          inputSchema: z.object({}),
          execute: async () => {
            pings += 1;
            return "pong";
          }
        })
      },
      stopWhen: stepCountIs(5)
    });

    // The point of the whole module: the tool ran once, and the model that
    // finished the call is not the one that started it. A ladder one level up
    // re-runs the call instead, and the tool runs twice.
    expect(pings).toBe(1);
    expect(result.text).toBe("answered");
    expect(result.steps.map((s) => s.response.modelId)).toEqual([
      TEST_MODELS.chatModelId,
      TEST_MODELS.fallbackChatModelId
    ]);
  });

  it("offers a rate limit to the other model rather than waiting it out", async () => {
    const primary = throwingModel(rateLimit());
    const fallback = countingModel(finalReply("the other slot had capacity"));

    await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello"
    });

    // One call each: the SDK's retry never engages, because the fallback
    // answered before the primary's error reached it.
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  it("costs a step's retries against both slots when neither has capacity", async () => {
    const primary = throwingModel(rateLimit());
    const fallback = throwingModel(rateLimit());

    const error = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello"
    }).catch((e: unknown) => e);

    // The retry wraps this module from outside, so every attempt it makes costs
    // both slots. The counts are the SDK's own default times two, pinned here so
    // a release that raises that default fails a test rather than quietly eating
    // the headroom `platform.ts` budgets for a chunk step.
    expect(RetryError.isInstance(error)).toBe(true);
    expect(primary.calls()).toBe(3);
    expect(fallback.calls()).toBe(3);
  });

  it("throws the transient error when only one of the two is", async () => {
    const primary = throwingModel(rateLimit());
    const fallback = throwingModel(badRequest());

    const error = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello",
      maxRetries: 0
    }).catch((e: unknown) => e);

    // A fault a retry could clear is worth retrying the step for, whichever slot
    // hit it — the answer the ladders reached for before this module existed.
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(429);
  });

  it("reports a credential the fallback refused over a blip on the primary", async () => {
    const primary = throwingModel(rateLimit());
    const fallback = throwingModel(
      new CredentialRejectedError("invalid bearer token", {
        source: "provider",
        status: 401
      })
    );

    const error = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello"
    }).catch((e: unknown) => e);

    // Only one of the two can be reported, and preferring the transient one
    // sends the step back to present a token that is already dead — once per
    // retry — and ends the task saying capacity was the problem.
    expect(CredentialRejectedError.isInstance(error)).toBe(true);
  });

  it("leaves the fallback unspent on a refused credential", async () => {
    const primary = throwingModel(
      new CredentialRejectedError("401 from the provider", {
        source: "provider",
        status: 401
      })
    );
    const fallback = countingModel(finalReply("never reached"));

    const error = await generateText({
      model: withFallback(pair(primary.model, fallback.model))(),
      prompt: "hello"
    }).catch((e: unknown) => e);

    // Both slots sit behind one credential, so the second can only present the
    // same refused token.
    expect(CredentialRejectedError.isInstance(error)).toBe(true);
    expect(fallback.calls()).toBe(0);
  });

  it("leaves the fallback unspent on a cancelled call", async () => {
    const controller = new AbortController();
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }
    });
    const fallback = countingModel(finalReply("never reached"));

    await generateText({
      model: withFallback(pair(primary, fallback.model))(),
      prompt: "hello",
      abortSignal: controller.signal
    }).catch(() => undefined);

    expect(fallback.calls()).toBe(0);
  });

  it("reports the spent primary, which nothing else records", async () => {
    const seen: Array<{ modelId: string; error: unknown }> = [];
    const primary = throwingModel(badRequest());
    const fallback = countingModel(finalReply("from the fallback"));

    await generateText({
      model: withFallback(pair(primary.model, fallback.model), {
        onFallback: (notice) => seen.push(notice)
      })(),
      prompt: "hello"
    });

    // A call the fallback rescues throws nothing, so this is the caller's only
    // account of what the primary cost.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.modelId).toBe(TEST_MODELS.chatModelId);
    expect(APICallError.isInstance(seen[0]?.error)).toBe(true);
  });

  it("refuses a slot that hands back a model id instead of a model", async () => {
    const idOnly = {
      primary: () => "some-provider/some-model",
      fallback: () => "some-provider/other-model",
      primaryId: () => TEST_MODELS.chatModelId,
      fallbackId: () => TEST_MODELS.fallbackChatModelId
    } as unknown as ModelPair;

    // Said here rather than at the first failure, where a fallback that was
    // never there would look like a fallback that did not help.
    expect(() => withFallback(idOnly)()).toThrow(TypeError);
  });
});
