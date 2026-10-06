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
 * ## Why nothing it renders is markup
 *
 * Entries are built as nodes and filled with `textContent`, never `innerHTML`.
 * The markdown a note is written in becomes elements the script creates, and a
 * link is made only for an `http(s)` URL — so a note that contains HTML shows
 * the HTML, and a note cannot carry a script into a page that holds a bearer
 * token in its address.
 *
 * ## Why it is kind-generic
 *
 * The artifact's kind arrives on the stream and is rendered as data — a heading
 * and a class. A kind that wants to look different says so in what it records,
 * not by being served a different page, because the moment there are two pages
 * there are two of everything else as well. A card is that: an entry's
 * {@link file://./detail.ts detail} says how it opens, and nothing here knows
 * which tool or which writer it came from.
 */

import { ARTIFACT_EVENTS } from "./events.js";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --fg: #1c1b1a; --muted: #6b6864;
  --line: #e4e2de; --card: #ffffff; --accent: #3a6ea5;
  --ok: #2f7d4f; --bad: #b4442e;
  --code-bg: #f3f2ef; --add-bg: #e6f2ea; --del-bg: #f8e8e4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a; --fg: #e8e6e3; --muted: #9a9691;
    --line: #2c2e31; --card: #1e2022; --accent: #7aa7d8;
    /* The settle colours are per-scheme because the light values reach only
       3.5:1 and 3.2:1 on this background, and the pill that wears them is
       .72rem text, which WCAG holds to 4.5:1. These are 6.5:1 and 6.4:1 — in
       step with --accent at 7.1:1 rather than brighter than the page. */
    --ok: #4caf70; --bad: #ef7a5f;
    --code-bg: #141517; --add-bg: #17291e; --del-bg: #2f1a15;
  }
}
* { box-sizing: border-box; }
/* A rule below that sets display would otherwise unhide what is hidden. */
[hidden] { display: none !important; }
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
.status[data-state="completed"], .status[data-state="approved"] {
  color: var(--ok); border-color: var(--ok);
}
.status[data-state="failed"], .status[data-state="rejected"] {
  color: var(--bad); border-color: var(--bad);
}
.toggle {
  margin-left: auto; font: inherit; font-size: .75rem; color: var(--muted);
  background: none; border: 1px solid var(--line); border-radius: 6px;
  padding: .15rem .55rem; cursor: pointer;
}
.toggle:hover { color: var(--fg); }
.note { color: var(--muted); font-size: .9rem; }
.run-label {
  font: 600 .75rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--muted); margin: 1.4rem 0 .5rem; letter-spacing: .02em;
}
.run:first-child .run-label { margin-top: 0; }
.entry { margin-bottom: .4rem; }
.time { font-size: .72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.prose {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: .7rem 1rem;
}
.prose > .time { float: right; margin: 0 0 .25rem .75rem; }
pre {
  margin: 0; font: .8rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--code-bg); border-radius: 6px; padding: .55rem .75rem;
  overflow-x: auto;
}
pre.plain { white-space: pre-wrap; overflow-wrap: anywhere; }
.diff > span { display: block; }
.diff .add { color: var(--ok); background: var(--add-bg); }
.diff .del { color: var(--bad); background: var(--del-bg); }
.diff .hunk { color: var(--muted); }
.md { overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: .45rem 0; white-space: pre-wrap; }
.md code {
  font: .85em ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--code-bg); padding: .1em .3em; border-radius: 4px;
}
.md pre code { background: none; padding: 0; font-size: inherit; }
.md pre { margin: .45rem 0; }
.md ul, .md ol { margin: .45rem 0; padding-left: 1.4rem; }
.md-h { font-size: .95rem; margin: .9rem 0 .3rem; }
.md blockquote {
  margin: .45rem 0; padding-left: .8rem; border-left: 3px solid var(--line);
  color: var(--muted);
}
.md a { color: var(--accent); }
.md-table { overflow-x: auto; margin: .45rem 0; }
.md-table table { border-collapse: collapse; font-size: .85rem; }
.md-table th, .md-table td {
  border: 1px solid var(--line); padding: .25rem .55rem; text-align: left;
}
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.card[data-status="error"] { border-color: var(--bad); }
.card-head {
  display: flex; align-items: center; gap: .55rem; min-width: 0;
  padding: .4rem .7rem; font-size: .85rem;
}
summary.card-head { cursor: pointer; list-style: none; }
summary.card-head::-webkit-details-marker { display: none; }
.chev {
  flex: none; width: .7rem; color: var(--muted); font-size: .7rem;
  transition: transform .15s;
}
details[open] > summary .chev { transform: rotate(90deg); }
.bare .chev { visibility: hidden; }
.bare > summary { cursor: default; }
.glyph {
  flex: none; width: .9rem; height: .9rem; display: inline-grid;
  place-items: center; font-size: .8rem; line-height: 1;
}
.glyph::before { content: "•"; color: var(--muted); }
[data-status="running"] .glyph {
  border: 2px solid var(--line); border-top-color: var(--accent);
  border-radius: 50%; animation: spin .8s linear infinite;
}
[data-status="running"] .glyph::before { content: none; }
[data-status="ok"] .glyph::before { content: "✓"; color: var(--ok); }
[data-status="error"] .glyph::before { content: "✗"; color: var(--bad); }
[data-status="stopped"] .glyph::before { content: "■"; font-size: .55rem; }
.title {
  flex: none; font: 600 .8rem ui-monospace, SFMono-Regular, Menlo, monospace;
}
.title:empty { display: none; }
.sr {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}
.summary-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--muted);
  font: .8rem ui-monospace, SFMono-Regular, Menlo, monospace;
}
.elapsed { flex: none; font-size: .72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.card-head .time { flex: none; }
.card-body { padding: 0 .7rem .7rem; display: grid; gap: .55rem; min-width: 0; }
.section { min-width: 0; }
.section-label {
  font-size: .68rem; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin-bottom: .2rem;
}
.checklist { list-style: none; margin: 0; padding: 0; font-size: .85rem; }
.checklist li { display: flex; gap: .5rem; padding: .1rem 0; }
.checklist [data-state="done"] { color: var(--muted); text-decoration: line-through; }
.checklist [data-state="active"] { font-weight: 600; }
.check { flex: none; width: 1rem; text-align: center; text-decoration: none; }
#todos {
  position: sticky; top: 0; z-index: 1; background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; padding: .4rem .7rem;
  margin-bottom: 1rem;
}
#todos > summary { cursor: pointer; font-size: .8rem; font-weight: 600; }
#todos .checklist { max-height: 40vh; overflow-y: auto; margin-top: .3rem; }
.pulse {
  display: flex; align-items: center; gap: .5rem;
  font-size: .78rem; color: var(--muted); margin-top: .75rem;
}
.pulse::before {
  content: ""; width: .45rem; height: .45rem; border-radius: 50%;
  background: var(--accent); animation: breathe 1.6s ease-in-out infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) {
  [data-status="running"] .glyph, .pulse::before { animation: none; }
}
@media (max-width: 32rem) {
  .card-head .time { display: none; }
}
`;

const SCRIPT = `
(function () {
  var statusEl = document.getElementById("status");
  var kindEl = document.getElementById("kind");
  var logEl = document.getElementById("log");
  var noteEl = document.getElementById("note");
  var pulseEl = document.getElementById("pulse");
  var todosEl = document.getElementById("todos");
  var todosList = document.getElementById("todos-list");
  var todosCount = document.getElementById("todos-count");
  var toggleEl = document.getElementById("toggle");
  var ready = false;
  // The stream is open on an artifact that has not settled.
  var live = false;
  // This page's clock minus the object's — see ReadyEvent.now.
  var skew = 0;
  var lastAt = 0;
  // Every card by its ref, for folding; the ones still running, by identity,
  // since a card need not have a ref.
  var cards = Object.create(null);
  var running = new Set();
  // A card's state in words, for a reader who cannot see the glyph.
  var SPOKEN = { running: "running", ok: "done", error: "failed", stopped: "stopped" };
  // The run the last entry belonged to: its label, and the element it fills.
  var group = null;

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function serverNow() {
    return Date.now() - skew;
  }

  function duration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  function clock(at) {
    var time = el("time", "time", new Date(at).toLocaleTimeString());
    time.dateTime = new Date(at).toISOString();
    return time;
  }

  // --- markdown, as nodes ---------------------------------------------------

  var FENCE = /^\\s*\\x60\\x60\\x60/;
  var INLINE = /(\\x60[^\\x60\\n]+\\x60)|\\*\\*([^*\\n]+)\\*\\*|\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)|\\*([^*\\s][^*\\n]*)\\*/g;
  var ROW = /^\\s*\\|.*\\|\\s*$/;

  function inline(parent, text) {
    var re = new RegExp(INLINE.source, "g");
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) parent.append(el("code", "", m[1].slice(1, -1)));
      else if (m[2]) {
        var strong = el("strong");
        inline(strong, m[2]);
        parent.append(strong);
      } else if (m[3]) {
        // m[4] matched http(s) only: no other scheme can reach an href.
        var link = el("a", "", m[3]);
        link.href = m[4];
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        parent.append(link);
      } else if (m[5]) {
        var em = el("em");
        inline(em, m[5]);
        parent.append(em);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function table(rows) {
    var wrap = el("div", "md-table");
    var body = el("tbody");
    rows.forEach(function (row, n) {
      var cells = row.trim().replace(/^\\||\\|$/g, "").split("|");
      var rule = cells.every(function (cell) {
        return /^\\s*:?-{2,}:?\\s*$/.test(cell);
      });
      if (rule) return;
      var tr = el("tr");
      cells.forEach(function (cell) {
        var td = el(n === 0 ? "th" : "td");
        inline(td, cell.trim());
        tr.append(td);
      });
      body.append(tr);
    });
    var t = el("table");
    t.append(body);
    wrap.append(t);
    return wrap;
  }

  function markdown(text) {
    var root = el("div", "md");
    var lines = text.split("\\n");
    var para = null;
    var list = null;
    var ordered = false;
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (FENCE.test(line)) {
        para = list = null;
        var code = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
        i++;
        var pre = el("pre");
        pre.append(el("code", "", code.join("\\n")));
        root.append(pre);
        continue;
      }
      if (ROW.test(line)) {
        para = list = null;
        var rows = [];
        while (i < lines.length && ROW.test(lines[i])) rows.push(lines[i++]);
        root.append(table(rows));
        continue;
      }
      var heading = /^(#{1,6})\\s+(.*)$/.exec(line);
      if (heading) {
        para = list = null;
        var h = el("h" + Math.min(6, heading[1].length + 2), "md-h");
        inline(h, heading[2]);
        root.append(h);
        i++;
        continue;
      }
      var item = /^\\s*([-*+]|\\d+[.)])\\s+(.*)$/.exec(line);
      if (item) {
        para = null;
        var numbered = /\\d/.test(item[1]);
        if (!list || ordered !== numbered) {
          ordered = numbered;
          list = el(numbered ? "ol" : "ul");
          if (numbered) list.start = parseInt(item[1], 10) || 1;
          root.append(list);
        }
        var li = el("li");
        inline(li, item[2]);
        list.append(li);
        i++;
        continue;
      }
      if (/^\\s*$/.test(line)) {
        para = list = null;
        i++;
        continue;
      }
      var quote = /^>\\s?(.*)$/.exec(line);
      if (quote) {
        para = list = null;
        var block = el("blockquote");
        inline(block, quote[1]);
        root.append(block);
        i++;
        continue;
      }
      list = null;
      if (para) para.append("\\n");
      else {
        para = el("p");
        root.append(para);
      }
      inline(para, line);
      i++;
    }
    return root;
  }

  // --- cards ------------------------------------------------------------------

  function section(part) {
    var wrap = el("div", "section");
    if (part.label) wrap.append(el("div", "section-label", part.label));
    if (part.format === "markdown") wrap.append(markdown(part.body));
    else if (part.format === "diff") {
      var pre = el("pre", "diff");
      part.body.split("\\n").forEach(function (line) {
        var first = line.charAt(0);
        var kind =
          line.indexOf("@@") === 0 ? "hunk"
          : first === "+" ? "add"
          : first === "-" ? "del"
          : "";
        pre.append(el("span", kind, line || " "));
      });
      wrap.append(pre);
    } else wrap.append(el("pre", part.format === "code" ? "" : "plain", part.body));
    return wrap;
  }

  function checklist(items) {
    var ul = el("ul", "checklist");
    items.forEach(function (item) {
      var li = el("li");
      li.dataset.state = item.state;
      var mark = item.state === "done" ? "✓" : item.state === "active" ? "◐" : "○";
      li.append(el("span", "check", mark), el("span", "", item.text));
      ul.append(li);
    });
    return ul;
  }

  function pin(items) {
    todosList.replaceChildren(checklist(items));
    var done = items.filter(function (item) {
      return item.state === "done";
    }).length;
    todosCount.textContent = done + "/" + items.length;
    todosEl.hidden = items.length === 0;
  }

  function tick(card) {
    if (card.status === "running") {
      card.elapsed.textContent = live ? duration(serverNow() - card.startAt) : "";
    } else if (card.endAt !== null && card.endAt - card.startAt >= 1000) {
      card.elapsed.textContent = duration(card.endAt - card.startAt);
    }
  }

  function setCardStatus(card, status, at) {
    card.status = status;
    card.root.dataset.status = status;
    card.spoken.textContent = SPOKEN[status] || "";
    if (status === "running") running.add(card);
    else {
      running.delete(card);
      card.endAt = at;
    }
  }

  function fill(card, detail, before) {
    var first = before ? card.body.firstChild : null;
    (detail.sections || []).forEach(function (part) {
      card.body.insertBefore(section(part), first);
    });
    if (detail.checklist) {
      card.body.append(checklist(detail.checklist));
      pin(detail.checklist);
    }
    card.root.classList.toggle("bare", !card.body.firstChild);
    if (card.body.firstChild) toggleEl.hidden = false;
  }

  function renderCard(entry, detail) {
    var root = el("details", "entry card");
    var head = el("summary", "card-head");
    var card = {
      ref: detail.ref || "",
      root: root,
      body: el("div", "card-body"),
      elapsed: el("span", "elapsed"),
      spoken: el("span", "sr"),
      title: el("span", "title", detail.title || ""),
      text: el("span", "summary-text", entry.text),
      status: "",
      startAt: entry.at,
      endAt: null
    };
    var glyph = el("span", "glyph");
    glyph.setAttribute("aria-hidden", "true");
    card.text.title = entry.text;
    head.append(el("span", "chev", "▸"), glyph, card.spoken, card.title);
    head.append(card.text, card.elapsed, clock(entry.at));
    root.append(head, card.body);
    if (card.ref) cards[card.ref] = card;
    if (detail.status) setCardStatus(card, detail.status, entry.at);
    fill(card, detail);
    tick(card);
    return root;
  }

  function merge(card, entry) {
    var detail = entry.detail;
    // A call's half after its result — a write that failed live and landed on
    // the replay. An ended card stays ended, and takes the call's head and its
    // input, above the output it already shows.
    var late =
      detail.status === "running" && card.status !== "" && card.status !== "running";
    if (late) {
      if (detail.title) card.title.textContent = detail.title;
      card.text.textContent = card.text.title = entry.text;
    } else if (detail.status) setCardStatus(card, detail.status, entry.at);
    fill(card, detail, late);
    tick(card);
  }

  function renderProse(entry) {
    var article = el("article", "entry prose");
    article.append(clock(entry.at), markdown(entry.text));
    return article;
  }

  function container(label) {
    if (!group || group.label !== label) {
      var run = el("section", "run");
      run.append(el("h2", "run-label", label));
      logEl.append(run);
      group = { label: label, el: run };
    }
    return group.el;
  }

  function render(entry) {
    noteEl.hidden = true;
    if (entry.at > lastAt) lastAt = entry.at;
    var detail = entry.detail;
    var existing = detail && detail.ref ? cards[detail.ref] : undefined;
    if (existing) return merge(existing, entry);
    container(entry.label).append(
      detail ? renderCard(entry, detail) : renderProse(entry)
    );
  }

  function nearBottom() {
    var page = document.documentElement;
    return window.innerHeight + window.scrollY >= page.scrollHeight - 80;
  }

  toggleEl.addEventListener("click", function () {
    var open = toggleEl.dataset.open !== "true";
    logEl.querySelectorAll("details.card:not(.bare)").forEach(function (card) {
      card.open = open;
    });
    toggleEl.dataset.open = String(open);
    toggleEl.textContent = open ? "Collapse all" : "Expand all";
  });

  setInterval(function () {
    if (!live) return;
    running.forEach(tick);
    if (lastAt) {
      pulseEl.hidden = false;
      pulseEl.textContent =
        "Working · last update " + duration(serverNow() - lastAt) + " ago";
    }
  }, 1000);

  var eventsUrl = location.pathname.replace(/\\/$/, "") + "/events";
  var stream = new EventSource(eventsUrl);

  stream.addEventListener("${ARTIFACT_EVENTS.ready}", function (event) {
    var data = JSON.parse(event.data);
    ready = true;
    if (typeof data.now === "number") skew = Date.now() - data.now;
    live = !data.status;
    kindEl.textContent = data.kind.replace(/-/g, " ");
    document.title = kindEl.textContent;
    if (!data.status) setStatus("live", "live");
  });

  stream.addEventListener("${ARTIFACT_EVENTS.entry}", function (event) {
    // Follow the tail only for a reader already at it, and only while the run
    // is live: a settled transcript opens at its start.
    var follow = live && nearBottom();
    render(JSON.parse(event.data));
    if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
  });

  stream.addEventListener("${ARTIFACT_EVENTS.settled}", function (event) {
    var data = JSON.parse(event.data);
    live = false;
    pulseEl.hidden = true;
    // A card still running when its artifact settled never got its result.
    running.forEach(function (card) {
      setCardStatus(card, "stopped", null);
      card.elapsed.textContent = "";
    });
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
  <button class="toggle" id="toggle" type="button" hidden>Expand all</button>
</header>
<details id="todos" open hidden>
  <summary>Todos <span id="todos-count"></span></summary>
  <div id="todos-list"></div>
</details>
<div id="log" role="log" aria-live="polite" aria-relevant="additions"></div>
<p class="note" id="note">Nothing recorded yet.</p>
<p class="pulse" id="pulse" hidden></p>
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
