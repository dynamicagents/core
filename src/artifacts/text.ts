/**
 * An artifact as markdown, for a reader that is not a browser.
 *
 * ## Why a second representation exists
 *
 * The page at `/a/<token>` is a script that fills itself from the stream behind
 * it — see {@link file://./viewer.ts ARTIFACT_VIEWER_HTML} — and it is served
 * without the store being read at all. So a client that does not run scripts
 * gets markup carrying none of the artifact: `curl`, a shell inside a container,
 * anything piping a link into a file. That is not a gap in the page, it is the
 * cost of the page being one static string, and the fix is not to make the page
 * render server-side but to answer the same URL with the text when the client
 * did not ask for HTML.
 *
 * **One link, two readers.** A person opens it and reads the page; an agent
 * opens it and reads this. Nothing new is published and no authorization
 * changes: the token was already the whole of what a read needs, and a browser
 * already showed the same notes to whoever held it.
 *
 * ## Kind-generic, like the page
 *
 * Nothing here learns what a kind means, so a plan, a report and a session
 * transcript are the same document with different notes in it. An entry's card
 * ({@link file://./detail.ts ArtifactEntryDetail}) contributes its title and
 * nothing else: a card is an affordance of the page, where it opens and closes,
 * and its sections are already in the note a writer recorded.
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

/** What a read serves when the client did not ask for the page. */
const MARKDOWN_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  // Both for the reason the page sets them: the token is in the address, and
  // what is behind it changes while a run is going and ages out afterwards.
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow"
};

/**
 * One artifact written out: its kind, the status it finished in if it has one,
 * and each note under a heading naming who wrote it and when.
 *
 * Pure, so what the document says is pinned without an object. The heading
 * carries the label and the ISO time because a reader of a transcript has to
 * tell one note's text from the next one's, and a note in a labelled column on
 * the page is an undifferentiated paragraph here without it.
 *
 * An artifact with no notes says so. It is a real state — opened, nothing
 * recorded yet, or everything swept — and a bare heading reads as a reader's
 * own mistake.
 */
export function artifactMarkdown(contents: ArtifactContents): string {
  const parts = [`# ${contents.kind}`];
  if (contents.status !== null) parts.push(`Status: ${contents.status}`);
  if (contents.entries.length === 0) {
    parts.push("Nothing has been recorded on this artifact.");
  }
  for (const entry of contents.entries) {
    const heading = [entry.label, entry.detail?.title]
      .filter(Boolean)
      .concat(new Date(entry.at).toISOString())
      .join(" · ");
    parts.push(`## ${heading}`, entry.text);
  }
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
 * reader has to be told what a browser would have been shown.
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
          ...MARKDOWN_HEADERS,
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
  return new Response(artifactMarkdown(contents), {
    headers: MARKDOWN_HEADERS
  });
}
