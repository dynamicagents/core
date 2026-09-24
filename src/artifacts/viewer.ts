/**
 * The page served at `/a/<token>`.
 *
 * ## Why it is a string in the bundle
 *
 * A Worker that serves one page does not need an asset pipeline, and an
 * artifact link is the kind of URL that gets pasted into a thread and opened
 * months later — so the fewer moving parts between the token and the text, the
 * better. Everything it needs is inline: no stylesheet, no script, no font, and
 * no request beyond the stream it opens and the probe that tells a token naming
 * no artifact from a connection that dropped.
 *
 * ## Why the token is not in it
 *
 * The page derives its stream URL from `location.pathname`, so this string is
 * the same bytes for every artifact and nothing caller-supplied is ever
 * interpolated into markup. That is not only a simplification: it is the reason
 * there is no injection surface here to get wrong.
 *
 * What *is* interpolated is this repo's own code — the wire's event names, and
 * the note renderer's source, which the script takes by `toString()` so the
 * rendering can be a tested pure function rather than a string nothing can run.
 * See {@link file://./markdown.ts renderNoteMarkdown} for the constraints that
 * puts on it, and for why a note's own markup can never reach this DOM.
 *
 * ## Why it is kind-generic
 *
 * The artifact's kind arrives on the stream and is rendered as data — a heading
 * and a class. A kind that wants to look different says so in what it records,
 * not by being served a different page, because the moment there are two pages
 * there are two of everything else as well. The title is that rule's first
 * case: a kind carries the name it is printed under
 * ({@link file://./kind.ts ArtifactKind}), and this page has no idea which kind
 * it is showing.
 */

import { ARTIFACT_EVENTS } from "./events.js";
import { renderNoteMarkdown } from "./markdown.js";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1c1b1a; --muted: #6b6864;
  --line: #e4e2de; --card: #ffffff; --accent: #3a6ea5;
  --ok: #2f7d4f; --bad: #b4442e;
  /* Code sits on the card, not on the page, so it is offset from --card. */
  --code: #f3f2ef;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a; --fg: #e8e6e3; --muted: #9a9691;
    --line: #2c2e31; --card: #1e2022; --accent: #7aa7d8;
    --code: #2a2c30;
    /* The settle colours are per-scheme because the light values reach only
       3.5:1 and 3.2:1 on this background, and the pill that wears them is
       .72rem text, which WCAG holds to 4.5:1. These are 6.5:1 and 6.4:1 — in
       step with --accent at 7.1:1 rather than brighter than the page. */
    --ok: #4caf70; --bad: #ef7a5f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 52rem; margin: 0 auto; }
header {
  display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap;
  padding-bottom: .75rem; border-bottom: 1px solid var(--line); margin-bottom: 1.5rem;
}
h1 { font-size: 1.05rem; font-weight: 600; margin: 0; letter-spacing: .01em; }
.status {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .08em;
  padding: .2rem .55rem; border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted);
}
.status[data-state="live"] { color: var(--accent); border-color: var(--accent); }
.status[data-state="completed"] { color: var(--ok); border-color: var(--ok); }
.status[data-state="failed"], .status[data-state="rejected"] {
  color: var(--bad); border-color: var(--bad);
}
.entry {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .85rem 1rem; margin-bottom: .6rem;
}
.meta {
  display: flex; gap: .6rem; align-items: baseline;
  font-size: .75rem; color: var(--muted); margin-bottom: .35rem;
}
.label { font-weight: 600; color: var(--fg); font-family: ui-monospace, monospace; }
/* A note is rendered markdown, so no pre-wrap: the renderer emits the line
   breaks it decided to keep, and pre-wrap would show them twice. Everything
   below styles what it can emit, and nothing else can arrive — see
   renderNoteMarkdown for why a note cannot bring markup of its own. */
.text { overflow-wrap: anywhere; }
.text > :first-child { margin-top: 0; }
.text > :last-child { margin-bottom: 0; }
.text p { margin: 0 0 .6rem; }
/* Capped, all four of them: the page's own h1 is 1.05rem, and a heading inside
   one note of a log must not outrank the name of the page it is on. */
