import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { createVcr, recordFromEnv } from "./src/testing/node.js";

/**
 * Two projects, because the harness has two realms and both need covering.
 *
 * **`workers`** — almost everything. Specs run inside workerd, not Node: that is
 * not a preference, `AgentDB` drives `ctx.storage.sql` and the Agents SDK's
 * `Session` has no Node-side stand-in. The pool boots the real runtime with the
 * Durable Objects declared in `wrangler.jsonc`, and `test/worker.ts` is the host
 * that owns them.
 *
 * **`node`** — `*.node.spec.ts`, the Node-realm half of the VCR harness (the
 * cassette store reaches `node:fs`, which workerd does not have). Before this
 * split there was nowhere for those specs to live, so the store had no direct
 * coverage at all.
 *
 * Core also record/replays its own harness. That is the point: this package
 * publishes the VCR system, and it shipped broken once — wired to a Miniflare
 * option the pool had removed — precisely because core had no recorded spec of
 * its own to notice. `src/testing/vcr.spec.ts` now exercises the whole path,
 * against a committed cassette, on every `npm test`.
 */
const vcr = createVcr({
  snapshotsDir: path.resolve(import.meta.dirname, "test/snapshots"),
  record: recordFromEnv(),
  // What makes a cassette safe to commit, and why playback needs no credentials.
  excludeHeaders: ["authorization", "x-api-key", "cookie", "set-cookie"]
});

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            // `main` and every binding come from the one wrangler config, so the
            // test host and a real deploy can never drift apart.
            wrangler: { configPath: "./wrangler.jsonc" },
            // The recorder, on the hook Miniflare 4 and 5 both have. `fetchMock`
            // is not it — pool 0.20 removed the option, and an unknown key here
            // is ignored rather than rejected, which is how the previous wiring
            // failed silently. Every outbound fetch with no active cassette is
            // blocked, so a spec cannot reach the network by accident either.
            miniflare: { outboundService: vcr.outboundService }
          })
        ],
        test: {
          name: "workers",
          include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            // The Node realm — see the `node` project below.
            "**/*.node.spec.ts"
          ],
          // Node realm. Last chance to flush a cassette; each one is already
          // written when its test releases it, so this is only a safety net.
          globalSetup: ["./src/testing/vcr-global-setup.ts"]
        }
      },
      {
        test: {
          name: "node",
          include: ["src/**/*.node.spec.ts"]
        }
      }
    ]
  }
});
