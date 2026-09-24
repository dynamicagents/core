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
 * they carry no tenant, and they answer a browser rather than an agent. Sitting
 * in front as one line keeps that separation visible.
 */

import { artifactsStub } from "./binding.js";
import { parseArtifactPath } from "./path.js";
import { artifactViewerResponse } from "./viewer.js";

/**
 * Serve `/a/<token>` and `/a/<token>/events`, or `null` for anything else —
 * including a path under the prefix carrying something that is not a token.
 *
 * `null`, not a 404: a path this does not claim belongs to whatever the Worker
 * would have done with it, and answering for it would make mounting this an
 * act with consequences elsewhere.
 *
 * Without the binding every artifact URL is a 404, which is the honest answer:
 * the deployment stores none.
 */
export async function handleArtifactRoute(
  request: Request,
  env: object
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const matched = parseArtifactPath(new URL(request.url).pathname);
  if (matched === null) return null;

  // The page is the same bytes for every artifact and knows its own token from
  // the URL, so it is served without consulting the object at all — a link
  // opened for a swept or mistyped token renders and then says so, rather than
  // costing a round trip to decide between two responses.
  if (matched.route === "page") return artifactViewerResponse();

  const stub = artifactsStub(env);
  if (!stub) return new Response("not found", { status: 404 });
  return stub.fetch(request);
}
