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
  owner: "custom:1:someone",
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
  it("opens with the kind in front matter, and no status key for a status it has not got", () => {
    expect(artifactMarkdown(contents())).toMatch(
      /^---\nartifact: "discovery-report"\n---\n/
    );
    expect(artifactMarkdown(contents())).not.toContain("status:");
  });

  it("names the status an artifact finished in", () => {
    expect(artifactMarkdown(contents({ status: "filed" }))).toContain(
      'status: "filed"'
    );
  });

  it("says nothing about the owner, which is a writer's business and not a reader's", () => {
    // A reader holds the link and nothing else, and the owner is the caller key
    // of whoever opened the page. The document is what anybody holding the link
    // gets, so the one field that is about authorization stays out of it.
    const markdown = artifactMarkdown(
      contents({ owner: "custom:7:analytics" })
    );

    expect(markdown).not.toContain("custom:7:analytics");
    expect(markdown).not.toContain("owner");
  });

  it("quotes and escapes both fields, since each is a writer's string", () => {
    // `artifact: a: b` is not YAML, and nothing validates a kind or a status,
    // so the quoting is what keeps the block parseable rather than a style.
    const markdown = artifactMarkdown(
      contents({ kind: 'a "kind": \\x', status: "filed: 3\nof 4\u0007" })
    );

    expect(markdown).toContain('artifact: "a \\"kind\\": \\\\x"');
    // A break cannot stay a break inside a scalar, and a control character is
    // outside YAML's printable set, so each goes in as an escape.
    expect(markdown).toContain('status: "filed: 3\\nof 4\\x07"');
  });

  it("says when nothing has been recorded", () => {
    // A real state, and front matter with nothing under it reads as the
    // reader's own mistake.
    expect(artifactMarkdown(contents())).toContain(
      "Nothing has been recorded on this artifact."
    );
  });

  it("writes each note under a frame line naming who wrote it and when, with its text as recorded", () => {
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

    expect(markdown).toContain("**report** · 2026-10-22T09:30:00.000Z");
    expect(markdown).toContain("# The run\n\nIt ran.");
    expect(markdown).toContain("**coder 1** · 2026-10-22T09:30:00.000Z");
    expect(markdown).not.toContain(
      "Nothing has been recorded on this artifact."
    );
  });

  it("writes no heading of its own, so every heading in the document is a note's", () => {
    // The property the whole shape exists for: a reader needs no rule about
    // levels, because the document's own words are front matter, a rule and a
    // bold line. A note that writes `#` is therefore safe to write it.
    const markdown = artifactMarkdown(
      contents({
        status: "filed",
        entries: [
          {
            sequence: 1,
            label: "report",
            text: "# Run of 2026-10-22\n\n## What was attempted\n\nThree candidates, one filed.",
            at: AT
          },
          {
            sequence: 2,
            label: "coder 1",
            text: "ran the suite",
            at: AT,
            detail: { title: "Bash", status: "running" }
          }
        ]
      })
    );

    expect(
      markdown.split("\n").filter((line) => /^#{1,6} /.test(line))
    ).toEqual(["# Run of 2026-10-22", "## What was attempted"]);
  });

  it("takes a card's title and status, and leaves its sections out", () => {
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

    expect(markdown).toContain(
      "**coder 1** · Bash · ok · 2026-10-22T09:30:00.000Z"
    );
    // A card is an affordance of the page, and a section body is behind it.
    // What the omission costs a transcript is in `./text.ts`.
    expect(markdown).not.toContain("317 passed");
  });

  it("takes a card with no title under its label and status", () => {
    // A result half need not carry a title: core's sub-agent repeats the tool's
    // name on both halves, and plugins' `claude-code` completes a card with
    // `{ ref, status, sections }` alone.
    const markdown = artifactMarkdown(
      contents({
        entries: [
          {
            sequence: 1,
            label: "coder 1",
            text: "317 passed",
            at: AT,
            detail: { ref: "t1", status: "ok" }
          }
        ]
      })
    );

    expect(markdown).toContain("**coder 1** · ok · 2026-10-22T09:30:00.000Z");
    expect(markdown).not.toContain("· ·");
  });

  it("writes the whole document in one order, and ends with a newline", () => {
    // One assertion for what `toContain` cannot see: that the front matter
    // precedes the notes and carries its fields in one order, that a frame line
    // reads label, title, status and then the time, that the rule separating
    // two notes is there and the one before the first note is the front
    // matter's own closing delimiter, that the notes are in the order recorded,
    // and that a document somebody pipes into a file ends the way a file does.
    expect(
      artifactMarkdown(
        contents({
          status: "filed",
          entries: [
            { sequence: 1, label: "report", text: "It ran.", at: AT },
            {
              sequence: 2,
              label: "coder 1",
              text: "It passed.",
              at: AT,
              detail: { ref: "t1", title: "Bash", status: "ok" }
            }
          ]
        })
      )
    ).toBe(
      [
        '---\nartifact: "discovery-report"\nstatus: "filed"\n---',
        "**report** · 2026-10-22T09:30:00.000Z",
        "It ran.",
        "---",
        "**coder 1** · Bash · ok · 2026-10-22T09:30:00.000Z",
        "It passed."
      ].join("\n\n") + "\n"
    );
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
    expect(await response.text()).toContain('status: "filed"');
  });

  it("names both reasons a token holds nothing", async () => {
    // A reader cannot tell them apart and they lead opposite places, so the
    // one branch where a browser would have been told something says it too.
    const response = artifactMarkdownResponse(null);

    expect(response.status).toBe(404);
    // Plain, since a sentence is not a document, and otherwise what the
    // artifact itself answers with.
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const said = await response.text();
    expect(said).toContain("the link is wrong");
    expect(said).toContain("retention");
  });
});
