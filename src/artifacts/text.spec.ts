import { describe, it, expect } from "vitest";
import type { ArtifactContents } from "./do.js";
import {
  artifactMarkdown,
  artifactMarkdownResponse,
  wantsHtml
} from "./text.js";

/**
 * The markdown half of a link, and the one header that chooses it.
 *
 * Pure, so what the document says is pinned here and `./route.spec.ts` only has
 * to show that the route reaches it.
 */

const contents = (over: Partial<ArtifactContents> = {}): ArtifactContents => ({
  kind: "discovery-report",
  status: null,
  locked: false,
  entries: [],
  ...over
});

/** 2026-10-22T09:30:00.000Z, as a note's `at`. */
const AT = Date.UTC(2026, 9, 22, 9, 30);

describe("wantsHtml", () => {
  it.each([
    ["a browser", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*"],
    ["an explicit ask", "text/html"],
    ["a quality value on it", "text/html;q=0.9"],
    ["an odd case", "TEXT/HTML"],
    ["whitespace around it", " application/json , text/html "]
  ])("serves the page for %s", (_label, accept) => {
    expect(wantsHtml(accept)).toBe(true);
  });

  it.each([
    // What `curl` and a bare `fetch` send. Reading this as the page is the
    // failure the markdown representation exists to answer.
    ["anything at all", "*/*"],
    ["no header", null],
    ["nothing in particular", ""],
    // `text/*` admits markdown, so there is no reason to answer markup.
    ["any text type", "text/*"],
    ["a sibling of it", "application/xhtml+xml"],
    // Specifically not a substring match: a type that merely starts the same
    // way is a different type.
    ["a type that only looks like it", "text/htmlx"],
    ["markdown", "text/markdown"]
  ])("serves the text for %s", (_label, accept) => {
    expect(wantsHtml(accept)).toBe(false);
  });
});

describe("artifactMarkdown", () => {
  it("heads the document with the kind, and says nothing of a status it has not got", () => {
    expect(artifactMarkdown(contents())).toMatch(/^# discovery-report\n/);
    expect(artifactMarkdown(contents())).not.toContain("Status:");
  });

  it("names the status an artifact finished in", () => {
    expect(artifactMarkdown(contents({ status: "filed" }))).toContain(
      "Status: filed"
    );
  });

  it("says when nothing has been recorded", () => {
    // A real state, and a bare heading reads as the reader's own mistake.
    expect(artifactMarkdown(contents())).toContain(
      "Nothing has been recorded on this artifact."
    );
  });

  it("writes each note under who wrote it and when, with its text as recorded", () => {
    const markdown = artifactMarkdown(
      contents({
        entries: [
          {
            sequence: 1,
            label: "report",
            text: "# The run\n\nIt ran.",
            at: AT
          },
          { sequence: 2, label: "coder 1", text: "pushed the branch", at: AT }
        ]
      })
    );

    expect(markdown).toContain("## report · 2026-10-22T09:30:00.000Z");
    expect(markdown).toContain("# The run\n\nIt ran.");
    expect(markdown).toContain("## coder 1 · 2026-10-22T09:30:00.000Z");
    expect(markdown).not.toContain(
      "Nothing has been recorded on this artifact."
    );
  });

  it("takes a card's title and leaves its sections to the note", () => {
    const markdown = artifactMarkdown(
      contents({
        entries: [
          {
            sequence: 1,
            label: "coder 1",
            text: "ran the suite",
            at: AT,
            detail: {
              title: "Bash",
              status: "ok",
              sections: [{ label: "Output", body: "317 passed" }]
            }
          }
        ]
      })
    );

    expect(markdown).toContain("## coder 1 · Bash · 2026-10-22T09:30:00.000Z");
    // A card is an affordance of the page: its sections are not the note.
    expect(markdown).not.toContain("317 passed");
  });

  it("ends with a newline, for a document somebody pipes into a file", () => {
    expect(artifactMarkdown(contents())).toMatch(/\n$/);
  });
});

describe("artifactMarkdownResponse", () => {
  it("answers markdown, uncached and unindexed", async () => {
    const response = artifactMarkdownResponse(contents({ status: "filed" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toContain("Status: filed");
  });

  it("names both reasons a token holds nothing", async () => {
    // A reader cannot tell them apart and they lead opposite places, so the
    // one branch where a browser would have been told something says it too.
    const response = artifactMarkdownResponse(null);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    const said = await response.text();
    expect(said).toContain("the link is wrong");
    expect(said).toContain("retention");
  });
});
