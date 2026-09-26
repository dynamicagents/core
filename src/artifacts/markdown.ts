/**
 * The note renderer the viewer page runs: markdown in, safe HTML out.
 *
 * ## Why the page renders it, and not the object
 *
 * A note is text, and the stream that carries it is kind-generic — the object
 * stores what it is told and streams it verbatim, which is what lets a second
 * kind exist without a branch anywhere inside it (see
 * {@link file://./do.ts Artifacts}). Markdown is what *one* kind's writers
 * happen to produce — a subagent's final report — so the place to read it is the
 * page, on text that has already arrived.
 *
 * ## Why it is one self-contained function
 *
 * The page is a string in the bundle and takes this renderer by interpolating
 * its own source — see {@link file://./viewer.ts ARTIFACT_VIEWER_HTML}. So it
 * may close over **nothing**: no constant beside it, no helper, no import. A
 * reference to anything outside the function is a page that throws on its first
 * note, and a bundler free to rename that binding makes it throw in a consumer's
 * build rather than in this repo's. Everything it needs is declared inside it.
 *
 * The other thing that follows from being embedded in a `<script>` block: nothing
 * in here — no string, no regex, no comment — may contain `</script`, which ends
 * the block wherever it appears and leaves the rest of this function on the page
 * as text. The viewer's spec counts the page's closing tags for exactly that.
 *
 * The other half of that arrangement is that it is a pure string function, which
 * is how it is tested at all: workerd has no DOM, so the rendering is asserted on
 * the HTML it returns — see {@link file://./markdown.spec.ts markdown.spec.ts}.
 *
 * ## Escaping comes first, and that is the security property
 *
 * A note is untrusted. It is whatever a subagent wrote, and what a subagent
 * wrote is downstream of whatever it read. So every `&`, `<`, `>`, `"` and `'`
 * becomes an entity **before** a single markdown rule runs, and every rule below
 * therefore runs on text that can no longer contain a tag. Nothing here puts a
 * piece of the note into markup by any other route, which is what makes the
 * answer to "can a note inject HTML" structural rather than a list of cases
 * somebody has to keep complete: `<script>alert(1)</script>` in a note is words
 * on a page. A link's URL is attribute-safe for the same reason — its quotes are
 * entities by the time it reaches an `href` — with the scheme allow-listed on
 * top, because `javascript:` needs no quote to do harm.
 *
 * ## The subset
 *
 * What a subagent's final report actually contains, and no more: fenced code
 * blocks, `#`–`####` headings, `-`/`*` and `1.` lists, thematic breaks,
 * blockquotes, paragraphs that keep their line breaks, inline code, bold,
 * italic, `[text](url)` links and bare URLs. Not CommonMark: no blocks nested
 * inside a list item, no reference links, no indented code, no tables, and no
 * HTML — that last one on purpose.
 *
 * Italic is `*this*` and never `_this_`, because a report is full of
 * `snake_case` identifiers and every one of them would otherwise come out
 * slanted.
 */

