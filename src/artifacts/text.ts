/**
 * An artifact as markdown, for a reader that is not a browser.
 *
 * ## Why a second representation exists
 *
 * The page at `/a/<token>` is a script that fills itself from the stream behind
 * it ({@link file://./viewer.ts ARTIFACT_VIEWER_HTML}), and it is served
 * without the store being read at all. So a client that does not run scripts
 * gets markup carrying none of the artifact: `curl`, a shell inside a container,
 * anything piping a link into a file. That is not a gap in the page, it is the
 * cost of the page being one static string, and the fix is not to make the page
 * render server-side but to answer the same URL with the text when the client
 * did not ask for HTML.
 *
 * **One link, two readers.** A person opens it and reads the page; an agent
 * opens it and reads this. Nothing new is published and no authorization
 * changes, and that is checkable rather than a claim about intent: the stream
 * at `/a/<token>/events` already replays every note to any client holding the
 * token, script or no script, so this adds a shape for what was reachable and
 * not a reader who could not reach it.
 *
 * ## Kind-generic, like the page
 *
 * Nothing here learns what a kind means, so a plan, a report and a session
 * transcript are the same document with different notes in it.
 *
 * **An entry's card contributes its title and its status, and no section.**
 * Those two are what a card
 * ({@link file://./detail.ts ArtifactEntryDetail}) shows a reader who has not
 * opened it, and they are a line. A section body is behind the disclosure: a
 * card is an affordance of the page, where a reader opens the one they want and
 * leaves the rest shut, and a document has no such thing, so every body would
 * be in front of every reader, each as large as
 * {@link file://./detail.ts ENTRY_SECTION_MAX_CHARS} allows.
 *
 * **What that costs falls on the transcript kind**, and is worth stating rather
 * than discovering. A sub-agent's card keeps a tool's input, output or error in
 * a section and records only a summary of the call as the note, so a transcript
 * read here says which tool ran and how it ended, and not what it answered. A
 * kind whose notes are prose, a plan or a report, loses nothing.
 *
 * ## Every heading in the document was written by a note
 *
 * A note's text goes in byte-identical, its own headings included, so what a
 * reader greps, quotes back or pipes into a file is what a writer wrote. The
 * document's own words therefore stay out of the heading namespace entirely:
 * the kind and the status are front matter, and each note is introduced by a
 * thematic rule and a bold frame line. Those are different markdown constructs
 * from a note's content rather than different levels of one, so the rule a
 * reader holds is a single sentence and there is no arithmetic to get wrong.
 *
 * The page solves the same collision the other way, by demoting a note's own
 * headings by two so none of them reaches its structure (`markdown`, inside
 * {@link file://./viewer.ts ARTIFACT_VIEWER_HTML}). That is not available here:
 * it rewrites a writer's markdown, which is the property this section opens
 * with, and it needs a fence scanner of its own so that a `# ` line inside a
 * fenced block stays put.
 *
 * What the shape costs, and all of it is worth knowing before changing it:
 *
 * - **The document has no title heading**, so an outline tool shows a note's
 *   headings and not the artifact's kind. That is the trade rather than an
 *   oversight: the kind and the status are metadata, and the notes are the
 *   document.
 * - **The invariant holds for a reader that knows front matter.** A parser
 *   without it reads the opening `---` as a thematic break and then the fields
 *   and their closing `---` as a setext heading, which is CommonMark working as
 *   specified. There is nowhere else to put the fields: front matter is front
 *   matter only at the start of a document, and a fixed place to parse them
 *   from is what the reader this was written for needs.
 * - **No frame is unforgeable.** A note may carry a `---` line, or a line
 *   shaped like a frame, and nothing short of fencing each whole note closes
 *   that. Fencing costs every note its formatting, and the reader this serves
 *   is the one such a forgery costs least.
 */

import type { ArtifactContents } from "./do.js";

/** What a client has to ask for to be served the viewer page. */
const HTML = "text/html";

/**
 * Whether this request's `Accept` asks for the page.
 *
 * **HTML is the opt-in, and everything else is the text.** A browser always
 * lists `text/html`; `curl` and a bare `fetch` send the wildcard range, and a
 * request with no `Accept` at all asks for nothing in particular. Reading a
 * wildcard as "the page" would leave every non-browser reader with the markup
 * it cannot use, which is the whole failure this answers.
 *
 * Media ranges only: a range's parameters are ignored, so a client that lists
 * `text/html` and then refuses it with `q=0` still gets the page. Nothing sends
 * that, and honouring it would mean carrying a quality-value parser for a
 * two-representation route.
 */
export function wantsHtml(accept: string | null): boolean {
  if (!accept) return false;
  return accept
    .split(",")
    .some((range) => range.split(";")[0]!.trim().toLowerCase() === HTML);
}

/**
 * What every answer here carries beside its content type, for the reason
 * {@link file://./viewer.ts artifactViewerResponse} sets the same two on the
 * page: the token is in the address, and what is behind it changes while a run
 * is going and ages out afterwards.
 *
 * **No `Vary: Accept` beside them.** A representation chosen by a request
 * header needs one so that a cache keys on it, and `no-store` already says the
 * stronger thing: neither answer may be stored, so none can be served back to
 * the reader that asked for the other.
 */
const UNCACHED_AND_UNINDEXED = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow"
};

