import { describe, it, expect } from "vitest";
import { renderNoteMarkdown } from "./markdown.js";

/**
 * What a note is allowed to become on the page.
 *
 * Two halves, and the second is the reason the first is arranged as it is. The
 * subset is asserted because a subagent's final report is the thing being read —
 * headings, backticked paths, bullets, a fenced diff — and it arrived as raw
 * markdown soup until this existed. The escaping is asserted because a note is
 * untrusted input rendered into a page: every case below is text a subagent could
 * write, deliberately or by quoting something it read, and none of it may reach
 * the DOM as markup.
 *
 * It runs as a string function, which is what makes any of this testable at all:
 * workerd has no DOM, so the renderer is a pure `string -> string` and the page
 * takes it by source — see {@link file://./viewer.ts ARTIFACT_VIEWER_HTML}.
 */
describe("renderNoteMarkdown", () => {
  describe("the subset a report is written in", () => {
    it("wraps prose in a paragraph and keeps the author's line breaks", () => {
      // The note's own wrapping is information: a path per line is a list, and
      // the same lines run together are a wall.
      expect(renderNoteMarkdown("one\ntwo")).toBe("<p>one<br>two</p>");
    });

    it("starts a new paragraph at a blank line", () => {
      expect(renderNoteMarkdown("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
    });

    it("scales a heading down to sit under the page's own", () => {
      // `#` is an h2 and `####` an h5, so a note's headings nest below the h1 the
      // page is titled with rather than beside it.
      expect(renderNoteMarkdown("# Pre-flight")).toBe("<h2>Pre-flight</h2>");
      expect(renderNoteMarkdown("## Pre-flight")).toBe("<h3>Pre-flight</h3>");
      expect(renderNoteMarkdown("### Files")).toBe("<h4>Files</h4>");
      expect(renderNoteMarkdown("#### Files")).toBe("<h5>Files</h5>");
    });

    it("leaves a hash that is not a heading alone", () => {
      expect(renderNoteMarkdown("#hashtag")).toBe("<p>#hashtag</p>");
    });

    it("renders a bulleted list, by either marker", () => {
      expect(renderNoteMarkdown("- one\n* two")).toBe(
        "<ul><li>one</li><li>two</li></ul>"
      );
    });

    it("renders a numbered list, from the number it starts at", () => {
      expect(renderNoteMarkdown("1. one\n2. two")).toBe(
        "<ol><li>one</li><li>two</li></ol>"
      );
      // A report's steps are often a continuation of the steps above them.
      expect(renderNoteMarkdown("3. three")).toBe(
        '<ol start="3"><li>three</li></ol>'
      );
    });

    it("ends a paragraph where a list begins", () => {
      expect(renderNoteMarkdown("Checks:\n- one")).toBe(
        "<p>Checks:</p><ul><li>one</li></ul>"
      );
    });

    it("keeps a fenced block's lines, and its markdown as characters", () => {
      const html = renderNoteMarkdown(
        "```sh\ngit status\n# not a heading\n```"
      );
      expect(html).toBe("<pre><code>git status\n# not a heading</code></pre>");
    });

    it("runs an unclosed fence to the end of the note", () => {
      expect(renderNoteMarkdown("```\nstill code")).toBe(
        "<pre><code>still code</code></pre>"
      );
    });

    it("renders inline code, and nothing inside it", () => {
      expect(renderNoteMarkdown("run `npm run **check**`")).toBe(
        "<p>run <code>npm run **check**</code></p>"
      );
    });

    it("renders bold and italic", () => {
      expect(renderNoteMarkdown("**all** *green*")).toBe(
        "<p><strong>all</strong> <em>green</em></p>"
      );
    });

    it("leaves snake_case alone", () => {
      // Which is why italic is `*this*` only: a report is full of identifiers,
      // and `_` as a marker would slant every one of them.
      expect(renderNoteMarkdown("clock_override and task_id")).toBe(
        "<p>clock_override and task_id</p>"
      );
    });

    it("renders a blockquote, and the blocks inside it", () => {
      expect(renderNoteMarkdown("> quoted\n> - item")).toBe(
        "<blockquote><p>quoted</p><ul><li>item</li></ul></blockquote>"
      );
    });

    it("renders a thematic break", () => {
      expect(renderNoteMarkdown("above\n\n---\n\nbelow")).toBe(
        "<p>above</p><hr><p>below</p>"
      );
    });

    it("renders an empty note as nothing at all", () => {
      expect(renderNoteMarkdown("")).toBe("");
    });
  });

  describe("links", () => {
    it("renders a labelled link, opened away from this page", () => {
      expect(renderNoteMarkdown("[the PR](https://github.test/pr/1)")).toBe(
        '<p><a href="https://github.test/pr/1" target="_blank"' +
          ' rel="noopener noreferrer">the PR</a></p>'
      );
    });

    it("links a bare URL without the sentence around it", () => {
      const html = renderNoteMarkdown(
        "see https://github.test/pr/1, then stop"
      );
      expect(html).toContain('href="https://github.test/pr/1"');
      // The comma is the sentence's, and the text keeps it.
      expect(html).toContain(">https://github.test/pr/1</a>, then stop");
    });

    it("keeps a bracket the URL opened itself", () => {
      const html = renderNoteMarkdown("https://wiki.test/Foo_(bar)");
      expect(html).toContain('href="https://wiki.test/Foo_(bar)"');
    });

    it("nests no anchor inside an anchor", () => {
      const html = renderNoteMarkdown("[https://a.test](https://b.test)");
      expect(html.match(/<a /g)).toHaveLength(1);
    });

    it("leaves a URL inside a code span as code", () => {
      expect(renderNoteMarkdown("`https://a.test`")).toBe(
        "<p><code>https://a.test</code></p>"
      );
    });
  });

  /**
   * The half that is not about looking nice.
   *
   * A note is whatever a subagent wrote, and what it wrote is downstream of
   * whatever it read — a file, a PR body, a page. So the property being asserted
   * is not "these payloads are handled" but that there is no route at all: the
   * text is escaped before a markdown rule ever runs, so nothing below can be
   * markup by the time the page sees it. See
   * {@link file://./markdown.ts renderNoteMarkdown}.
   */
  describe("a note that is trying something", () => {
    it("renders a script tag as the characters it is made of", () => {
      const html = renderNoteMarkdown("Done: <script>alert(1)</script>");
      expect(html).toBe("<p>Done: &lt;script&gt;alert(1)&lt;/script&gt;</p>");
      expect(html).not.toContain("<script");
    });

    it("renders an event handler on a tag as text", () => {
      const html = renderNoteMarkdown('<img src=x onerror="alert(1)">');
      expect(html).not.toContain("<img");
      expect(html).not.toContain('onerror="');
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    });

    it("escapes a tag inside a fenced block too", () => {
      // The one place a reader most expects to see markup spelled out, and the
      // one where forgetting to escape would be least visible.
      const html = renderNoteMarkdown("```\n<script>alert(1)</script>\n```");
      expect(html).toBe(
        "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>"
      );
    });

    it("refuses a link whose scheme could run", () => {
      // An allow-list decides this, not a list of schemes to refuse: a link that
      // is not http(s) or mailto renders as the text it always was.
      const html = renderNoteMarkdown("[click](javascript:alert(1))");
      expect(html).not.toContain("<a ");
      expect(html).toContain("javascript:alert(1)");
    });

    it("cannot break out of an href to add an attribute", () => {
      const html = renderNoteMarkdown(
        '[click](https://a.test/"onclick="alert(1))'
      );
      // The quotes it brought are entities, so they are characters *in* the URL
      // rather than the end of the attribute holding it.
      expect(html).toContain(
        'href="https://a.test/&quot;onclick=&quot;alert(1"'
      );
      expect(html).not.toContain('onclick="');
    });

    it("cannot smuggle a tag through a link's label", () => {
      const html = renderNoteMarkdown("[<b>x</b>](https://a.test)");
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<b>");
    });

    it("emits every ampersand as an entity, once", () => {
      // The double-escape check: `&amp;` in a note is the five characters the
      // author typed, and `&` on its own is one entity and not two.
      expect(renderNoteMarkdown("a & b, &amp; c")).toBe(
        "<p>a &amp; b, &amp;amp; c</p>"
      );
    });
  });
});
