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
 * The subagent runner's attempt ladders — the chunk loop's and the budget
 * summary's.
 *
 * What they pin is the half a model wrapper cannot own: a call that
 * **succeeded** and produced nothing usable — truncated at the ceiling, or
 * empty — where the other model is worth asking. Plus the two failures that
 * must reach neither slot twice, and which model a failure is reported against.
 *
 * The summary ladder is the same decision over a single no-tools call, and it
 * is covered on its own because a rule that holds in one and not the other
 * makes a run end differently depending on whether its budget ran out.
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
    // One invocation, not two: the slot changed inside a single call, which is
    // the whole point of it. See the field's own doc for why the footer counts
    // what the runner asked for rather than what the providers were sent.
    expect(state.llmCalls).toBe(1);
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

  it("blames the slot that refused the credential, not the one that blipped", async () => {
    const primary = throwingModel(rateLimit());
    const fallback = throwingModel(
      new CredentialRejectedError("invalid bearer token", {
        source: "provider",
        status: 401
      })
    );

    const { outcome } = await runResumableChunk(
      null,
      deps({ models: pair(primary.model, fallback.model) })
    );

    // `RecipeExecutionResult.modelId` is read by a human deciding which secret
    // to rotate. Naming the model the chunk *started* on names a working one.
    expect(outcome.done && outcome.result).toMatchObject({
      status: "failed",
      modelId: TEST_MODELS.fallbackChatModelId
    });
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
