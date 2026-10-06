import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { ARTIFACT_VIEWER_HTML } from "./viewer.js";

/**
 * The viewer's own script, run against a DOM.
 *
 * The other artifact specs read the stream a page is sent; this one reads what
 * the page makes of it — the folding of a card's halves, its state, the pinned
 * checklist, and the markdown that must never become markup. The script is
 * run with its globals handed in rather than evaluated by the DOM library, so
 * the stream is a fake whose frames a spec writes, and the clock is a timer
 * list a spec ticks.
 */

interface Frame {
  data: string;
}

class FakeEventSource {
  static last: FakeEventSource | undefined;
  readonly listeners = new Map<string, ((frame: Frame) => void)[]>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(name: string, listener: (frame: Frame) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data: JSON.stringify(data) });
  }
}

const SCRIPT =
  ARTIFACT_VIEWER_HTML.split("<script>")[1]!.split("</script>")[0]!;
const BODY = ARTIFACT_VIEWER_HTML.split("<body>")[1]!.split("<script>")[0]!;

/** A page on a fresh DOM, its stream opened and ready on a live artifact. */
function page(status: string | null = null) {
  const window = new Window({ url: "https://agent.test/a/token" });
  const document = window.document;
  document.body.innerHTML = BODY;
  const timers: (() => void)[] = [];
  new Function(
    "document",
    "window",
    "location",
    "EventSource",
    "navigator",
    "fetch",
    "setInterval",
    SCRIPT
  )(
    document,
    window,
    window.location,
    FakeEventSource,
    window.navigator,
    () => Promise.resolve(new Response(null)),
    (fn: () => void) => timers.push(fn)
  );
  const stream = FakeEventSource.last!;
  stream.emit("ready", { kind: "session-transcript", status, now: Date.now() });
  let sequence = 0;
  const entry = (text: string, detail?: unknown, media?: unknown) =>
    stream.emit("entry", {
      sequence: ++sequence,
      label: "child 0",
      text,
      at: Date.now(),
      ...(detail ? { detail } : {}),
      ...(media ? { media } : {})
    });
  return {
    document,
    stream,
    entry,
    tick: () => timers.forEach((fn) => fn()),
    cards: () => [...document.querySelectorAll(".card")]
  };
}

const labels = (card: {
  querySelectorAll(selector: string): Iterable<{ textContent: string | null }>;
}) =>
  [...card.querySelectorAll(".section-label")].map((node) => node.textContent);

