/**
 * The two URLs an artifact has, and the one parser both sides read them with.
 *
 * Dependency-free on purpose: the Worker edge matches these paths before it has
 * a binding in hand ({@link file://./route.ts handleArtifactRoute}), the Durable
 * Object matches the same pathname again when the request reaches it
 * ({@link file://./do.ts Artifacts}), and the emission helpers build the link a
 * thread is given ({@link file://./transcript.ts transcribeNote}). Three
 * readers, one grammar.
 */

/** Path prefix every artifact URL sits under. */
export const ARTIFACT_PATH_PREFIX = "/a/";

/**
 * What a token is allowed to look like, applied at the edge before anything is
 * addressed by it.
 *
 * A token is the read secret and nothing else routes on it, so the grammar can
 * be as narrow as the minter makes it — see
 * {@link file://./store.ts mintArtifactToken}. Narrow is the point: a pathname
 * segment reaches `idFromName` unaltered, and refusing everything that is not
 * what this package mints means no request can address an object on a name it
 * chose.
 */
const TOKEN = /^[0-9A-Za-z]{32,128}$/;

/** A matched artifact URL: the viewer page, or the event stream behind it. */
export interface ArtifactRoute {
  token: string;
  /** `page` is the viewer; `events` is its SSE stream. */
  route: "page" | "events";
}

/**
 * Match `/a/<token>` and `/a/<token>/events`, or `null` for anything else —
 * including a well-formed path carrying a token this package could not have
 * minted.
 */
export function parseArtifactPath(pathname: string): ArtifactRoute | null {
  if (!pathname.startsWith(ARTIFACT_PATH_PREFIX)) return null;
  const rest = pathname.slice(ARTIFACT_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  const token = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash);
  if (!TOKEN.test(token)) return null;
  if (tail === "" || tail === "/") return { token, route: "page" };
  if (tail === "/events") return { token, route: "events" };
  return null;
}

/** The shareable link for one artifact, on the origin serving its route. */
export function artifactViewerUrl(origin: string, token: string): string {
  return `${origin}${ARTIFACT_PATH_PREFIX}${token}`;
}
