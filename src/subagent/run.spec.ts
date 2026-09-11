import { describe, it, expect } from "vitest";
import { APICallError } from "ai";
import {
  runResumableChunk,
  type ChunkRunDeps,
  type ChunkRunState
} from "./run.js";
import { CredentialRejectedError } from "../agent/errors.js";
import type { ModelPair } from "../agent/model.js";
import {
  countingModel,
  mockModel,
  throwingModel
} from "../testing/mock-model.js";
import { TEST_MODELS } from "../testing/fixtures.js";

/**
 * The subagent runner's attempt ladder — the chunk loop's and the budget
 * summary's.
 *
 * Both shipped from a published package with no coverage at all, which is how
 * the second came to be a near-verbatim copy of the first: nothing failed when
 * they drifted. What these pin is the half a model wrapper cannot own — a call
 * that **succeeded** and produced nothing usable, and the credential that must
 * not reach the second slot.
 */

const NOW = 1_700_000_000_000;

function pair(primary: unknown, fallback: unknown): ModelPair {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => TEST_MODELS.chatModelId,
    fallbackId: () => TEST_MODELS.fallbackChatModelId
  } as unknown as ModelPair;
}

function deps(overrides: Partial<ChunkRunDeps> = {}): ChunkRunDeps {
  return {
    system: "You are a subagent.",
    seedPrompt: "Do the thing.",
    models: pair(mockModel({ text: "done" }), mockModel({ text: "done" })),
    tools: {},
    limits: { maxTurns: 8, maxWallMs: 60_000 },
    chunkSoftMs: 60_000,
    historyWindow: 20,
    toolOutputWindow: 4,
    reportMetrics: false,
    maxOutputTokens: 4096,
    now: () => NOW,
    progress: [],
    checkpoint: () => undefined,
    ...overrides
  };
}

/** A run that has already spent its turns, so the next chunk must summarize. */
const spent = (): ChunkRunState => ({
  messages: [{ role: "user", content: "Do the thing." }],
  turns: 8,
  llmCalls: 3,
  startedAtMs: NOW
});

const rateLimit = () =>
  new APICallError({
    message: "429 rate limited",
    url: "mock:chat:test",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after": "0" }
  });

const badRequest = () =>
  new APICallError({
    message: "400 malformed request",
    url: "mock:chat:test",
    requestBodyValues: {},
    statusCode: 400
  });

describe("the chunk loop's ladder", () => {
  it("completes on the fallback when the primary's call fails", async () => {
    const primary = throwingModel(badRequest());
    const fallback = countingModel({ text: "the fallback answered" });

    const { outcome, state } = await runResumableChunk(
      null,
      deps({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome.done).toBe(true);
    expect(outcome.done && outcome.result).toMatchObject({
      status: "completed",
      modelId: TEST_MODELS.fallbackChatModelId
    });
    // Every provider call the chunk made, which is what the metrics footer
    // reports — a spent primary is spend whether or not it produced anything.
    expect(state.llmCalls).toBe(2);
  });

  it("reaches the second model when the first answers with nothing", async () => {
    const primary = countingModel({ text: "   " });
    const fallback = countingModel({ text: "the fallback answered" });

    const { outcome } = await runResumableChunk(
      null,
      deps({ models: pair(primary.model, fallback.model) })
    );

    // The failure a wrapper around the model cannot see: the call succeeded.
    expect(outcome.done && outcome.result.status).toBe("completed");
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  it("reaches the second model when the first is cut off at the ceiling", async () => {
    const primary = countingModel({ text: "half an ans", truncated: true });
    const fallback = countingModel({ text: "the fallback answered" });

    const { outcome } = await runResumableChunk(
      null,
      deps({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome.done && outcome.result.status).toBe("completed");
    expect(fallback.calls()).toBe(1);
  });

  it("fails the chunk with both models' diagnostics behind it", async () => {
    const primary = countingModel({ text: "" });
    const fallback = countingModel({ text: "" });

    const { outcome } = await runResumableChunk(
      null,
      deps({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome.done && outcome.result.status).toBe("failed");
    expect(
      outcome.done && outcome.result.status === "failed" && outcome.result.error
    ).toContain("recipe exhausted");
  });

  it("stops on a refused credential without spending the fallback", async () => {
    const primary = throwingModel(
      new CredentialRejectedError("401 from the provider", {
        source: "provider",
        status: 401
      })
    );
    const fallback = countingModel({ text: "never reached" });

    const { outcome } = await runResumableChunk(
      null,
      deps({ models: pair(primary.model, fallback.model) })
    );

    // Returned, not thrown: a throw is retried by the Workflow step, which is
    // the other spend this classification exists to avoid.
    expect(outcome.done && outcome.result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("credential")
    });
    expect(fallback.calls()).toBe(0);
  });

  it("throws a transient fault for the step to retry", async () => {
    const primary = throwingModel(rateLimit());
    const fallback = throwingModel(rateLimit());

    await expect(
      runResumableChunk(
        null,
        deps({ models: pair(primary.model, fallback.model) })
      )
    ).rejects.toThrow();
  });
});

describe("the budget summary's ladder", () => {
  it("summarizes on the fallback when the primary's call fails", async () => {
    const primary = throwingModel(badRequest());
    const fallback = countingModel({ text: "here is the report" });

    const { outcome } = await runResumableChunk(
      spent(),
      deps({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome.done && outcome.result).toMatchObject({
      status: "completed",
      modelId: TEST_MODELS.fallbackChatModelId
    });
  });

  it("still returns a notice when neither model writes the report", async () => {
    const primary = countingModel({ text: "" });
    const fallback = countingModel({ text: "" });

    const { outcome } = await runResumableChunk(
      spent(),
      deps({ models: pair(primary.model, fallback.model) })
    );

    // "Uncapped but bounded" means the ceiling yields *something*: a run whose
    // summary also failed still completes rather than dropping the work.
    expect(outcome.done && outcome.result.status).toBe("completed");
    expect(fallback.calls()).toBe(1);
  });
});