/** One note's markdown as HTML that carries nothing of the note as markup. */
export function renderNoteMarkdown(text: string): string {
  // One home per line shape: `blocks` matches on them and a paragraph ends where
  // any of them begins, so a second spelling of one would drift the two apart.
  const BLANK = /^\s*$/;
  const FENCE = /^\s*```/;
  const FENCE_CLOSE = /^\s*```\s*$/;
  const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  const HEADING = /^ {0,3}(#{1,4})\s+(.*?)\s*#*\s*$/;
  const BULLET = /^\s*[-*]\s+(.*)$/;
  const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
  // `&gt;`, not `>`: escaping runs before any line is read.
  const QUOTE = /^\s*&gt;\s?(.*)$/;

  /** Every character HTML gives a meaning. `&` first, or it double-escapes. */
  function escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Bold before italic, or `**x**` reads as an italic pair around `*x*`. */
  function emphasise(value: string): string {
    return value
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  }

  /**
   * Whether a URL may become an `href`.
   *
   * An allow-list, because the schemes that carry script are not a closed set to
   * deny: `javascript:`, `data:`, `vbscript:`, and each of them again with a
   * newline or a tab inside the word. A URL that is not one of these renders as
   * the text it is, which is the outcome worth having for a note nobody vouched
   * for.
   */
  function linkable(url: string): boolean {
    return /^(?:https?:\/\/|mailto:)\S/i.test(url);
  }

  /**
   * A bare URL without the sentence's last characters.
   *
   * Entities as well as punctuation, because escaping ran first: a URL followed
   * by a quote arrives here with `&quot;` glued to it.
   */
  function trimUrl(url: string): string {
    let trimmed = url;
    for (;;) {
      let shorter = trimmed
        .replace(/&(?:amp|quot|#39|gt|lt);$/, "")
        .replace(/[.,;:!?]+$/, "");
      // A closing bracket belongs to the URL when it opened one — Wikipedia's
      // `(disambiguation)` — and to the prose that wrapped it otherwise.
      if (!shorter.includes("(")) shorter = shorter.replace(/\)+$/, "");
      if (shorter === trimmed) return trimmed;
      trimmed = shorter;
    }
  }

  /** A link, opened away from the page it was found on. */
  function anchor(url: string, label: string): string {
    return (
      '<a href="' +
      url +
      '" target="_blank" rel="noopener noreferrer">' +
      label +
      "</a>"
    );
  }

  /**
   * One line's inline markup: code spans, links, bare URLs, bold and italic.
   *
   * One scan rather than a sequence of replacements, because the three that take
   * an argument have to see the text before the others have touched it — a URL
   * inside a code span is not a link, and `**` inside one is two asterisks.
   * `links` is false inside a link's own label, where an anchor would otherwise
   * end up inside an anchor.
   */
  function inline(value: string, links: boolean): string {
    const tokens = /`([^`\n]+)`|\[([^\]\n]*)\]\(([^\s)]+)\)|(https?:\/\/\S+)/g;
    let html = "";
    let at = 0;
    let match = tokens.exec(value);
    while (match !== null) {
      const whole = match[0];
      // Typed `string[]`, and a group that did not participate is `undefined` at
      // runtime — which is the whole of how the alternatives are told apart.
      const [, code, label, href, bare] = match as (string | undefined)[];
      html += emphasise(value.slice(at, match.index));
      at = tokens.lastIndex;
      if (code !== undefined) {
        html += "<code>" + code + "</code>";
      } else if (href !== undefined && links && linkable(href)) {
        html += anchor(href, inline(label ?? "", false));
      } else if (bare !== undefined && links) {
        const url = trimUrl(bare);
        html += linkable(url)
          ? anchor(url, url) + emphasise(bare.slice(url.length))
          : emphasise(whole);
      } else {
        html += emphasise(whole);
      }
      match = tokens.exec(value);
    }
    return html + emphasise(value.slice(at));
  }

  /** Whether a line ends the paragraph above it by opening a block of its own. */
  function opensBlock(line: string): boolean {
    return (
      BLANK.test(line) ||
      FENCE.test(line) ||
      RULE.test(line) ||
      HEADING.test(line) ||
      BULLET.test(line) ||
      NUMBERED.test(line) ||
      QUOTE.test(line)
    );
  }

  /**
   * One run of list lines as `<li>`s, and where it ended.
   *
   * The item's content is each shape's **last** group, which is what lets the
   * bulleted and the numbered run share this. A nested item is an item: the
   * subset has no list inside a list, so an indented one renders as a sibling
   * rather than as a paragraph in the middle of the list.
   */
  function items(
    lines: string[],
    from: number,
    shape: RegExp
  ): [string, number] {
    let html = "";
    let at = from;
    while (at < lines.length) {
      const item = shape.exec(lines[at]);
      if (item === null) break;
      html += "<li>" + inline(item[item.length - 1], true) + "</li>";
      at += 1;
    }
    return [html, at];
  }

  /** The line-by-line walk. Recurses once, for what a blockquote contains. */
  function blocks(lines: string[]): string {
    let html = "";
    let at = 0;
    while (at < lines.length) {
      const line = lines[at];

      if (BLANK.test(line)) {
        at += 1;
        continue;
      }

      if (FENCE.test(line)) {
        const code: string[] = [];
        at += 1;
        while (at < lines.length && !FENCE_CLOSE.test(lines[at])) {
          code.push(lines[at]);
          at += 1;
        }
        // Past the closing fence, or past the end of a block nobody closed —
        // which runs to the end of the note, as every renderer reads it.
        at += 1;
        html += "<pre><code>" + code.join("\n") + "</code></pre>";
        continue;
      }

      if (RULE.test(line)) {
        html += "<hr>";
        at += 1;
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading !== null) {
        // `#` is an `h2`: a note renders inside a page that already has an `h1`,
        // so the note's own top level is the one below it. How large these are
        // allowed to look is the viewer's business — see its `STYLE`.
        const level = heading[1].length + 1;
        html +=
          "<h" + level + ">" + inline(heading[2], true) + "</h" + level + ">";
        at += 1;
        continue;
      }

      if (BULLET.test(line)) {
        const [list, next] = items(lines, at, BULLET);
        html += "<ul>" + list + "</ul>";
        at = next;
        continue;
      }

      const numbered = NUMBERED.exec(line);
      if (numbered !== null) {
        const [list, next] = items(lines, at, NUMBERED);
        // The number the author started at, because a report's steps are often a
        // continuation of the steps above them. Digits by the regex, so the
        // attribute needs nothing done to it.
        const start = numbered[1] === "1" ? "" : ' start="' + numbered[1] + '"';
        html += "<ol" + start + ">" + list + "</ol>";
        at = next;
        continue;
      }

      if (QUOTE.test(line)) {
        const quoted: string[] = [];
        while (at < lines.length) {
          const more = QUOTE.exec(lines[at]);
          if (more === null) break;
          quoted.push(more[1]);
          at += 1;
        }
        html += "<blockquote>" + blocks(quoted) + "</blockquote>";
        continue;
      }

      const paragraph: string[] = [];
      while (at < lines.length && !opensBlock(lines[at])) {
        paragraph.push(inline(lines[at].trim(), true));
        at += 1;
      }
      // The note's own line breaks are kept: one path per line reads as a list of
      // paths, and the same lines joined into prose read as a wall.
      html += "<p>" + paragraph.join("<br>") + "</p>";
    }
    return html;
  }

  return blocks(escapeHtml(text).replace(/\r\n?/g, "\n").split("\n"));
}
