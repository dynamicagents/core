/**
 * Node-realm spec (`*.node.spec.ts` — see `vitest.config.ts`): the cassette store
 * touches `node:fs` and never `cloudflare:test`, so it runs outside workerd.
 *
 * The properties pinned here are the ones that decide whether a committed
 * cassette survives a runtime upgrade, which is the defect that made the old
 * harness a blocker on bumping `@cloudflare/vitest-pool-workers`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cassette, requestKey } from "./vcr-store.js";

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const text = (r: { body: Uint8Array }): string =>
  Buffer.from(r.body).toString("utf8");

/** A cassette entry: one request and the responses recorded for it. */
function entry(
  request: Partial<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }>,
  bodies: string[]
) {
  return {
    request: {
      method: "GET",
      url: "https://api.test/thing",
      headers: {},
      body: "",
      ...request
    },
    responses: bodies.map((body) => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: b64(body)
    }))
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vcr-store-"));
  file = path.join(dir, "spec.snapshot.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (entries: unknown[]): void =>
  writeFileSync(file, JSON.stringify(entries, null, 2));

describe("Cassette.load", () => {
  it("matches regardless of the request headers the recording carried", () => {
    // The whole reason this store exists. undici's SnapshotAgent hashed every
    // non-excluded header, so a cassette recorded through one pool version
    // stopped matching under the next — `cf-worker` and `user-agent` sufficed.
    write([
      entry(
        {
          headers: {
            "user-agent": "undici",
            "cf-worker": "vitest-pool-workers-runner-.example.com",
            "sec-fetch-mode": "cors"
          }
        },
        ["survives"]
      )
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    // Nothing about the caller's headers is passed to `match` at all.
    expect(text(cassette.match("GET", "https://api.test/thing", "")!)).toBe(
      "survives"
    );
  });

  it("rejects two entries that key the same instead of merging them", () => {
    // Headers are not part of the key, so these two collide. A request issued
    // twice belongs in one entry with two `responses` — merging them silently
    // would mean a hand-edit slip replays the wrong response on the second call
    // and nothing says so.
    write([
      entry({ headers: { "user-agent": "a" } }, ["first"]),
      entry({ headers: { "user-agent": "b" } }, ["second"])
    ]);
    const cassette = new Cassette(file);

    expect(() => cassette.load()).toThrow(/two entries for GET/);
  });

  it("keeps requests apart by body", () => {
    write([
      entry({ method: "POST", body: '{"a":1}' }, ["one"]),
      entry({ method: "POST", body: '{"a":2}' }, ["two"])
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(
      text(cassette.match("POST", "https://api.test/thing", '{"a":2}')!)
    ).toBe("two");
    expect(
      text(cassette.match("POST", "https://api.test/thing", '{"a":1}')!)
    ).toBe("one");
  });

  it("returns null for a request that was never recorded", () => {
    write([entry({}, ["hello"])]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(cassette.match("GET", "https://api.test/other", "")).toBeNull();
    expect(cassette.match("POST", "https://api.test/thing", "")).toBeNull();
  });

  it("is empty, not an error, when the file does not exist", () => {
    const cassette = new Cassette(path.join(dir, "absent.snapshot.json"));
    cassette.load();
    expect(cassette.match("GET", "https://api.test/thing", "")).toBeNull();
    expect(cassette.recorded).toEqual([]);
  });
});

describe("Cassette.match", () => {
  it("walks sequential responses, then holds the last one", () => {
    // A poll loop issues the same request repeatedly and must see the recorded
    // progression; once it runs out, repeating the final response is what lets
    // a one-response recording serve a loop that runs a different number of
    // times on replay than it did while recording.
    write([entry({}, ["frame-1", "frame-2"])]);
    const cassette = new Cassette(file);
    cassette.load();

    const bodies = Array.from({ length: 4 }, () =>
      text(cassette.match("GET", "https://api.test/thing", "")!)
    );
    expect(bodies).toEqual(["frame-1", "frame-2", "frame-2", "frame-2"]);
  });

  it("strips the headers that describe wire framing", () => {
    // Bodies are stored decoded and handed back whole. Replaying
    // `transfer-encoding: chunked` mis-frames the response and
    // `content-encoding: gzip` makes the consumer try to inflate plaintext —
    // and a real API's recorded responses commonly carry both.
    write([
      {
        request: {
          method: "GET",
          url: "https://api.test/thing",
          headers: {},
          body: ""
        },
        responses: [
          {
            statusCode: 200,
            headers: {
              "content-type": "application/json",
              "transfer-encoding": "chunked",
              connection: "keep-alive",
              "content-encoding": "gzip",
              "content-length": "999"
            },
            body: b64("{}")
          }
        ]
      }
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    const names = cassette
      .match("GET", "https://api.test/thing", "")!
      .headers.map(([name]) => name);
    expect(names).toEqual(["content-type"]);
  });

  it("expands a repeated response header into one entry per value", () => {
    write([
      {
        request: {
          method: "GET",
          url: "https://api.test/thing",
          headers: {},
          body: ""
        },
        responses: [
          {
            statusCode: 200,
            headers: { "set-cookie": ["a=1", "b=2"] },
            body: b64("{}")
          }
        ]
      }
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(
      cassette.match("GET", "https://api.test/thing", "")!.headers
    ).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"]
    ]);
  });
});

describe("Cassette.flush", () => {
  const request = {
    method: "POST",
    url: "https://api.test/thing",
    headers: { "x-api-key": "super-secret", accept: "application/json" },
    body: '{"a":1}'
  };
  const response = {
    statusCode: 200,
    headers: {
      "set-cookie": "session=super-secret",
      "content-type": "text/plain"
    },
    body: b64("ok")
  };

  it("writes nothing on a pure playback run", () => {
    // The failure this pins: SnapshotAgent re-saved unconditionally on close,
    // writing back the callCount it mutated on every replay, so a plain
    // `npm test` left every committed cassette modified in git.
    write([entry({}, ["hello"])]);
    const before = readFileSync(file, "utf8");

    const cassette = new Cassette(file);
    cassette.load();
    cassette.match("GET", "https://api.test/thing", "");
    cassette.match("GET", "https://api.test/thing", "");
    cassette.flush();

    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps excluded headers out of the file, on both sides", () => {
    // This is what makes a cassette safe to commit, and why playback needs no
    // credentials at all.
    const cassette = new Cassette(file, {
      excludeHeaders: ["x-api-key", "set-cookie"]
    });
    cassette.record(request, response);
    cassette.flush();

    const written = readFileSync(file, "utf8");
    expect(written).not.toContain("super-secret");
    expect(written).toContain("accept");
    expect(written).toContain("content-type");
  });

  it("appends a repeat of the same request as a second response", () => {
    const cassette = new Cassette(file);
    cassette.record(request, response);
    cassette.record(request, { ...response, body: b64("again") });
    cassette.flush();

    const replayed = new Cassette(file);
    replayed.load();
    expect(text(replayed.match("POST", request.url, request.body)!)).toBe("ok");
    expect(text(replayed.match("POST", request.url, request.body)!)).toBe(
      "again"
    );
  });

  it("writes a flat entry and nothing else", () => {
    // No wrapper, no `hash` (the key is derived), no `callCount`/`timestamp`
    // (neither is needed to replay, and both churned the file on every run).
    // The format owes undici's SnapshotAgent nothing.
    const cassette = new Cassette(file);
    cassette.record(request, response);
    cassette.flush();

    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >[];
    expect(Object.keys(parsed[0])).toEqual(["request", "responses"]);
  });
});

describe("requestKey", () => {
  it("is insensitive to method case and nothing else", () => {
    const key = requestKey("get", "https://api.test/x", "");
    expect(requestKey("GET", "https://api.test/x", "")).toBe(key);
    expect(requestKey("GET", "https://api.test/y", "")).not.toBe(key);
    expect(requestKey("POST", "https://api.test/x", "")).not.toBe(key);
    expect(requestKey("GET", "https://api.test/x", "body")).not.toBe(key);
    // The whole URL, not its path. A key derived from origin + pathname satisfies
    // every assertion above and still collides `?page=1` with `?page=2`, which
    // replays the wrong response.
    expect(requestKey("GET", "https://api.test/x?a=1", "")).not.toBe(
      requestKey("GET", "https://api.test/x?a=2", "")
    );
  });
});
