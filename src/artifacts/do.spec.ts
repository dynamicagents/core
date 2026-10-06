import { describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { MAX_QUEUED_FRAMES, type Artifacts } from "./do.js";
import { ARTIFACT_EVENTS } from "./events.js";
import { MAX_ARTIFACT_MEDIA_BYTES } from "./media.js";
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

const bytesRequest = (token: string, sequence: number) =>
  new Request(`https://agent.example/a/${token}/${sequence}`);

/** PNG and JPEG as far as the signature check is concerned, which is far enough. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = new Uint8Array([...PNG_SIGNATURE, 0x00, 0x01, 0x02]);
const PNG_AGAIN = new Uint8Array([...PNG_SIGNATURE, 0x07, 0x07, 0x07]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

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
    // The call a replay makes again after a crash: no caller between turns
    // remembers the token, so opening has to *find* rather than create.
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
    expect(
      await artifacts.addEntry(token, { label: "a 0", text: "one" })
    ).toMatchObject({ sequence: 1 });
    expect(
      await artifacts.addEntry(token, { label: "a 0", text: "two" })
    ).toMatchObject({ sequence: 2 });
    expect(
      await artifacts.addEntry(token, { label: "b 1", text: "three" })
    ).toMatchObject({ sequence: 3 });

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
   * What a retry costs the log: nothing. Both emission sites run inside durable
   * steps that can be retried, so the same note arrives twice — and the key is
   * what makes the second one read back the first's sequence instead of
   * appending a duplicate beside it.
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
    ).toMatchObject({ sequence: 1 });
    expect(
      await artifacts.addEntry(token, {
        key: "claude:0",
        label: "a 0",
        text: "first"
      })
    ).toMatchObject({ sequence: 1 });
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

describe("Artifacts — announcing the link", () => {
  /**
   * The bit a writer cannot keep for itself. "This note opened the artifact" is
   * not "somebody received the link": the post can fail, and the isolate that
   * sent it is gone by the next note — so what a later writer reads back is this.
   */
  it("says nothing was announced until something says it was", async () => {
    const artifacts = fresh("announce");
    const token = await artifacts.createArtifact(KIND);
    expect(
      await artifacts.addEntry(token, { key: "a:0", label: "a 0", text: "one" })
    ).toEqual({ sequence: 1, announced: false });
    // A note before the announcement is a note whose link still needs sending.
    expect(
      await artifacts.addEntry(token, { key: "a:1", label: "a 0", text: "two" })
    ).toEqual({ sequence: 2, announced: false });

    expect(await artifacts.announce(token)).toBe(true);
    // A repeat is not a second announcement, the distinction `settle` draws.
    expect(await artifacts.announce(token)).toBe(false);
    expect(
      await artifacts.addEntry(token, {
        key: "a:2",
        label: "a 0",
        text: "three"
      })
    ).toEqual({ sequence: 3, announced: true });
  });

  it("refuses a token that names nothing", async () => {
    const artifacts = fresh("announce-unknown");
    expect(await artifacts.announce("Y".repeat(40))).toBe(false);
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

describe("Artifacts — locking", () => {
  it("refuses every note after it, and settles in its status", async () => {
    const artifacts = fresh("lock");
    const token = await artifacts.createArtifact("plan");
    await artifacts.addEntry(token, { label: "plan", text: "the plan" });

    expect(await artifacts.lock(token, "approved")).toBe(true);
    expect(await artifacts.lock(token, "rejected")).toBe(false);
    expect(
      await artifacts.addEntry(token, { label: "plan", text: "a new plan" })
    ).toBeNull();
    expect(await artifacts.readArtifact(token)).toMatchObject({
      status: "approved",
      locked: true,
      entries: [{ sequence: 1, text: "the plan" }]
    });
  });

  /**
   * The write that goes with a lock — the answer that approved it — is recorded
   * first, and a retry of it must find its note rather than the lock.
   */
  it("still answers a replay its key catches", async () => {
    const artifacts = fresh("lock-replay");
    const token = await artifacts.createArtifact("plan");
    const first = await artifacts.addEntry(token, {
      label: "approval",
      text: "Approved.",
      key: "answer"
    });
    await artifacts.lock(token, "approved");

    expect(
      await artifacts.addEntry(token, {
        label: "approval",
        text: "Approved.",
        key: "answer"
      })
    ).toEqual(first);
  });

  it("locks a settled artifact too, in the status it is given", async () => {
    const artifacts = fresh("lock-settled");
    const token = await artifacts.createArtifact("plan");
    await artifacts.settle(token, "completed");

    expect(await artifacts.lock(token, "failed")).toBe(true);
    expect(await artifacts.readArtifact(token)).toMatchObject({
      status: "failed",
      locked: true
    });
  });

  it("ends a live stream, as a settle does", async () => {
    const artifacts = fresh("lock-stream");
    const token = await artifacts.createArtifact("plan");
    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    expect((await stream.next())?.event).toBe("ready");

    await artifacts.lock(token, "approved");
    expect(await stream.next()).toMatchObject({
      event: "settled",
      data: { status: "approved" }
    });
    expect(await stream.next()).toBeNull();
  });

  /**
   * The note that decides an artifact and the lock land in one call, so no
   * other writer can lock it between them and leave this note standing on an
   * artifact it did not decide.
   */
  it("locks with the note that decides it, in one call", async () => {
    const artifacts = fresh("lock-with-note");
    const token = await artifacts.createArtifact("plan");
    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    expect((await stream.next())?.event).toBe("ready");

    const decided = await artifacts.addEntry(
      token,
      { label: "approval", text: "Approved.", key: "a" },
      { lock: "approved" }
    );
    expect(decided).not.toBeNull();
    expect((await stream.next())?.event).toBe("entry");
    expect(await stream.next()).toMatchObject({
      event: "settled",
      data: { status: "approved" }
    });

    // The replay is recorded; another answer is not.
    expect(
      await artifacts.addEntry(
        token,
        { label: "approval", text: "Approved.", key: "a" },
        { lock: "approved" }
      )
    ).toEqual(decided);
    expect(
      await artifacts.addEntry(
        token,
        { label: "approval", text: "Approved.", key: "b" },
        { lock: "approved" }
      )
    ).toBeNull();
  });

  it("refuses a token that names nothing", async () => {
    const artifacts = fresh("lock-unknown");
    expect(await artifacts.lock("Q".repeat(40), "approved")).toBe(false);
  });
});

describe("Artifacts — reading one back", () => {
  it("answers its kind, status and every note, oldest first", async () => {
    const artifacts = fresh("read");
    const token = await artifacts.createArtifact("plan");
    await artifacts.addEntry(token, { label: "plan", text: "one" });
    await artifacts.addEntry(token, { label: "caller", text: "two" });

    expect(await artifacts.readArtifact(token)).toMatchObject({
      kind: "plan",
      status: null,
      locked: false,
      entries: [
        { sequence: 1, label: "plan", text: "one" },
        { sequence: 2, label: "caller", text: "two" }
      ]
    });
  });

  it("answers null for a token that names nothing", async () => {
    const artifacts = fresh("read-unknown");
    expect(await artifacts.readArtifact("Q".repeat(40))).toBeNull();
  });

  it("answers its state alone, without the notes", async () => {
    const artifacts = fresh("state");
    const token = await artifacts.createArtifact("plan");
    await artifacts.addEntry(token, { label: "plan", text: "one" });
    await artifacts.lock(token, "approved");

    expect(await artifacts.artifactState(token)).toEqual({
      kind: "plan",
      status: "approved",
      locked: true
    });
    expect(await artifacts.artifactState("Q".repeat(40))).toBeNull();
  });
});

describe("Artifacts — an image on an entry", () => {
  it("serves the bytes it was given, byte for byte", async () => {
    const artifacts = fresh("media");
    const token = await artifacts.createArtifact("plan");
    expect(
      await artifacts.addEntry(token, {
        label: "plan",
        text: "the shape of it",
        media: { type: "image/png", data: PNG }
      })
    ).toMatchObject({ sequence: 1 });

    const response = await artifacts.fetch(bytesRequest(token, 1));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  /**
   * The headers a public URL owes. `max-age` is what is left of the artifact, so
   * a cache populated now expires no later than the bytes it copied.
   */
  it("lets a cache keep the bytes, but never past the artifact", async () => {
    await runInDurableObject(fresh("media-cache"), async (instance) => {
      const halfway = Date.now() - ARTIFACT_RETENTION_MS / 2;
      instance.clockOverride = () => halfway;
      const token = await instance.createArtifact("plan");
      await instance.addEntry(token, {
        label: "plan",
        text: "the shape of it",
        media: { type: "image/png", data: PNG }
      });

      instance.clockOverride = () => Date.now();
      const response = await instance.fetch(bytesRequest(token, 1));
      const control = response.headers.get("cache-control") ?? "";
      expect(control).toContain("public");
      expect(control).toContain("immutable");
      const maxAge = Number(/max-age=(\d+)/.exec(control)?.[1]);
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(ARTIFACT_RETENTION_MS / 2000);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBe("inline");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });
  });

  /**
   * The sweep runs on a write, so an artifact past its cutoff is still readable
   * until one lands. Serving it is the events route's behaviour too; what the
   * floor on `max-age` adds is that nothing caches what is already overdue.
   */
  it("offers no cache for an image the sweep has not reached", async () => {
    await runInDurableObject(fresh("media-overdue"), async (instance) => {
      instance.clockOverride = () =>
        Date.now() - ARTIFACT_RETENTION_MS - 60_000;
      const token = await instance.createArtifact("plan");
      await instance.addEntry(token, {
        label: "plan",
        text: "the shape of it",
        media: { type: "image/png", data: PNG }
      });

      instance.clockOverride = () => Date.now();
      const response = await instance.fetch(bytesRequest(token, 1));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("max-age=0");
    });
  });

  it("carries the descriptor on every read of the log, and the bytes on none", async () => {
    const artifacts = fresh("media-descriptor");
    const token = await artifacts.createArtifact("plan");
    await artifacts.addEntry(token, {
      label: "plan",
      text: "the shape of it",
      media: { type: "image/png", data: PNG }
    });

    const page = await artifacts.readArtifact(token);
    expect(page?.entries).toEqual([
      {
        sequence: 1,
        label: "plan",
        text: "the shape of it",
        at: expect.any(Number),
        media: { type: "image/png", byteLength: PNG.byteLength }
      }
    ]);

    const stream = frames(await artifacts.fetch(eventsRequest(token)));
    await stream.next(); // `ready`
    const frame = await stream.next();
    // The frame is JSON on a bounded queue, so what rides it is the descriptor
    // and the alt text — never a payload.
    expect(Object.keys(frame?.data as object).sort()).toEqual([
      "at",
      "label",
      "media",
      "sequence",
      "text"
    ]);
    expect(frame?.data).toMatchObject({
      media: { type: "image/png", byteLength: PNG.byteLength }
    });
    await stream.cancel();
  });

  it("gives a replayed key its first sequence, and leaves the bytes alone", async () => {
    const artifacts = fresh("media-replay");
    const token = await artifacts.createArtifact("plan");
    const first = await artifacts.addEntry(token, {
      key: "plan:0",
      label: "plan",
      text: "the shape of it",
      media: { type: "image/png", data: PNG }
    });
    expect(
      await artifacts.addEntry(token, {
        key: "plan:0",
        label: "plan",
        text: "the shape of it",
        media: { type: "image/png", data: PNG_AGAIN }
      })
    ).toEqual(first);

    const response = await artifacts.fetch(bytesRequest(token, 1));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect((await artifacts.readArtifact(token))?.entries).toHaveLength(1);
  });

  it("stores the view it was handed, not the buffer behind it", async () => {
    const artifacts = fresh("media-view");
    const token = await artifacts.createArtifact("plan");
    const backing = new Uint8Array([0x99, 0x99, ...PNG, 0x99, 0x99]);
    await artifacts.addEntry(token, {
      label: "plan",
      text: "the shape of it",
      media: {
        type: "image/png",
        data: backing.subarray(2, 2 + PNG.byteLength)
      }
    });

    expect((await artifacts.readArtifact(token))?.entries[0]?.media).toEqual({
      type: "image/png",
      byteLength: PNG.byteLength
    });
    const response = await artifacts.fetch(bytesRequest(token, 1));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  /**
   * A refusal **throws** rather than answering `null`, because `null` already
   * means "swept, or locked" and a caller branches on it — see `transcribeNote`.
   *
   * Driven on the instance rather than through the stub, as every spec here with
   * a throwing method is: an RPC rejection is reported inside the object as an
   * unhandled one as well, and a suite that tolerates those tolerates real ones.
   * What the refusals leave behind is the half worth asserting anyway, and
   * storage is reachable from here.
   */
  it("refuses a payload past the limit, and writes nothing at all", async () => {
    await runInDurableObject(
      fresh("media-too-large"),
      async (instance, state) => {
        const token = await instance.createArtifact("plan");
        const huge = new Uint8Array(MAX_ARTIFACT_MEDIA_BYTES + 1);
        huge.set(PNG_SIGNATURE);

        await expect(
          instance.addEntry(token, {
            label: "plan",
            text: "the shape of it",
            media: { type: "image/png", data: huge }
          })
        ).rejects.toThrow(new RegExp(String(MAX_ARTIFACT_MEDIA_BYTES)));

        expect((await instance.readArtifact(token))?.entries).toEqual([]);
        expect(
          state.storage.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM artifact_entry_media"
            )
            .one().n
        ).toBe(0);
      }
    );
  });

  it("refuses bytes that are not the type they claim", async () => {
    await runInDurableObject(fresh("media-mismatch"), async (instance) => {
      const token = await instance.createArtifact("plan");
      await expect(
        instance.addEntry(token, {
          label: "plan",
          text: "the shape of it",
          media: { type: "image/png", data: JPEG }
        })
      ).rejects.toThrow(/does not start with/);
      expect((await instance.readArtifact(token))?.entries).toEqual([]);
    });
  });

  it("refuses SVG rather than sanitizing it", async () => {
    await runInDurableObject(fresh("media-svg"), async (instance) => {
      const token = await instance.createArtifact("plan");
      await expect(
        instance.addEntry(token, {
          label: "plan",
          text: "the shape of it",
          media: {
            type: "image/svg+xml",
            data: new TextEncoder().encode("<svg><script/></svg>")
          }
        })
      ).rejects.toThrow(/sanitized/);
      expect((await instance.readArtifact(token))?.entries).toEqual([]);
    });
  });

  it.each([
    ["a token that names nothing", "M".repeat(40), 1],
    ["a sequence past the end", null, 9],
    ["an entry carrying no image", null, 1]
  ])("is a 404 for %s", async (_label, unknown, sequence) => {
    const artifacts = fresh("media-404");
    const token = await artifacts.createArtifact("plan");
    await artifacts.addEntry(token, { label: "plan", text: "no image here" });

    // One answer for all three: telling them apart tells whoever guessed a URL
    // which half of it they guessed right.
    const response = await artifacts.fetch(
      bytesRequest(unknown ?? token, sequence)
    );
    expect(response.status).toBe(404);
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

  it("takes the images on it too, so none outlives its artifact", async () => {
    await runInDurableObject(
      fresh("retention-media"),
      async (instance, state) => {
        instance.clockOverride = () =>
          Date.now() - ARTIFACT_RETENTION_MS - 60_000;
        const stale = await instance.createArtifact("plan", "old-plan");
        await instance.addEntry(stale, {
          label: "plan",
          text: "the shape of it",
          media: { type: "image/png", data: PNG }
        });

        instance.clockOverride = () => Date.now();
        // The addition that pays for the sweep.
        await instance.createArtifact("plan", "new-plan");

        const blobs = state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_entry_media")
          .one().n;
        expect(blobs).toBe(0);
        expect((await instance.fetch(bytesRequest(stale, 1))).status).toBe(404);
      }
    );
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

  /**
   * The bound on one reader's unsent stream.
   *
   * Written against a real stream inside the object, because the whole mechanism
   * is `TransformStream` backpressure: a frame is handed over only once the
   * reader took the last one, so the frames a reader is not taking accumulate
   * here. Past the bound that reader is dropped — and dropping one may not cost
   * the readers keeping up anything, since they share the object with it.
   */
  it("drops a reader that stops consuming, and keeps the ones that do", async () => {
    await runInDurableObject(fresh("backpressure"), async (instance) => {
      const token = await instance.createArtifact(KIND);

      // Opened and never read: every frame after the first stays queued. The
      // lock is taken and nothing is read, which is the shape of the problem —
      // and it also means the error the drop leaves on the body is claimed,
      // rather than reported against whatever was running at the time.
      const stalled = (await instance.fetch(eventsRequest(token))).body!;
      const unread = stalled.getReader();

      const reading = frames(await instance.fetch(eventsRequest(token)));
      expect(await reading.next()).toMatchObject({
        event: ARTIFACT_EVENTS.ready
      });

      const notes = MAX_QUEUED_FRAMES * 2;
      for (let i = 0; i < notes; i += 1) {
        await instance.addEntry(token, {
          key: `note:${i}`,
          label: "a 0",
          text: `note ${i}`
        });
        // In lockstep, which is what keeping up means: this reader is never
        // holding more than the frame it is about to take, so the bound that
        // drops the other one never comes near it.
        expect(await reading.next()).toMatchObject({
          data: { text: `note ${i}` }
        });
      }

      // The one that read nothing was dropped rather than served, which is what
      // leaves its queue bounded. Its `EventSource` reconnects into a replay
      // from `Last-Event-ID`, so the frames discarded here are not lost — and
      // the log is whole for a reader that arrives after the drop.
      await expect(unread.read()).rejects.toThrow(/fell behind/);

      // Dropping a watcher discards frames, never entries: the log is whole for
      // the reader that arrives next, which is the same reader reconnecting.
      await instance.settle(token, "completed");
      expect(await reading.next()).toMatchObject({
        event: ARTIFACT_EVENTS.settled
      });
      const replayed = await (
        await instance.fetch(eventsRequest(token))
      ).text();
      expect(replayed.match(/"label":"a 0"/g)).toHaveLength(notes);
    });
  });

  it("serves the stream and an entry's bytes, and nothing else", async () => {
    const artifacts = fresh("stream-route");
    const token = await artifacts.createArtifact(KIND);
    await artifacts.addEntry(token, {
      label: "a 0",
      text: "the shape of it",
      media: { type: "image/png", data: PNG }
    });

    // The page is the edge's to serve from a string, so it never reaches here.
    for (const path of [`/a/${token}`, `/a/${token}/raw`]) {
      const response = await artifacts.fetch(
        new Request(`https://agent.example${path}`)
      );
      expect(response.status).toBe(404);
    }
    expect((await artifacts.fetch(bytesRequest(token, 1))).status).toBe(200);
  });
});