describe("the viewer", () => {
  it("renders prose as markdown built from nodes, and markup as text", () => {
    const { document, entry } = page();
    entry(
      [
        "**bold** and `code` and [docs](https://docs.example/x)",
        "[bad](javascript:alert(1)) <img src=x onerror=alert(1)>",
        "",
        "- one",
        "- two",
        "",
        "```",
        "<b>not bold</b>",
        "```"
      ].join("\n")
    );

    const prose = document.querySelector(".prose")!;
    expect(prose.querySelector("strong")?.textContent).toBe("bold");
    expect(prose.querySelector("p code")?.textContent).toBe("code");
    const links = [...prose.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://docs.example/x"
    ]);
    // Neither the javascript: link nor the tag became anything but text.
    expect(prose.querySelector("img")).toBeNull();
    expect(prose.textContent).toContain("[bad](javascript:alert(1))");
    expect(prose.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(prose.querySelectorAll("li")).toHaveLength(2);
    expect(prose.querySelector("pre code")?.textContent).toBe(
      "<b>not bold</b>"
    );
    expect(prose.querySelector("b")).toBeNull();
  });

  it("folds a call and its result into one card, in words as well as a glyph", () => {
    const { entry, cards } = page();
    entry("npm test", {
      ref: "t1",
      status: "running",
      title: "Bash",
      sections: [{ label: "Command", body: "npm test", format: "code" }]
    });
    expect(cards()[0]?.querySelector(".sr")?.textContent).toBe("running");

    entry("1 passed", {
      ref: "t1",
      status: "ok",
      sections: [{ label: "Output", body: "1 passed", format: "code" }]
    });

    expect(cards()).toHaveLength(1);
    const card = cards()[0]!;
    expect(card.getAttribute("data-status")).toBe("ok");
    expect(card.querySelector(".sr")?.textContent).toBe("done");
    expect(card.querySelector(".summary-text")?.textContent).toBe("npm test");
    expect(labels(card)).toEqual(["Command", "Output"]);
  });

  /**
   * A call's note that failed live lands on the finish replay — after its
   * result. Folded in arrival order, it would put the card back to running
   * for good.
   */
  it("keeps a card ended when its call lands after its result", () => {
    const { entry, cards } = page();
    entry("1 passed", {
      ref: "t1",
      status: "ok",
      sections: [{ label: "Output", body: "1 passed" }]
    });
    entry("npm test", {
      ref: "t1",
      status: "running",
      title: "Bash",
      sections: [{ label: "Command", body: "npm test" }]
    });

    const card = cards()[0]!;
    expect(cards()).toHaveLength(1);
    expect(card.getAttribute("data-status")).toBe("ok");
    expect(card.querySelector(".title")?.textContent).toBe("Bash");
    expect(card.querySelector(".summary-text")?.textContent).toBe("npm test");
    expect(labels(card)).toEqual(["Command", "Output"]);
  });

  it("stops every card still running when the artifact settles, ref or none", () => {
    const { stream, entry, cards } = page();
    entry("one", { status: "running", title: "A" });
    entry("two", { status: "running", title: "B" });
    entry("three", { ref: "t3", status: "running", title: "C" });

    stream.emit("settled", { status: "completed" });

    expect(cards().map((card) => card.getAttribute("data-status"))).toEqual([
      "stopped",
      "stopped",
      "stopped"
    ]);
    expect(stream.closed).toBe(true);
  });

  it("pins the latest checklist, and clears it on an empty one", () => {
    const { document, entry } = page();
    const todos = document.getElementById("todos")!;
    expect(todos.hasAttribute("hidden")).toBe(true);

    entry("1/2 done", {
      ref: "w1",
      status: "running",
      checklist: [
        { text: "read", state: "done" },
        { text: "write", state: "active" }
      ]
    });
    expect(todos.hasAttribute("hidden")).toBe(false);
    expect(document.getElementById("todos-count")?.textContent).toBe("1/2");

    entry("0/0 done", { ref: "w2", status: "running", checklist: [] });
    expect(todos.hasAttribute("hidden")).toBe(true);
  });

  /**
   * A media entry. The descriptor is all the stream carries, so the page builds
   * the URL itself — from its own location and the sequence, which is why no
   * token and nothing caller-supplied reaches markup.
   */
  it("renders an entry's image, and keeps its words when the bytes are gone", () => {
    const { document, entry } = page();
    entry("a chart of the run", undefined, {
      type: "image/png",
      byteLength: 11
    });

    const image = document.querySelector("img.image")!;
    expect(image.getAttribute("src")).toBe("/a/token/1");
    // The words are the alt text and nothing else, so a screen reader is not
    // read the same string twice.
    expect(image.getAttribute("alt")).toBe("a chart of the run");
    expect(document.querySelector(".prose .md")).toBeNull();

    (image as unknown as { onerror: () => void }).onerror();
    expect(document.querySelector("img.image")).toBeNull();
    // The alt text was the only copy of what the entry said, so it survives the
    // image it was attached to.
    expect(document.querySelector(".prose .note")?.textContent).toBe(
      "a chart of the run (image unavailable)"
    );
  });

  it("opens a card onto its image, above the sections it arrived with", () => {
    const { entry, cards } = page();
    entry(
      "a chart",
      {
        ref: "t1",
        status: "ok",
        sections: [{ label: "Output", body: "done" }]
      },
      { type: "image/png", byteLength: 11 }
    );

    const card = cards()[0]!;
    expect(card.querySelector(".card-body")?.children[0]?.tagName).toBe("IMG");
    expect(labels(card)).toEqual(["Output"]);
    // A card with a body is one a reader can open.
    expect(card.className).not.toContain("bare");
  });

  it("says how long the stream has been quiet while live, and nothing once settled", () => {
    const { document, stream, entry, tick } = page();
    const pulse = document.getElementById("pulse")!;
    entry("working");
    tick();
    expect(pulse.hasAttribute("hidden")).toBe(false);
    expect(pulse.textContent).toMatch(/^Working · last update \d+s ago$/);

    stream.emit("settled", { status: "completed" });
    expect(pulse.hasAttribute("hidden")).toBe(true);
  });
});
