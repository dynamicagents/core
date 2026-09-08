/**
 * `@dynamicagents/core/testing/node` — the **Node-realm** half of the VCR harness.
 *
 * Separate from `@dynamicagents/core/testing` because the two halves cannot share a
 * module graph. This side reaches `node:fs`; the other side runs inside workerd,
 * which has no filesystem. `vcr-shared.ts` is the only thing both may touch, and
 * it is deliberately dependency-free so it can load in either realm.
 *
 * Import this from a Vitest **config** (or anything else running in Node), never
 * from a spec:
 *
 * ```ts
 * // vitest.config.ts
 * import { defineConfig } from "vitest/config";
 * import { cloudflareTest } from "@cloudflare/vitest-plugin";
 * import path from "node:path";
 * import { createVcr, recordFromEnv } from "@dynamicagents/core/testing/node";
 *
 * const vcr = createVcr({
 *   snapshotsDir: path.resolve(import.meta.dirname, "test/snapshots"),
 *   record: recordFromEnv(),
 *   // Why a committed cassette is safe, and why playback needs no credentials.
 *   excludeHeaders: ["x-api-key", "authorization", "cookie", "set-cookie"]
 * });
 *
 * export default defineConfig({
 *   plugins: [
 *     cloudflareTest({
 *       wrangler: { configPath: "./wrangler.jsonc" },
 *       miniflare: { outboundService: vcr.outboundService }
 *     })
 *   ],
 *   test: { globalSetup: ["@dynamicagents/core/testing/vcr-global-setup"] }
 * });
 * ```
 *
 * `RECORD=1` captures live traffic into every cassette a run activates; anything
 * else replays. A host with no active cassette is **blocked**, so a test that
 * was never wired for recording cannot reach the network by accident.
 *
 * ## Version constraints: there are none
 *
 * This used to carry two, both of which failed unreadably, and both of which
 * were consequences of installing the recorder as Miniflare's `fetchMock`:
 * the pool had to be `^0.18` (Miniflare 5 dropped the option, and pool 0.20
 * removed it from its overrides), and your `undici` had to be byte-identical to
 * Miniflare's (`fetchMock` was validated with `instanceof MockAgent`).
 *
 * The recorder is now a plain `outboundService` function — the hook `fetchMock`
 * was sugar over in the first place. It is present and identical in Miniflare 4
 * and 5, it type-checks against both, and it involves no `undici` at all. Core
 * declares no `undici` peer and the pool peer is open.
 */

export {
  createVcr,
  recordFromEnv,
  closeVcr,
  type Vcr,
  type VcrOptions,
  type VcrRequest,
  type VcrRequestHeaders,
  type VcrOutboundService
} from "./vcr.js";

export {
  Cassette,
  requestKey,
  replayable,
  type CassetteEntry,
  type CassetteOptions,
  type RecordedRequest,
  type RecordedResponse,
  type ReplayableResponse
} from "./vcr-store.js";

export {
  VCR_CONTROL_ORIGIN,
  VCR_MARKER_HEADER,
  CASSETTE_NAME_RE,
  type VcrReleaseResult
} from "./vcr-shared.js";
