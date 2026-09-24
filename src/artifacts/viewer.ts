/**
 * The page served at `/a/<token>`.
 *
 * ## Why it is a string in the bundle
 *
 * A Worker that serves one page does not need an asset pipeline, and an
 * artifact link is the kind of URL that gets pasted into a thread and opened
 * months later — so the fewer moving parts between the token and the text, the
 * better. Everything it needs is inline: no stylesheet, no script, no font, no
 * request beyond the stream it opens.
 *
 * ## Why the token is not in it
 *
 * The page derives its stream URL from `location.pathname`, so this string is
 * the same bytes for every artifact and nothing caller-supplied is ever
 * interpolated into markup. That is not only a simplification: it is the reason
 * there is no injection surface here to get wrong.
 *
 * ## Why it is kind-generic
 *
 * The artifact's kind arrives on the stream and is rendered as data — a heading
 * and a class. A kind that wants to look different says so in what it records,
 * not by being served a different page, because the moment there are two pages
 * there are two of everything else as well.
 */

import { ARTIFACT_EVENTS } from "./events.js";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1c1b1a; --muted: #6b6864;
  --line: #e4e2de; --card: #ffffff; --accent: #3a6ea5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a; --fg: #e8e6e3; --muted: #9a9691;
    --line: #2c2e31; --card: #1e2022; --accent: #7aa7d8;
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
.status[data-state="completed"] { color: #2f7d4f; border-color: #2f7d4f; }
.status[data-state="failed"], .status[data-state="rejected"] {
  color: #b4442e; border-color: #b4442e;
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
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: .9rem; }
`;

const SCRIPT = `
(function () {
  var statusEl = document.getElementById("status");
  var kindEl = document.getElementById("kind");
  var logEl = document.getElementById("log");
  var noteEl = document.getElementById("note");
  var ready = false;

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

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
    var body = document.createElement("p");
    body.className = "text";
    body.textContent = entry.text;
    wrap.append(meta, body);
    logEl.append(wrap);
  }

  var stream = new EventSource(location.pathname.replace(/\\/$/, "") + "/events");

  stream.addEventListener("${ARTIFACT_EVENTS.ready}", function (event) {
    var data = JSON.parse(event.data);
    ready = true;
    kindEl.textContent = data.kind.replace(/-/g, " ");
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

  stream.onerror = function () {
    // Before the first event the only thing an EventSource can tell us apart
    // from a dropped connection is that nothing ever arrived — which is what a
    // token that names no artifact looks like. Retrying that forever is the one
    // failure mode worth stopping by hand; after "ready" the browser's own
    // reconnect, carrying Last-Event-ID, is the right answer.
    if (ready) return setStatus("live", "reconnecting");
    setStatus("gone", "not found");
    noteEl.textContent =
      "This link names no artifact. It may have expired, or been mistyped.";
    stream.close();
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
  <span class="status" id="status" data-state="pending">connecting</span>
</header>
<div id="log"></div>
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
