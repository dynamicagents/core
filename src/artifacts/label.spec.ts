import { describe, it, expect } from "vitest";
import { labelSubagentNote, subagentNoteLabel } from "./label.js";

describe("a note's author", () => {
  it("names the sub-agent and its run, both halves always", () => {
    expect(
      labelSubagentNote("ran the tests", { type: "Coder", ordinal: 2 })
    ).toBe("[Coder 2] ran the tests");
  });

  it("gives a renderer with a column the name without brackets", () => {
    expect(subagentNoteLabel({ type: "Coder", ordinal: 0 })).toBe("Coder 0");
  });
});
