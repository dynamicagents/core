import { describe, it, expect } from "vitest";
import { ARTIFACT_VIEWER_HTML } from "./viewer.js";

/**
 * What the page is wired to print.
 *
 * The viewer is one immutable string with no DOM to run in — workerd has none —
 * so what is pinned here is the wiring rather than the rendering: that the name
 * a reader sees arrives on the stream, that the tab and the heading take the
 * same one, and that no kind is spelled in the page at all. The data those two
 * read is covered end to end in
 * {@link file://./transcript.spec.ts transcript.spec.ts}.
 */
describe("the artifact viewer", () => {
  it("titles itself from the name the kind declared", () => {
    expect(ARTIFACT_VIEWER_HTML).toContain("data.displayName");
  });

  it("falls back to the kind for an artifact carrying no name", () => {
    // One opened under a bare id, and every one opened before the column
    // existed — a month of them, for as long as retention keeps them.
    expect(ARTIFACT_VIEWER_HTML).toContain('data.kind.replace(/-/g, " ")');
  });

  it("puts one name in both the tab and the heading", () => {
    expect(ARTIFACT_VIEWER_HTML).toContain(
      "document.title = kindEl.textContent;"
    );
  });

  it("names no kind of its own", () => {
    // The rule the barrel is arranged around, and the one this page is the
    // easiest place to break: a title hardcoded here is a second page waiting
    // to happen, and the moment there are two pages there are two of everything
    // else as well.
    expect(ARTIFACT_VIEWER_HTML).not.toContain("session-transcript");
    expect(ARTIFACT_VIEWER_HTML).not.toContain("Session Transcript");
  });
});
