import { describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Artifacts } from "./do.js";
import { ARTIFACT_RETENTION_MS } from "./store.js";

/**
 * The artifacts object, against a real one.
 *
 * A fake storage would assert that the fake works, and every rule here is a
 * property of SQLite or of a live response body: sequences come from `MAX`,
 * retention is a range delete, and "the stream ends" is the readable side of a
 * `TransformStream` actually closing. None of that survives a stand-in.
 *
 * Each test takes a fresh object, so storage is isolated per case without a
 * teardown to forget.
 */

// `wrangler types --include-env=false` leaves the ambient `Env` without the
// test worker's bindings, so they are reached by name — as the other DO specs
// reach theirs.
const ns = (env as unknown as Record<string, DurableObjectNamespace<Artifacts>>)
  .ARTIFACTS!;

const fresh = (label: string) =>
  ns.get(ns.idFromName(`${label}:${crypto.randomUUID()}`));

const KIND = "session-transcript";

const eventsRequest = (token: string, lastEventId?: string) =>
  new Request(`https://agent.example/a/${token}/events`, {
    headers: lastEventId ? { "last-event-id": lastEventId } : {}
  });

interface Frame {
  id?: string;
  event: string;
  data: unknown;
}

function parseFrame(raw: string): Frame {
  const frame: Frame = { event: "", data: undefined };
  for (const line of raw.split("\n")) {
    const at = line.indexOf(": ");
    const field = line.slice(0, at);
    const value = line.slice(at + 2);
    if (field === "id") frame.id = value;
    if (field === "event") frame.event = value;
    if (field === "data") frame.data = JSON.parse(value);
  }
  return frame;
}

/**
 * Read the stream a frame at a time.
 *
 * Frame-at-a-time rather than `await response.text()`, because the cases worth
 * testing are the ones where the body is still open: a reader has to be able to
 * see what has arrived without the stream having ended.
 */
function frames(response: Response) {
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  return {
    /** The next frame, or `null` once the stream has ended. */
    async next(): Promise<Frame | null> {
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at !== -1) {
          const raw = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          return parseFrame(raw);
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += value;
      }
    },
    cancel: () => reader.cancel()
  };
}

describe("Artifacts — opening one", () => {
  it("mints a token per call, and never the same one twice", async () => {
    const artifacts = fresh("mint");
    const minted = await Promise.all([
      artifacts.createArtifact(KIND),
      artifacts.createArtifact(KIND),
      artifacts.createArtifact(KIND)
    ]);
    for (const token of minted) expect(token).toMatch(/^[0-9A-Za-z]{40}$/);
    expect(new Set(minted).size).toBe(3);
  });

  it("is idempotent on a source key, which is what a retry needs", async () => {
    const artifacts = fresh("idempotent");
    const first = await artifacts.createArtifact(KIND, "task-1");
    // The call a Workflow step makes again after a crash: no caller between
    // turns remembers the token, so opening has to *find* rather than create.
    expect(await artifacts.createArtifact(KIND, "task-1")).toBe(first);
    expect(await artifacts.tokenFor(KIND, "task-1")).toBe(first);
  });

  it("keys the source key under its kind, not across kinds", async () => {
    const artifacts = fresh("kinds");
    const transcript = await artifacts.createArtifact(KIND, "task-1");
    const other = await artifacts.createArtifact("review-log", "task-1");
    expect(other).not.toBe(transcript);
  });

  it("does not open one to answer a lookup", async () => {
    const artifacts = fresh("lookup");
    expect(await artifacts.tokenFor(KIND, "never-used")).toBeNull();
  });
});

describe("Artifacts — appending", () => {
  it("numbers notes from one, in the order they arrive", async () => {
    const artifacts = fresh("order");
    const token = await artifacts.createArtifact(KIND);
    expect(await artifacts.addEntry(token, { label: "a 0", text: "one" })).toBe(
      1
    );
    expect(await artifacts.addEntry(token, { label: "a 0", text: "two" })).toBe(
      2
    );
    expect(
      await artifacts.addEntry(token, { label: "b 1", text: "three" })
    ).toBe(3);

    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    await stream.next(); // `ready`
    expect(await stream.next()).toMatchObject({
      id: "1",
      data: { sequence: 1, label: "a 0", text: "one" }
    });
    expect(await stream.next()).toMatchObject({ data: { text: "two" } });
    expect(await stream.next()).toMatchObject({
      data: { label: "b 1", text: "three" }
    });
    await stream.cancel();
  });

  /**
   * The property the link rests on. Both emission sites run inside durable
   * steps that can be retried, so "this note was the first" has to survive the
   * step running twice — and it does only because the key makes the append
   * land on the sequence it had the first time.
   */
  it("gives a replayed key the sequence it got the first time", async () => {
    const artifacts = fresh("replay");
    const token = await artifacts.createArtifact(KIND);
    expect(
      await artifacts.addEntry(token, {
        key: "claude:0",
        label: "a 0",
        text: "first"
      })
    ).toBe(1);
    expect(
      await artifacts.addEntry(token, {
        key: "claude:0",
        label: "a 0",
        text: "first"
      })
    ).toBe(1);
    await artifacts.addEntry(token, {
      key: "claude:1",
      label: "a 0",
      text: "second"
    });

    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    await stream.next();
    expect(await stream.next()).toMatchObject({ data: { sequence: 1 } });
    expect(await stream.next()).toMatchObject({ data: { sequence: 2 } });
    await stream.cancel();
  });

  it("refuses a token that names nothing", async () => {
    const artifacts = fresh("unknown");
    expect(
      await artifacts.addEntry("Z".repeat(40), { label: "a 0", text: "lost" })
    ).toBeNull();
  });
});

