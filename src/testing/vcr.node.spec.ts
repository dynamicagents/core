/**
 * The recorder — routing, the control channel, and the record path.
 *
 * Node realm (`*.node.spec.ts`), because the recorder *is* the Node half: it
 * reaches `node:fs` and is handed to Miniflare as an `outboundService` rather
 * than running inside one. Driving it directly here, instead of through workerd,
 * is what makes the control-channel cases deterministic — the recorder is a
 * single instance shared by every test file in a run, so two workerd specs
 * activating cassettes would interleave and trip its own parallelism tripwire.
 *
 * `vcr.spec.ts` covers the one thing this cannot: that workerd's `fetch()`
 * actually arrives here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVcr, type Vcr, type VcrRequest } from "./vcr.js";
import { VCR_CONTROL_ORIGIN, VCR_MARKER_HEADER } from "./vcr-shared.js";

const CASSETTE = "demo.snapshot.json";

function request(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  } = {}
): VcrRequest {
  const headers = init.headers ?? {};
  const body =
    typeof init.body === "object"
      ? init.body
      : new TextEncoder().encode(init.body ?? "");
  return {
    url,
    method: init.method ?? "GET",
    headers: {
      forEach: (cb) => {
        for (const [name, value] of Object.entries(headers)) cb(value, name);
      },
      get: (name) => headers[name.toLowerCase()] ?? null
    },
    arrayBuffer: async () => body.buffer as ArrayBuffer
  };
}

const control = (vcr: Vcr, p: string): Promise<Response> =>
  vcr.outboundService(request(`${VCR_CONTROL_ORIGIN}${p}`, { method: "POST" }));

const b64 = (s: string): string => Buffer.from(s).toString("base64");

/** What `Recorder.#live` passes to the global `fetch`, so a spy can assert on it. */
interface LiveInit {
  method: string;
  headers: [string, string][];
  body?: Uint8Array;
}

/** A `fetch` stand-in typed for its arguments, so `mock.calls` is inspectable. */
const liveFetch = (body = "ok") =>
  vi.fn(async (_url: string, _init: LiveInit) => new Response(body));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vcr-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** A cassette on disk with one GET recorded. */
function seed(responses = [{ statusCode: 200, headers: {}, body: b64("ok") }]) {
  writeFileSync(
    path.join(dir, CASSETTE),
    JSON.stringify([
      {
        request: {
          method: "GET",
          url: "https://api.test/thing",
          headers: {},
          body: ""
        },
        responses
      }
    ])
  );
}

const playback = (options = {}): Vcr =>
  createVcr({ snapshotsDir: dir, record: false, ...options });

describe("control channel", () => {
  it("marks every response, so a spec can prove the recorder is installed", async () => {
    // Miniflare ignores an option it does not recognise rather than rejecting
    // it, so a config wired to a removed option (`fetchMock` on pool 0.20) is
    // indistinguishable from no config at all — every request just leaves for
    // the real network. This header is how `setupRecording()` tells the
    // difference before running a test.
    seed();
    const res = await control(playback(), `/use?cassette=${CASSETTE}`);
    expect(res.headers.get(VCR_MARKER_HEADER)).toBe("1");
    expect(res.status).toBe(200);
  });

  it("answers 404 for a cassette that is not on disk", async () => {
    const res = await control(playback(), `/use?cassette=${CASSETTE}`);
    expect(res.status).toBe(404);
  });

  it("refuses a name that could escape the snapshots directory", async () => {
    // The name is joined to a directory path, so it is a path-traversal sink.
    const vcr = playback();
    for (const name of [
      "../../etc/passwd",
      "a/b.snapshot.json",
      "x.json",
      ""
    ]) {
      const res = await control(
        vcr,
        `/use?cassette=${encodeURIComponent(name)}`
      );
      expect(res.status, name).toBe(400);
    }
  });

  it("refuses a second cassette while one is held", async () => {
    // Recorded specs must stay sequential; two sharing this recorder mis-record
    // rather than failing, so the collision is surfaced instead.
    seed();
    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    const res = await control(vcr, "/use?cassette=other.snapshot.json");
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(CASSETTE);
  });

  it("re-activating the same cassette is not a collision", async () => {
    seed();
    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    expect((await control(vcr, `/use?cassette=${CASSETTE}`)).status).toBe(200);
  });

  it("release clears the active cassette", async () => {
    seed();
    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    await control(vcr, "/release");

    const res = await vcr.outboundService(request("https://api.test/thing"));
    expect(await res.text()).toContain("no cassette is active");
  });
});

