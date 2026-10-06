/**
 * The URLs an artifact has, and the one parser every side reads them with.
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

/**
 * What an entry's bytes URL ends in: its sequence, and an extension that is
 * matched and then **ignored**.
 *
 * Digits only, so it cannot be read as `/events`, and no leading zero, so the
 * sequence has one spelling: `1`, never `01` or `001`. The extension is a second
 * spelling of the same entry — `1`, `1.png` and `1.jpg` all address it — so what
 * the leading-zero rule buys is a canonical decimal form the builder here emits
 * and a cache keyed on it keeps once, not a single URL per entry. Nine digits at
 * most, because a path segment that reaches `Number` deserves a bound, and `0`
 * is not a sequence this store mints. The extension exists because a URL that
 * looks like an image costs nothing and a consumer's existing ones end in one;
 * it carries no authority, since `nosniff` plus a signature-checked type leaves
 * the served `Content-Type` the only thing a browser may act on.
 */
const SEQUENCE = /^([1-9]\d{0,8})(?:\.[A-Za-z0-9]{1,8})?$/;

/** A matched artifact URL: the viewer page, its stream, or an entry's bytes. */
export type ArtifactRoute =
  | { token: string; route: "page" }
  | { token: string; route: "events" }
  | { token: string; route: "bytes"; sequence: number };

/**
 * Match `/a/<token>`, `/a/<token>/events` and `/a/<token>/<sequence>`, or `null`
 * for anything else — including a well-formed path carrying a token this package
 * could not have minted.
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
  const sequence = SEQUENCE.exec(tail.slice(1));
  if (sequence !== null) {
    return { token, route: "bytes", sequence: Number(sequence[1]) };
  }
  return null;
}

/** The shareable link for one artifact, on the origin serving its route. */
export function artifactViewerUrl(origin: string, token: string): string {
  return `${origin}${ARTIFACT_PATH_PREFIX}${token}`;
}

/**
 * The URL one entry's bytes are served from, on the origin serving its route.
 *
 * `extension` is cosmetic and the parser ignores it — pass what
 * `artifactMediaExtension` in `media.ts` answers for the entry's type to make a
 * URL that looks like the image behind it.
 */
export function artifactEntryUrl(
  origin: string,
  token: string,
  sequence: number,
  extension?: string
): string {
  const suffix = extension === undefined ? "" : `.${extension}`;
  return `${origin}${ARTIFACT_PATH_PREFIX}${token}/${sequence}${suffix}`;
}
