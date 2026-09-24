import { describe, it, expect } from "vitest";
import { ARTIFACT_VIEWER_HTML } from "./viewer.js";

/**
 * The page's script, compiled.
 *
 * In the Node realm because workerd forbids the only thing that can ask the
 * question: `new Function` is dynamic code generation, which the runtime blocks
 * outright, so the workers-realm spec next door can assert what the page *says*
 * and never that a browser would accept it.
 *
 * That matters here because the script is not written as a string — it carries a
 * function's own source, interpolated by `toString()` (see
 * {@link file://./markdown.ts renderNoteMarkdown}). Nothing else in this repo
 * type-checks, lints or runs that arrangement end to end: a build that mangled the
 * source, or an editor that left it half-valid, produces a page that throws on
 * load and a suite that is still green. Compiling it costs one test.
 *
 * Compiled and not run: the body is an IIFE that reaches for `document` on its
 * first line, and there is no DOM here either.
 */
describe("the artifact viewer's script", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(ARTIFACT_VIEWER_HTML)?.[1];

  it("is one block of parseable JavaScript", () => {
    expect(script).toBeDefined();
    expect(() => new Function(script as string)).not.toThrow();
  });
});
