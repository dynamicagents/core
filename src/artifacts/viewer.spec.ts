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
 * {@link file://./transcript.spec.ts transcript.spec.ts}, and what a note
 * *becomes* — every markdown rule, and every payload that must not survive one —
 * in {@link file://./markdown.spec.ts markdown.spec.ts}, against the same
 * function this page carries.
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

  it("carries the note renderer's own source", () => {
    // Interpolated by `toString()`, which is what lets the rendering be a tested
    // function instead of a string in a template nothing can run. Two things only
    // that function emits, so this fails if the page stops carrying it.
    expect(ARTIFACT_VIEWER_HTML).toContain("noopener noreferrer");
    expect(ARTIFACT_VIEWER_HTML).toContain("&lt;");
  });

  it("renders a note rather than printing it", () => {
    expect(ARTIFACT_VIEWER_HTML).toContain(
      "body.innerHTML = renderMarkdown(entry.text);"
    );
  });

  it("closes its script exactly once", () => {
    // The page embeds a function whose source is full of angle brackets and
    // backticks, and a `</script` anywhere in it — in a string, in a regex — ends
    // the block early and leaves the rest of the renderer on the page as text.
    expect(ARTIFACT_VIEWER_HTML.match(/<\/script/g)).toHaveLength(1);
  });

  it("renders a replay and a live note down one path", () => {
    // A reconnect's history arrives as the same `entry` frames the live stream
    // sends, so there is one `render` and one caller of the renderer inside it. A
    // second path is a second way for the two to look different.
    expect(ARTIFACT_VIEWER_HTML.match(/renderMarkdown\(/g)).toHaveLength(1);
    expect(ARTIFACT_VIEWER_HTML.match(/logEl\.append\(/g)).toHaveLength(1);
  });

  it("keeps the log a live region that announces additions", () => {
    expect(ARTIFACT_VIEWER_HTML).toContain(
      '<div id="log" role="log" aria-live="polite" aria-relevant="additions">'
    );
    expect(ARTIFACT_VIEWER_HTML).toContain('id="status" role="status"');
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
