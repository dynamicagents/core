import { describe, it, expect } from "vitest";
import { labelSubagentNote } from "./progress.js";

/**
 * What a reader can tell about a note's author from the note alone.
 *
 * The label is the only thing that survives to the gatekeeper — the A2A
 * `working` Task carries text and a dedupe key, and the key is not rendered —
 * so these assertions are the whole contract, not a sample of it.
 */
describe("labelSubagentNote", () => {
  it("names the type and the ordinal ahead of the note", () => {
    expect(
      labelSubagentNote("That's 20 primes, ending at 71 — correct.", {
        type: "claude-code",
        ordinal: 0
      })
    ).toBe("[claude-code 0] That's 20 primes, ending at 71 — correct.");
  });

  it("prints ordinal 0 rather than hiding or shifting it", () => {
    // 0-based and verbatim on purpose: the number in the thread has to be the
    // number in the logs and in the `subtasks` table, and the first branch of a
    // Task is the one most likely to be cross-referenced.
    expect(
      labelSubagentNote("reading the changelog", {
        type: "general",
        ordinal: 0
      })
    ).toBe("[general 0] reading the changelog");
  });

  it("distinguishes branches that share a type", () => {
    // One round fanning out to several branches of one type, interleaving in
    // one thread — the case a type alone cannot separate.
    const notes = [0, 1, 2].map((ordinal) =>
      labelSubagentNote("done", { type: "general", ordinal })
    );
    expect(notes).toEqual([
      "[general 0] done",
      "[general 1] done",
      "[general 2] done"
    ]);
  });

  it("keeps a later round's Task-wide ordinal", () => {
    // Ordinals continue across rounds rather than restarting, and that is the
    // point: round 2's `code 3` shares no session with round 1's `code 0`.
    expect(labelSubagentNote("tests pass", { type: "code", ordinal: 3 })).toBe(
      "[code 3] tests pass"
    );
  });

  it("leaves the note itself untouched", () => {
    // Including text that already names its own domain — the ARC tools emit
    // "ARC <game>: reached level 2" — which the label prefixes rather than
    // rewrites.
    const text = "ARC ls20: reached level 2";
    const labelled = labelSubagentNote(text, { type: "arc-game", ordinal: 0 });
    expect(labelled).toBe(`[arc-game 0] ${text}`);
    expect(labelled.endsWith(text)).toBe(true);
  });
});
