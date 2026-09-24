/**
 * Cassette load / match / write. **Node realm** (`node:fs`, `node:crypto`), no
 * network and no `undici` — the recorder that drives this lives in `vcr.ts`.
 *
 * ## Why this replaced undici's `SnapshotAgent`
 *
 * `SnapshotAgent` keys every entry on a hash of method + URL + *every
 * non-excluded request header*. In a Worker test those headers are runtime
 * artifacts: a cassette recorded through the pool carries `user-agent: undici`,
 * `cf-worker: vitest-pool-workers-runner-.example.com`, `sec-fetch-mode` and
 * `accept-encoding`. Bump miniflare or workerd, any one of them changes, and
 * every entry in every committed cassette misses at once — a whole suite going
 * red with `No snapshot found` and nothing to point at.
 *
 * So the key here is **method + URL + request body**, and nothing else. Headers
 * are still stored (minus secrets, see {@link CassetteOptions.excludeHeaders})
 * because they are useful to read in a diff, but they cannot break a replay.
 *
 * The on-disk format owes `SnapshotAgent` nothing: a flat array of
 * {@link CassetteEntry}. Cassettes it wrote are not readable, and deliberately
 * so — its recorder keyed on `String(opts.body)`, and a Worker's POST body
 * reaches a dispatcher as a `ReadableStream`, so every streamed request it ever
 * captured stored the literal text `[object ReadableStream]` where the payload
 * belonged. Those bodies are not recoverable from the file, and a reader that
 * papered over it would have to match such entries on method + URL alone —
 * quietly reintroducing the ambiguity this store exists to remove. Re-record
 * instead.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A stored request. `body` is utf-8 text; binary request bodies are not supported. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: string;
}

/** A stored response. `body` is base64, so a binary payload survives the file. */
export interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  trailers?: Record<string, string>;
}

/**
 * One cassette entry: a request and every response recorded for it, in order.
 *
 * The array is what makes a replayed sequence work — two identical requests
 * that returned different things (a job's status polled twice, say) are one entry
 * with two responses, walked in order. See {@link Cassette.match}.
 */
export interface CassetteEntry {
  request: RecordedRequest;
  responses: RecordedResponse[];
}

/**
 * Headers that describe how a body was framed on the wire, which is not how it
 * is framed on replay: bodies are stored decoded and are handed back whole, so
 * replaying `transfer-encoding: chunked` or a stale `content-length` mis-frames
 * the response, and `content-encoding: gzip` makes the consumer try to inflate
 * plaintext. Stripped on the way out, kept in the file.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

/** What {@link Cassette.match} hands back: everything needed to build a Response. */
export interface ReplayableResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

export interface CassetteOptions {
  /** Request *and* response headers never written to the file (API keys, auth). */
  excludeHeaders?: string[];
}

/** `${METHOD}\n${url}\n${sha256(body)}` — the whole matching rule. */
export function requestKey(method: string, url: string, body: string): string {
  const digest = createHash("sha256").update(body, "utf8").digest("base64url");
  return `${method.toUpperCase()}\n${url}\n${digest}`;
}

function filterHeaders(
  headers: Record<string, string | string[]>,
  exclude: Set<string>
): Record<string, string | string[]> {
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!exclude.has(name.toLowerCase())) kept[name.toLowerCase()] = value;
  }
  return kept;
}

/**
 * Turn a stored response into the pieces a `Response` is built from: body
 * decoded from base64, headers flattened (a repeated header such as
 * `set-cookie` becomes one entry per value) and {@link HOP_BY_HOP} dropped.
 *
 * Used on both paths, so a response served straight after recording is framed
 * exactly as the same response will be on replay.
 */
export function replayable(response: RecordedResponse): ReplayableResponse {
  const headers: [string, string][] = [];
  for (const [name, value] of Object.entries(response.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      headers.push([name, one]);
    }
  }
  return {
    status: response.statusCode,
    headers,
    body: Buffer.from(response.body, "base64")
  };
}

