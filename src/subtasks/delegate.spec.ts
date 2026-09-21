import { describe, it, expect } from "vitest";
import { asSchema } from "ai";
import { delegateCallOutput, makeDelegateTool } from "./delegate.js";
import { makeSubtaskTypes } from "./subtask-types.js";
import type { CompositionBranch } from "./types.js";

/**
 * What a delegating model is allowed to learn about a branch that did not
 * complete.
 *
 * This is the file that guards a reversal. `output` used to be `null` for
 * anything but `completed`, and the cost was measured: a parent that could see
 * `status: "failed"` and nothing else re-delegated one identical task twelve
 * times against a container whose TLS was broken, then apologised to the user
 * for a wall it had never been shown. The rule now is that a facet's `error` is
 * addressed to the model, so it reaches the model.
 */

const branch = (over: Partial<CompositionBranch> = {}): CompositionBranch => ({
  subtaskId: 1,
  round: 0,
  ordinal: 0,
  type: "claude-code",
  prompt: "edit the README",
  params: {},
  status: "completed",
  resultParts: [{ kind: "text", text: "done" }],
  error: null,
  ...over
});

describe("delegateCallOutput", () => {
  it("reports what a completed branch produced", () => {
    const [outcome] = delegateCallOutput([branch()]);
    expect(outcome?.status).toBe("completed");
    expect(outcome?.output).toBe("done");
  });

  it("tells the model why a failed branch failed", () => {
    const [outcome] = delegateCallOutput([
      branch({
        status: "failed",
        resultParts: null,
        error: "the dependency install failed: SELF_SIGNED_CERT_IN_CHAIN"
      })
    ]);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.output).toContain("SELF_SIGNED_CERT_IN_CHAIN");
  });

  /**
   * A branch with nothing to say still says nothing. Cancellation is the usual
   * way to get here, and inventing a sentence for it would read to the model as
   * a diagnosis somebody made.
   */
  it("stays null for a branch that carries no reason", () => {
    const [outcome] = delegateCallOutput([
      branch({ status: "canceled", resultParts: null, error: null })
    ]);
    expect(outcome?.output).toBeNull();
  });

  /** A clipped report reads as complete — see `DelegateSubtaskOutcome`. */
  it("carries a long report and a long error whole", () => {
    const report = "x".repeat(20_000);
    const error = "y".repeat(20_000);
    const [done, failed] = delegateCallOutput([
      branch({
        status: "completed",
        resultParts: [{ kind: "text", text: report }]
      }),
      branch({ status: "failed", resultParts: null, error })
    ]);
    expect(done?.output).toBe(report);
    expect(failed?.output).toBe(error);
  });
});

/** A converted JSON Schema, as far as these assertions walk it. */
interface SchemaNode {
  description?: string;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

describe("the delegate tool's schema", () => {
  const types = makeSubtaskTypes([
    {
      key: "general",
      description: "General work.",
      params: null,
      capability: "You can delegate general work.",
      recipe: {
        key: "general",
        version: 1,
        soul: "You are a general subagent.",
        toolFamilies: [],
        enabled: true,
        limits: {},
        historyWindow: 10,
        reportMetrics: false
      }
    }
  ]);

  /**
   * What the model reads while it fills the arguments in, which the system
   * prompt is not: without it, `reply` was sent as a top-level `prompt`.
   */
  it("says what every field is for, in the schema the provider is sent", async () => {
    const root = (await asSchema(makeDelegateTool(types, 4).inputSchema)
      .jsonSchema) as SchemaNode;
    const subtask = root.properties?.subtasks?.items?.properties;

    for (const field of [
      root.properties?.reply,
      root.properties?.subtasks,
      subtask?.type,
      subtask?.prompt,
      subtask?.referenceIndexes
    ]) {
      expect(field?.description).toBeTruthy();
    }
    expect(root.properties?.reply?.description).toMatch(/prompt/);
    // Describing a field keeps the non-blank rule it was already shown.
    expect(root.properties?.reply?.pattern).toBe("\\S");
  });
});
