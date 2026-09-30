import { describe, expect, it } from "vitest";
import type { SessionMessage } from "agents/sessions";
import { MockLanguageModelV4 } from "ai/test";
import { compaction } from "./history.js";

/**
 * The compaction core's Think classes run. What is core's own is the call it
 * summarizes with; the algorithm around it is agents'.
 */

const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

/** A history long enough that most of it falls outside the kept tail. */
const history: SessionMessage[] = Array.from({ length: 12 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  parts: [{ type: "text", text: `message ${i} `.repeat(200) }]
}));

describe("compaction", () => {
  it("summarizes without reasoning", async () => {
    const asked: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        asked.push(options.reasoning);
        return {
          content: [{ type: "text", text: "the summary" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: []
        };
      }
    });

    const result = await compaction(() => model, 100)(history);

    expect(result).not.toBeNull();
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(["none"]));
  });
});