/**
 * One cassette file, loaded lazily and written only when it has changed.
 *
 * Playback is **read-only**: nothing here mutates on a replay, which is what
 * stops a plain `npm test` from dirtying committed cassettes. The sequence
 * counter ({@link #calls}) is in memory and dies with the process, deliberately
 * — `SnapshotAgent` persisted its equivalent and re-saved on close, so every
 * run left every cassette modified in git.
 */
export class Cassette {
  readonly #file: string;
  readonly #exclude: Set<string>;
  /** Insertion-ordered, keyed by {@link requestKey}. */
  readonly #entries = new Map<string, CassetteEntry>();
  /** How many times each key has been replayed *this run*. Never persisted. */
  readonly #calls = new Map<string, number>();
  #dirty = false;

  constructor(file: string, options: CassetteOptions = {}) {
    this.#file = file;
    this.#exclude = new Set(
      (options.excludeHeaders ?? []).map((h) => h.toLowerCase())
    );
  }

  get file(): string {
    return this.#file;
  }

  /** Every request in the file, as `METHOD url`, for error messages. */
  get recorded(): string[] {
    return [...this.#entries.values()].map(
      (e) => `${e.request.method} ${e.request.url}`
    );
  }

  /**
   * Read the file into memory, keying each entry by its own request rather than
   * trusting anything stored alongside it.
   *
   * Two entries that key the same are a mistake rather than a merge: a request
   * that was issued twice belongs in one entry with two `responses`, which is
   * what {@link match} walks. Saying so here turns a hand-edit slip into a named
   * error instead of a replay that silently serves the wrong response second.
   */
  load(): void {
    if (!existsSync(this.#file)) return;
    const raw = JSON.parse(readFileSync(this.#file, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`VCR cassette ${this.#file} is not a JSON array`);
    }
    for (const entry of raw as CassetteEntry[]) {
      const { request, responses } = entry;
      const key = requestKey(request.method, request.url, request.body ?? "");
      if (this.#entries.has(key)) {
        throw new Error(
          `VCR cassette ${path.basename(this.#file)} has two entries for ` +
            `${request.method} ${request.url} with the same body. Put the ` +
            `responses in one entry's \`responses\` array instead.`
        );
      }
      this.#entries.set(key, { request, responses: [...responses] });
    }
  }

  /**
   * The next recorded response for this request, or `null` if it was never
   * recorded.
   *
   * Repeated identical requests walk `responses` in order and then **hold on
   * the last one**, so a recording that captured a single response replays it
   * for every call — which is what a poll loop needs when it runs a different
   * number of times on replay than it did while recording.
   */
  match(method: string, url: string, body: string): ReplayableResponse | null {
    const key = requestKey(method, url, body);
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const call = this.#calls.get(key) ?? 0;
    this.#calls.set(key, call + 1);
    return replayable(
      entry.responses[Math.min(call, entry.responses.length - 1)]
    );
  }

  /** Append a live response. Repeats of a request extend its `responses`. */
  record(request: RecordedRequest, response: RecordedResponse): void {
    const key = requestKey(request.method, request.url, request.body);
    const stored: RecordedResponse = {
      ...response,
      headers: filterHeaders(response.headers, this.#exclude)
    };
    const entry = this.#entries.get(key);
    if (entry) {
      entry.responses.push(stored);
    } else {
      this.#entries.set(key, {
        request: {
          ...request,
          headers: filterHeaders(request.headers, this.#exclude)
        },
        responses: [stored]
      });
    }
    this.#dirty = true;
  }

  /** Write if anything was recorded since the last flush. A no-op in playback. */
  flush(): void {
    if (!this.#dirty) return;
    mkdirSync(path.dirname(this.#file), { recursive: true });
    const entries = [...this.#entries.values()];
    writeFileSync(this.#file, `${JSON.stringify(entries, null, 2)}\n`);
    this.#dirty = false;
  }
}