describe("Artifacts — settling", () => {
  it("records the status once, and says which call did it", async () => {
    const artifacts = fresh("settle");
    const token = await artifacts.createArtifact(KIND);
    expect(await artifacts.settle(token, "completed")).toBe(true);
    // A replayed settle is not a second one — the distinction a caller needs to
    // avoid reporting the same ending twice.
    expect(await artifacts.settle(token, "failed")).toBe(false);

    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    expect(await stream.next()).toMatchObject({
      event: "ready",
      data: { kind: KIND, status: "completed" }
    });
  });

  it("refuses a token that names nothing", async () => {
    const artifacts = fresh("settle-unknown");
    expect(await artifacts.settle("Q".repeat(40), "completed")).toBe(false);
  });
});

describe("Artifacts — retention", () => {
  /**
   * Lazily, on the next write, and never on an alarm: a deletion nobody is
   * waiting on does not deserve the one alarm a Durable Object has.
   */
  it("drops an artifact past the window, and its notes with it", async () => {
    await runInDurableObject(fresh("retention"), async (instance, state) => {
      const month = Date.now() - ARTIFACT_RETENTION_MS - 60_000;
      instance.clockOverride = () => month;
      const stale = await instance.createArtifact(KIND, "old-task");
      await instance.addEntry(stale, { label: "a 0", text: "long ago" });

      instance.clockOverride = () => Date.now();
      // The addition that pays for the sweep.
      const current = await instance.createArtifact(KIND, "new-task");

      expect(await instance.tokenFor(KIND, "old-task")).toBeNull();
      expect(
        await instance.addEntry(stale, { label: "a 0", text: "too late" })
      ).toBeNull();
      // The notes go with the artifact; a row keyed by a token nothing resolves
      // would be unreachable and unbounded.
      const rows = state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_entries")
        .one().n;
      expect(rows).toBe(0);
      expect(await instance.tokenFor(KIND, "new-task")).toBe(current);
    });
  });

  it("keeps one still inside the window", async () => {
    await runInDurableObject(fresh("retention-keep"), async (instance) => {
      instance.clockOverride = () =>
        Date.now() - ARTIFACT_RETENTION_MS + 60_000;
      const token = await instance.createArtifact(KIND, "recent-task");
      await instance.addEntry(token, { label: "a 0", text: "yesterday" });

      instance.clockOverride = () => Date.now();
      await instance.createArtifact(KIND, "another-task");
      expect(await instance.tokenFor(KIND, "recent-task")).toBe(token);
    });
  });
});

describe("Artifacts — the event stream", () => {
  it("replays what is there, then streams what arrives, then ends", async () => {
    const artifacts = fresh("live");
    const token = await artifacts.createArtifact(KIND);
    await artifacts.addEntry(token, { label: "a 0", text: "before" });

    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    expect(await stream.next()).toEqual({
      event: "ready",
      data: { kind: KIND, status: null }
    });
    expect(await stream.next()).toMatchObject({
      event: "entry",
      data: { text: "before" }
    });

    // The wake-up: a write on the ingest side reaching a reader on this one.
    await artifacts.addEntry(token, { label: "a 0", text: "after" });
    expect(await stream.next()).toMatchObject({
      event: "entry",
      id: "2",
      data: { text: "after" }
    });

    await artifacts.settle(token, "completed");
    expect(await stream.next()).toEqual({
      event: "settled",
      data: { status: "completed" }
    });
    // Ends, rather than idling on a run that will never say anything again.
    expect(await stream.next()).toBeNull();
  });

  it("serves a settled artifact whole and ends immediately", async () => {
    const artifacts = fresh("replay-settled");
    const token = await artifacts.createArtifact(KIND);
    await artifacts.addEntry(token, { label: "a 0", text: "one" });
    await artifacts.addEntry(token, { label: "a 0", text: "two" });
    await artifacts.settle(token, "failed");

    const body = await (await artifacts.fetch(eventsRequest(token))).text();
    const events = body.split("\n\n").filter(Boolean).map(parseFrame);
    expect(events.map((frame) => frame.event)).toEqual([
      "ready",
      "entry",
      "entry",
      "settled"
    ]);
    expect(events.at(-1)?.data).toEqual({ status: "failed" });
  });

  it("resumes after the sequence a reconnecting reader already has", async () => {
    const artifacts = fresh("resume");
    const token = await artifacts.createArtifact(KIND);
    for (const text of ["one", "two", "three"]) {
      await artifacts.addEntry(token, { label: "a 0", text });
    }
    await artifacts.settle(token, "completed");

    const body = await (
      await artifacts.fetch(eventsRequest(token, "2"))
    ).text();
    expect(body).not.toContain('"one"');
    expect(body).not.toContain('"two"');
    expect(body).toContain('"three"');
  });

  it("starts from the beginning when Last-Event-ID is unreadable", async () => {
    const artifacts = fresh("resume-garbage");
    const token = await artifacts.createArtifact(KIND);
    await artifacts.addEntry(token, { label: "a 0", text: "one" });
    await artifacts.settle(token, "completed");

    // A mangled header must cost a reader duplicates, never a gap.
    const body = await (
      await artifacts.fetch(eventsRequest(token, "not-a-number"))
    ).text();
    expect(body).toContain('"one"');
  });

  it("is a 404 for a token that names nothing", async () => {
    const artifacts = fresh("stream-unknown");
    const response = await artifacts.fetch(eventsRequest("K".repeat(40)));
    expect(response.status).toBe(404);
  });

  it("serves nothing but the events route", async () => {
    const artifacts = fresh("stream-route");
    const token = await artifacts.createArtifact(KIND);
    const response = await artifacts.fetch(
      new Request(`https://agent.example/a/${token}`)
    );
    expect(response.status).toBe(404);
  });
});