/**
 * The characters a YAML double-quoted scalar spells with a named escape. `NEL`,
 * `LINE SEPARATOR` and `PARAGRAPH SEPARATOR` are among them because they are
 * breaks under YAML 1.1 and printable under 1.2, so writing one out raw would
 * make the field's value depend on which version read it.
 */
const YAML_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\u0085": "\\N",
  "\u2028": "\\L",
  "\u2029": "\\P"
};

/**
 * A writer's string as a YAML double-quoted scalar.
 *
 * **Quoted always.** A kind and a status are writers' strings and nothing
 * validates either: `status: filed: 3` is not YAML at all, and `status: filed`
 * and `status: "filed"` parse the same, so there is no value for which leaving
 * the quotes off is worth deciding. What is escaped is what a double-quoted
 * scalar cannot carry raw: the quote and the backslash themselves, every line
 * break, and the control characters YAML excludes from its printable set.
 */
function yamlString(value: string): string {
  let out = '"';
  for (const character of value) {
    if (character in YAML_ESCAPES) {
      out += YAML_ESCAPES[character];
    } else if (character < " " || character === "\u007f") {
      // Every other non-printable, by code point. YAML's `\x` takes exactly two
      // hex digits, which is all a C0 control or `DEL` needs.
      out += `\\x${character.codePointAt(0)!.toString(16).padStart(2, "0")}`;
    } else {
      out += character;
    }
  }
  return `${out}"`;
}

/**
 * One artifact written out: its kind and the status it finished in as front
 * matter, then each note under a rule and a frame line naming who wrote it and
 * when.
 *
 * Pure, so what the document says is pinned without an object. The frame line
 * carries the label and the ISO time because a reader of a transcript has to
 * tell one note's text from the next one's, and a note in a labelled column on
 * the page is an undifferentiated paragraph here without it. Why it is a bold
 * line under a rule rather than a heading is under "Every heading in the
 * document was written by a note" above.
 *
 * **The front matter's own closing `---` is the first note's rule**, so only the
 * notes after it carry one. A rule separates, and before the first note there
 * is nothing to separate it from.
 *
 * `artifact` and `status` are the document's own keys rather than the field
 * names of {@link file://./do.ts ArtifactContents}: each reads as a statement
 * about the document, which is what a reader meets. Renaming either is a change
 * to what a link answers, for a reader that parses them from a fixed place.
 *
 * A card's status goes in as recorded, the value
 * {@link file://./detail.ts EntryStatus} names, rather than in the page's words
 * for a reader who cannot see its glyph (`SPOKEN`, inside
 * {@link file://./viewer.ts ARTIFACT_VIEWER_HTML}). The artifact's own status is
 * a writer's string written out unchanged, so a translation table for the card's
 * would be a second vocabulary for the same field, in two files, with nothing
 * checking that they agree.
 *
 * **A call and its result are two frame lines here, where the page folds them
 * into one card.** Both halves carry the `ref` the page folds on
 * ({@link file://./detail.ts ArtifactEntryDetail}), and this document is the log
 * in the order it was recorded, so a tool that ran reads as a `running` frame
 * and then the frame its outcome arrived under. Folding would mean holding
 * entries back to see whether a later one completes them, and the status of a
 * call nothing completed is then the news.
 *
 * `locked` is not written out, for the reason the page's ready frame does not
 * carry it either: {@link file://./store.ts ArtifactStore.lock} always sets a
 * status, so the `status` field is already there whenever it would have said
 * anything.
 *
 * An artifact with no notes says so. It is a real state: opened with nothing
 * recorded yet, or everything swept. Front matter and nothing under it reads as
 * a reader's own mistake.
 */
export function artifactMarkdown(contents: ArtifactContents): string {
  const fields = [`artifact: ${yamlString(contents.kind)}`];
  if (contents.status !== null) {
    fields.push(`status: ${yamlString(contents.status)}`);
  }
  const parts = [["---", ...fields, "---"].join("\n")];
  if (contents.entries.length === 0) {
    parts.push("Nothing has been recorded on this artifact.");
  }
  contents.entries.forEach((entry, index) => {
    const frame = [
      `**${entry.label}**`,
      entry.detail?.title,
      entry.detail?.status
    ]
      .filter(Boolean)
      .concat(new Date(entry.at).toISOString())
      .join(" · ");
    if (index > 0) parts.push("---");
    parts.push(frame, entry.text);
  });
  // A trailing newline, because this is a document somebody pipes into a file
  // or reads in a terminal rather than a value a caller parses.
  return `${parts.join("\n\n")}\n`;
}

/**
 * {@link artifactMarkdown} as the response, or the 404 for a token naming
 * nothing.
 *
 * The sentence names both reasons, because a reader cannot tell them apart and
 * they lead opposite places: a wrong link is worth re-reading, and an artifact
 * past its retention is gone and worth nobody's time. The page says the same
 * thing once its stream answers, so this is the one branch where the text
 * reader has to be told what a browser would have been shown. Plain text, since
 * a sentence is not a document.
 */
export function artifactMarkdownResponse(
  contents: ArtifactContents | null
): Response {
  if (contents === null) {
    return new Response(
      "No such artifact. Either the link is wrong, or this artifact has passed " +
        "its retention and been deleted.\n",
      {
        status: 404,
        headers: {
          ...UNCACHED_AND_UNINDEXED,
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
  return new Response(artifactMarkdown(contents), {
    headers: {
      ...UNCACHED_AND_UNINDEXED,
      "content-type": "text/markdown; charset=utf-8"
    }
  });
}
