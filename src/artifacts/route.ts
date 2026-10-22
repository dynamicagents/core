/**
 * The two artifact routes, as one delegation a Worker's `fetch` can make.
 *
 * ```ts
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
 *   }
 * };
 * ```
 *
 * It is a helper rather than a mount because an agent Worker already has a
 * router — {@link file://../worker/index.ts createA2AWorker} — and these two
 * paths have nothing to do with A2A: they are not gatekeeper-authenticated,
 * they carry no tenant, and they answer whoever holds the link rather than a
 * gatekeeper. Sitting in front as one line keeps that separation visible.
 */

import type { ArtifactsEnv } from "../env.js";
import { requireArtifactsStub } from "./binding.js";
import { parseArtifactPath } from "./path.js";
import { artifactMarkdownResponse, wantsHtml } from "./text.js";
import { artifactViewerResponse } from "./viewer.js";

/**
 * Serve `/a/<token>` and `/a/<token>/events`, or `null` for anything else —
 * including a path under the prefix carrying something that is not a token.
 *
 * `null`, not a 404: a path this does not claim belongs to whatever the Worker
 * would have done with it, and answering for it would make mounting this an
 * act with consequences elsewhere.
 *
 * **One link, two representations.** `/a/<token>` answers the viewer page to a
 * client that asked for HTML and the artifact as markdown to one that did not,
 * so the same URL serves a person and an agent. Which is which, and why HTML is
 * the opt-in rather than the default, is in
 * {@link file://./text.ts wantsHtml}.
 *
 * Throws {@link file://./binding.ts ArtifactsNotBoundError} without the
 * binding, and **before deciding which of the two routes this is**, so a
 * deployment that mounted the helper and wired nothing answers 500 for both.
 * The other order is worse than it looks: the page renders from a string, so it
 * would answer 200 over a stream that can only ever 404 — a link that opens,
 * says nothing, and blames the artifact for a missing line of `wrangler.jsonc`.
 */
export async function handleArtifactRoute(
  request: Request,
  env: ArtifactsEnv
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const matched = parseArtifactPath(new URL(request.url).pathname);
  if (matched === null) return null;

  const stub = requireArtifactsStub(env);

  if (matched.route === "page") {
    // The page is the same bytes for every artifact and knows its own token
    // from the URL, so it is served without consulting the object at all — a
    // link opened for a swept or mistyped token renders and then says so,
    // rather than costing a round trip to decide between two responses.
    if (wantsHtml(request.headers.get("accept"))) {
      return artifactViewerResponse();
    }
    // The text reader pays that round trip, because it has nothing that could
    // discover the artifact afterwards: the page learns what it holds from the
    // stream it opens, and this answer is the whole of what its reader gets.
    return artifactMarkdownResponse(await stub.readArtifact(matched.token));
  }

  return stub.fetch(request);
}
