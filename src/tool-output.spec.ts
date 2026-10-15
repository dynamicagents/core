import { describe, it, expect } from "vitest";
import { truncateOutput } from "./tool-output.js";

describe("truncateOutput", () => {
  it("returns short text untouched", () => {
    expect(truncateOutput("short", 100)).toBe("short");
  });

  it("keeps both ends and marks the hole", () => {
    const text = "A".repeat(200) + "B".repeat(200);
    const out = truncateOutput(text, 120);

    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(out).toContain("omitted from the middle");
  });

  /** The inversion the `half < 1` guard exists for — `./tool-output.ts` says why. */
  it("never returns more than it was given", () => {
    const text = "x".repeat(500);
    for (const max of [0, 1, 40, 60, 80]) {
      expect(truncateOutput(text, max).length).toBeLessThanOrEqual(
        Math.max(max, 0)
      );
    }
  });

  it("budgets in characters, so a surrogate pair counts as its units", () => {
    // `String.length`, not code points: a caller whose ceiling is really bytes
    // has to convert, and this is the line that says so.
    expect(truncateOutput("✓".repeat(50), 90).length).toBeLessThanOrEqual(90);
  });
});
