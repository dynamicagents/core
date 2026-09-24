import { beforeAll, describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import type { ArtifactsEnv } from "../env.js";
import type { Artifacts } from "./do.js";
import { ARTIFACTS_OBJECT_NAME, ArtifactsNotBoundError } from "./binding.js";
import { handleArtifactRoute } from "./route.js";

/**
 * The delegation a Worker's `fetch` makes.
 *
 * Driven directly rather than through `test/worker.ts`, because the answer that
 * matters most is `null` — the difference between a helper a router can sit in
 * front of and a mount that changes what that router answers — and a request
 * routed through a Worker can only show what the Worker did *instead*. The real
 * binding is passed, so a served route is still served end to end.
 */

// `wrangler types --include-env=false` leaves the ambient `Env` without the
// test worker's bindings, so they are reached by name — as the other DO specs
// reach theirs.
const ns = (env as unknown as Record<string, DurableObjectNamespace<Artifacts>>)
  .ARTIFACTS!;

/** The one object every artifact of a deployment lives in. */
const artifacts = () => ns.get(ns.idFromName(ARTIFACTS_OBJECT_NAME));

const serve = (url: string, init?: RequestInit) =>
  handleArtifactRoute(new Request(url, init), env as ArtifactsEnv);

/**
 * Warm the object before the clock starts on a test.
 *
 * The first call into a Durable Object in a spec file instantiates
 * `test/worker.ts` and its whole module graph inside that object's isolate,
 * which takes seconds; every call after it takes single-digit milliseconds.
 * Without this the bill lands on whichever test happens to be first, and that
 * test fails whenever this file runs on its own. `tokenFor` opens nothing, so
 * the warm-up leaves no artifact behind.
 */
beforeAll(async () => {
  await artifacts().tokenFor("warm-up", "warm-up");
}, 30_000);

describe("handleArtifactRoute", () => {
  it("serves the viewer for any token, without asking the object", async () => {
    // Any token: the page is the same bytes for every artifact and discovers
    // whether this one exists from the stream it opens. A round trip here would
    // buy nothing and cost every link one.
    const response = await serve(`https://agent.example/a/${"a".repeat(40)}`);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    const page = await response!.text();
    expect(page).toContain("EventSource");
    expect(page).toContain('id="log"');
  });

  it("serves the stream for an artifact that exists", async () => {
    const token = await artifacts().createArtifact("session-transcript");
    const response = await serve(`https://agent.example/a/${token}/events`);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain(
      "text/event-stream"
    );
    // Unsettled, so the body stays open; let it go rather than read to an end
    // that is not coming.
    await response?.body?.cancel();
  });

  it("is a 404 for a stream whose token names nothing", async () => {
    const response = await serve(
      `https://agent.example/a/${"b".repeat(40)}/events`
    );
    expect(response?.status).toBe(404);
  });

  it.each([
    [
      "a path outside the prefix",
      "https://agent.example/.well-known/jwks.json"
    ],
    [
      "a token that could not have been minted",
      "https://agent.example/a/short"
    ],
    [
      "a path under the prefix nothing serves",
      `https://agent.example/a/${"c".repeat(40)}/raw`
    ]
  ])("declines %s", async (_label, url) => {
    // `null`, not a 404 — sitting in front of a router must not change what
    // that router answers.
    expect(await serve(url)).toBeNull();
  });

  it("declines everything that is not a GET", async () => {
    // There is no ingest over HTTP: a write reaches the object through the
    // binding, inside the Worker, or not at all.
    const url = `https://agent.example/a/${"d".repeat(40)}`;
    expect(await serve(url, { method: "POST" })).toBeNull();
  });

  it.each([
    ["the page", `https://agent.example/a/${"e".repeat(40)}`],
    ["the stream", `https://agent.example/a/${"e".repeat(40)}/events`]
  ])("throws for %s when nothing is bound", async (_label, url) => {
    /**
     * The same answer for both, which is why the check runs before the routes
     * are told apart. The page is a string and would happily render, so the
     * other order gives a link that opens, waits on a stream that can only
     * 404, and reads as an artifact that expired — for a deployment whose
     * `wrangler.jsonc` is a line short.
     */
    const unbound = {} as unknown as ArtifactsEnv;
    await expect(
      handleArtifactRoute(new Request(url), unbound)
    ).rejects.toThrow(ArtifactsNotBoundError);
  });

  it("still declines a path it does not claim when nothing is bound", async () => {
    // The `null` contract outranks the check: a helper sitting in front of a
    // router must not start answering for paths that were never its business,
    // however badly the deployment is wired.
    const unbound = {} as unknown as ArtifactsEnv;
    const request = new Request("https://agent.example/.well-known/jwks.json");
    expect(await handleArtifactRoute(request, unbound)).toBeNull();
  });
});
