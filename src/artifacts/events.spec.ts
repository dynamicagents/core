import { describe, it, expect } from "vitest";
import { resumeFrom } from "./events.js";

/**
 * The wire format's one decision: what a reconnecting reader is allowed to
 * resume from.
 *
 * Every case here is a header value a proxy, an extension or a hand-edited
 * `curl` can produce, and the property they all check is one-directional — an
 * unreadable header costs duplicates, never a gap. Overshooting the real
 * sequence is the only outcome that loses data, so anything short of an exact
 * decimal sequence has to come back as 0.
 */
describe("resumeFrom", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["0", 0],
    ["12345", 12345]
  ])("resumes after a whole sequence (%s)", (header, expected) => {
    expect(resumeFrom(header)).toBe(expected);
  });

  it.each([
    // `parseInt` reads a number out of each of these, which is the bug the
    // grammar exists to refuse: honouring the prefix skips real entries.
    ["a numeric prefix", "2garbage"],
    ["a decimal", "2.5"],
    ["exponent notation", "2e3"],
    ["a signed value", "+2"],
    ["a negative", "-1"],
    ["surrounding space", " 2 "],
    ["the empty string", ""],
    ["a word", "not-a-number"],
    ["an absent header", null],
    // Past `Number.MAX_SAFE_INTEGER`, so not a sequence this stream wrote.
    ["more digits than a sequence has", "9".repeat(20)]
  ])("replays from zero for %s", (_label, header) => {
    expect(resumeFrom(header)).toBe(0);
  });
});