.text h2, .text h3, .text h4, .text h5 {
  font-weight: 600; line-height: 1.35; margin: 1rem 0 .4rem;
}
.text h2 { font-size: 1rem; }
.text h3 { font-size: .95rem; }
.text h4, .text h5 { font-size: .9rem; color: var(--muted); }
.text ul, .text ol { margin: .4rem 0 .6rem; padding-left: 1.5rem; }
.text li { margin: .15rem 0; }
.text a { color: var(--accent); }
.text code {
  font-family: ui-monospace, monospace; font-size: .875em;
  background: var(--code); border: 1px solid var(--line); border-radius: 4px;
  padding: .05rem .25rem;
}
.text pre {
  margin: .5rem 0 .7rem; padding: .7rem .8rem; background: var(--code);
  border: 1px solid var(--line); border-radius: 8px; overflow-x: auto;
}
/* The block is the frame; the code inside it wears none of its own. */
.text pre code {
  background: none; border: 0; padding: 0; font-size: .85em; line-height: 1.5;
}
.text blockquote {
  margin: .5rem 0; padding: .1rem 0 .1rem .8rem; color: var(--muted);
  border-left: 3px solid var(--line);
}
.text hr { border: 0; border-top: 1px solid var(--line); margin: .9rem 0; }
.note { color: var(--muted); font-size: .9rem; }
`;

const SCRIPT = `
(function () {
  // The note renderer, by its own source — see the module note above. Bound to a
  // name of this page's choosing rather than called by the one it was declared
  // with, because a bundler may rename that and nothing here would notice.
  var renderMarkdown = ${renderNoteMarkdown.toString()};

  var statusEl = document.getElementById("status");
  var kindEl = document.getElementById("kind");
  var logEl = document.getElementById("log");
  var noteEl = document.getElementById("note");
  var ready = false;

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

  // The one path every entry takes. A reconnect's replay arrives as the same
  // "entry" frames the live stream sends — see Artifacts.openStream — so there is
  // nothing to keep in step here, and nothing else may ever append to the log.
  function render(entry) {
    noteEl.hidden = true;
    var wrap = document.createElement("article");
    wrap.className = "entry";
    var meta = document.createElement("div");
    meta.className = "meta";
    var label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.label;
    var time = document.createElement("time");
    time.dateTime = new Date(entry.at).toISOString();
    time.textContent = new Date(entry.at).toLocaleTimeString();
    meta.append(label, time);
    // A div, not a p: a note renders as blocks, and a list or a code block
    // inside a paragraph is markup the browser takes apart again.
    var body = document.createElement("div");
    body.className = "text";
    body.innerHTML = renderMarkdown(entry.text);
    wrap.append(meta, body);
    logEl.append(wrap);
  }

  var eventsUrl = location.pathname.replace(/\\/$/, "") + "/events";
  var stream = new EventSource(eventsUrl);

  stream.addEventListener("${ARTIFACT_EVENTS.ready}", function (event) {
    var data = JSON.parse(event.data);
    ready = true;
    // The name its kind declared, and the id made readable for an artifact that
    // carries none — one opened under a bare id, or before the column existed.
    kindEl.textContent = data.displayName || data.kind.replace(/-/g, " ");
    // One value in both places: a tab and a heading that disagree read as two
    // different pages.
    document.title = kindEl.textContent;
    if (!data.status) setStatus("live", "live");
  });

  stream.addEventListener("${ARTIFACT_EVENTS.entry}", function (event) {
    render(JSON.parse(event.data));
  });

  stream.addEventListener("${ARTIFACT_EVENTS.settled}", function (event) {
    var data = JSON.parse(event.data);
    setStatus(data.status, data.status);
    if (logEl.children.length === 0) noteEl.textContent = "Nothing was recorded.";
    stream.close();
  });

  function gone() {
    setStatus("gone", "not found");
    noteEl.textContent =
      "This link names no artifact. It may have expired, or been mistyped.";
    stream.close();
  }

  // An EventSource error event carries no status, so a token that names no
  // artifact and a connection that dropped arrive here as the same event. Only
  // the server can tell them apart, and the events route answers 404 for the
  // first — so ask it, and treat every other outcome as transient: a fetch that
  // never landed, any status but 404, an offline laptop. Closing on a transient
  // failure is what costs: it throws away the native reconnect and the
  // Last-Event-ID replay behind it, which is most of what makes a live link
  // survive a closed lid, and it does so under the words "not found".
  var probing = false;

  function probeGone() {
    if (probing) return;
    probing = true;
    fetch(eventsUrl, { cache: "no-store" }).then(
      function (response) {
        probing = false;
        // A probe that found the stream must not hold a seat in the object.
        if (response.body) response.body.cancel();
        if (response.status === 404) gone();
      },
      function () {
        probing = false;
      }
    );
  }

  stream.onerror = function () {
    // Past "ready" the artifact is known to exist, so there is nothing to ask.
    if (ready) return setStatus("live", "reconnecting");
    setStatus("pending", "reconnecting");
    // Offline is transient by definition: nothing answered because nothing was
    // asked, so the probe would only report the network back to itself.
    if (navigator.onLine === false) return;
    probeGone();
  };
})();
`;

/**
 * The viewer, as one immutable document.
 *
 * Served without consulting the Durable Object at all: the page is identical
 * for every token and the stream behind it is what knows whether the artifact
 * exists, so a 404 is a thing the page *shows* rather than a thing the edge has
 * to go and ask about first.
 */
export const ARTIFACT_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Artifact</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1 id="kind">Artifact</h1>
  <span class="status" id="status" role="status" data-state="pending">connecting</span>
</header>
<div id="log" role="log" aria-live="polite" aria-relevant="additions"></div>
<p class="note" id="note">Nothing recorded yet.</p>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** The viewer page as a response. */
export function artifactViewerResponse(): Response {
  return new Response(ARTIFACT_VIEWER_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A viewer opened while its artifact is still running must not be served
      // from a cache that saw it settle, or the other way round.
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}