describe("playback", () => {
  it("serves a recorded response without touching the network", async () => {
    seed();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    const res = await vcr.outboundService(request("https://api.test/thing"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replays a status that must not carry a body", async () => {
    // `Response` rejects *any* non-null body on 204/205/304 — an empty
    // Uint8Array throws exactly as a full one does — so a recorded 204 that is
    // handed its (empty) recorded body cannot be replayed at all.
    seed([{ statusCode: 204, headers: {}, body: "" }]);
    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);

    const res = await vcr.outboundService(request("https://api.test/thing"));
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("blocks an unrecorded request, naming it and the cassette", async () => {
    seed();
    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);

    const res = await vcr.outboundService(request("https://api.test/other"));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("GET https://api.test/other");
    expect(body).toContain(CASSETTE);
    expect(body).toContain("RECORD=1");
  });

  it("blocks everything when no cassette is active", async () => {
    // The state an ordinary, non-recorded spec runs in: it must not be able to
    // reach the network by accident.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await playback().outboundService(
      request("https://api.test/thing")
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("no cassette is active");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports every miss on release, so the test itself can fail", async () => {
    // A miss cannot reject the Worker's `fetch()` — Miniflare turns whatever an
    // outbound service throws into a 500 — so this list is what `setupRecording`
    // turns into a failure naming the cause.
    seed();
    const vcr = playback();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    await vcr.outboundService(request("https://api.test/other"));
    await vcr.outboundService(
      request("https://api.test/more", { method: "POST" })
    );

    expect(await (await control(vcr, "/release")).json()).toEqual({
      misses: ["GET https://api.test/other", "POST https://api.test/more"]
    });
  });

  it("starts each test's miss list empty", async () => {
    seed();
    const vcr = playback();
    await vcr.outboundService(request("https://api.test/leaked"));
    await control(vcr, `/use?cassette=${CASSETTE}`);

    expect(await (await control(vcr, "/release")).json()).toEqual({
      misses: []
    });
  });
});

describe("routing", () => {
  it("hands a `handlers` host to its stub, with no cassette involved", async () => {
    // Replaces what MockAgent interceptors did: a fixture, not a recording.
    const vcr = playback({
      handlers: {
        "gatekeeper.test": () => new Response("jwks", { status: 200 })
      }
    });
    const res = await vcr.outboundService(
      request("https://gatekeeper.test/.well-known/jwks.json")
    );
    expect(await res.text()).toBe("jwks");
  });

  it("lets an allowNetworkHosts host reach the real network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("live"))
    );
    const vcr = playback({ allowNetworkHosts: ["live.test"] });
    const res = await vcr.outboundService(request("https://live.test/x"));
    expect(await res.text()).toBe("live");
  });
});

describe("recording", () => {
  const record = (): Vcr => createVcr({ snapshotsDir: dir, record: true });

  it("captures a live response and serves it back unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("live body", {
            status: 201,
            headers: { "content-type": "text/plain" }
          })
      )
    );
    const vcr = record();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    const res = await vcr.outboundService(request("https://api.test/thing"));

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("live body");
  });

  it("writes the cassette on release, with no teardown needed", async () => {
    // Deliberately no `close()`. Releasing is what each test does in its
    // `afterEach`, so a run that is interrupted afterwards must still keep the
    // cassettes of every test that finished — leaving them in memory until
    // global teardown loses all of them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("recorded"))
    );
    const recorder = record();
    await control(recorder, `/use?cassette=${CASSETTE}`);
    await recorder.outboundService(
      request("https://api.test/thing", { method: "POST", body: "payload" })
    );
    await control(recorder, "/release");

    const replay = playback();
    await control(replay, `/use?cassette=${CASSETTE}`);
    const res = await replay.outboundService(
      request("https://api.test/thing", { method: "POST", body: "payload" })
    );
    expect(await res.text()).toBe("recorded");
  });

  it("forwards the request body and method to the live call", async () => {
    const spy = liveFetch();
    vi.stubGlobal("fetch", spy);
    const vcr = record();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    await vcr.outboundService(
      request("https://api.test/thing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: '{"a":1}'
      })
    );

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.test/thing");
    expect(init.method).toBe("PUT");
    expect(Buffer.from(init.body!).toString()).toBe('{"a":1}');
  });

  it("sends the request bytes to the live call exactly as received", async () => {
    // The cassette stores request bodies as utf-8 text, which is what the
    // format has always held. Re-encoding that string back into bytes on the
    // way to a *real* endpoint would corrupt any payload that is not valid
    // utf-8 — 0xff and 0xfe are not, and would arrive as U+FFFD.
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const spy = liveFetch();
    vi.stubGlobal("fetch", spy);
    const vcr = record();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    await vcr.outboundService(
      request("https://api.test/thing", { method: "POST", body: binary })
    );

    expect(new Uint8Array(spy.mock.calls[0][1].body!)).toEqual(binary);
  });

  it("does not forward the headers that the outgoing call must recompute", async () => {
    // A stale `host` or `content-length` corrupts the live request;
    // `accept-encoding` is dropped so the body is stored as plaintext.
    const spy = liveFetch();
    vi.stubGlobal("fetch", spy);
    const vcr = record();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    await vcr.outboundService(
      request("https://api.test/thing", {
        headers: {
          host: "stale.example",
          "content-length": "999",
          "accept-encoding": "br, gzip",
          accept: "application/json"
        }
      })
    );

    const sent = new Map(spy.mock.calls[0][1].headers);
    expect([...sent.keys()]).toEqual(["accept"]);
  });

  it("ignores what is already on disk, so a recording is never half stale", async () => {
    // undici's `update` mode replayed anything already present and only called
    // out for new requests, which goes stale silently the moment recorded
    // traffic stops matching live behaviour.
    seed([
      { statusCode: 200, headers: {}, body: b64("from the old cassette") }
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("fresh"))
    );
    const vcr = record();
    await control(vcr, `/use?cassette=${CASSETTE}`);
    const res = await vcr.outboundService(request("https://api.test/thing"));

    expect(await res.text()).toBe("fresh");
    await control(vcr, "/release");
    await vcr.close();
    expect(readFileSync(path.join(dir, CASSETTE), "utf8")).not.toContain(
      "from the old cassette"
    );
  });

  it("keeps excluded headers out of the file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("ok", { headers: { "set-cookie": "s=secret-value" } })
      )
    );
    const vcr = createVcr({
      snapshotsDir: dir,
      record: true,
      excludeHeaders: ["x-api-key", "set-cookie"]
    });
    await control(vcr, `/use?cassette=${CASSETTE}`);
    await vcr.outboundService(
      request("https://api.test/thing", {
        headers: { "x-api-key": "secret-key" }
      })
    );
    await vcr.close();

    const written = readFileSync(path.join(dir, CASSETTE), "utf8");
    expect(written).not.toContain("secret-key");
    expect(written).not.toContain("secret-value");
  });
});
