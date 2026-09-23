import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TEST_MODELS } from "../testing/fixtures.js";
import { definePlugin } from "../contract/plugin.js";
import type { SubtaskTypeSpec } from "../contract/recipe.js";
import { createAgentRuntime } from "./index.js";
import { failExecution } from "./fail.js";

/**
 * What core runs when the Workflow gives up on an execution: the owning plugin's
 * `onFail`, or its `onAbort` when it declares none.
 */

const workType = (key: string): SubtaskTypeSpec => ({
  key,
  description: `does ${key} things`,
  params: z.object({}),
  capability: `You can delegate ${key} work.`,
  recipe: {
    key,
    version: 1,
    soul: `You are the ${key} subagent.`,
    toolFamilies: [],
    enabled: true,
    limits: {},
    historyWindow: 10,
    reportMetrics: false
  }
});

const ctx = (type: string) => ({
  taskId: "t1",
  subtaskId: 1,
  type,
  params: {},
  toolFamilies: []
});

describe("an execution the Workflow gave up on", () => {
  it("goes to onFail, and answers what it said was left", async () => {
    const calls: string[] = [];
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        definePlugin({
          key: "keeps",
          subtaskType: workType("kept-work"),
          onAbort: async () => {
            calls.push("abort");
          },
          onFail: async () => {
            calls.push("fail");
            return "Its work is on branch b.";
          }
        })
      ]
    });

    expect(await failExecution(rt, ctx("kept-work"))).toBe(
      "Its work is on branch b."
    );
    // Instead of, not as well as: `onAbort` is the cancel path's discard.
    expect(calls).toEqual(["fail"]);
  });

  it("goes to onAbort for a plugin that declares no onFail", async () => {
    const calls: string[] = [];
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        definePlugin({
          key: "releases",
          subtaskType: workType("released-work"),
          onAbort: async () => {
            calls.push("abort");
          }
        })
      ]
    });

    expect(await failExecution(rt, ctx("released-work"))).toBeUndefined();
    expect(calls).toEqual(["abort"]);
  });

  it("treats an empty answer, and a throw, as nothing to say", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          definePlugin({
            key: "quiet",
            subtaskType: workType("quiet-work"),
            onFail: async () => ""
          }),
          definePlugin({
            key: "broken",
            subtaskType: workType("broken-work"),
            onFail: async () => {
              throw new Error("could not keep it");
            }
          })
        ]
      });

      expect(await failExecution(rt, ctx("quiet-work"))).toBeUndefined();
      // The row is already failed; a cleanup that threw must not undo that.
      expect(await failExecution(rt, ctx("broken-work"))).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      // And a type no plugin owns has nothing to release.
      expect(await failExecution(rt, ctx("nobody"))).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});
