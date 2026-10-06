/**
 * What an entry may carry besides its text, and the rules that keep it safe to
 * serve.
 *
 * ## The type is checked against the bytes, not taken on the caller's word
 *
 * A caller declares a media type and it is refused unless the bytes start with
 * that type's signature. So the `Content-Type`
 * {@link file://./do.ts Artifacts} serves is provably the shape of the bytes
 * behind it, and a caller cannot smuggle a document behind `image/png`.
 *
 * ## Images only, and never SVG
 *
 * {@link ARTIFACT_MEDIA_TYPES} is the whole allowlist. SVG is **refused rather
 * than sanitized**: a bytes URL invites direct navigation, and an SVG opened
 * that way runs script on the origin that also serves the agent's A2A endpoint
 * and its card JWKS. Inside an `<img>` it would be inert — direct navigation is
 * the hole. The alternative is an XML sanitizer owned forever by a package
 * whose own rule is to import nothing, so the refusal is the design rather than
 * a gap in it.
 */

/**
 * The accepted types: what a file of each starts with, and what a URL ending in
 * one is spelled with.
 *
 * A format is a row here and nothing else — the signature is what admits it and
 * the extension is cosmetic. Both are properties of the format, so neither is a
 * number anybody tunes.
 */
export const ARTIFACT_MEDIA_TYPES: Readonly<
  Record<
    string,
    { readonly signature: readonly number[]; readonly extension: string }
  >
> = {
  "image/png": {
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    extension: "png"
  },
  "image/jpeg": { signature: [0xff, 0xd8, 0xff], extension: "jpg" }
};

/**
 * The most one entry's media may weigh.
 *
 * Under half the 2 MB Cloudflare documents as a SQLite row's limit, so the row
 * the bytes land in keeps headroom; an order of magnitude above the 512×512
 * JPEG an avatar is. It is one `addEntry` call's worth, because an entry is
 * immutable once written and there is no chunked append — a payload that does
 * not fit is one the caller re-encodes.
 */
export const MAX_ARTIFACT_MEDIA_BYTES = 1024 * 1024;

/**
 * The type `data` actually is, or `null` for a shape nothing here accepts.
 *
 * Exported because the throw is a backstop rather than the interface: an error
 * loses its class crossing Durable Object RPC, so a caller that would rather
 * branch than catch asks this and {@link MAX_ARTIFACT_MEDIA_BYTES} first.
 */
export function artifactMediaType(
  data: ArrayBuffer | Uint8Array
): string | null {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  for (const [type, format] of Object.entries(ARTIFACT_MEDIA_TYPES)) {
    if (format.signature.every((byte, at) => bytes[at] === byte)) return type;
  }
  return null;
}

/** The extension an accepted type's URL may end in, or `undefined`. */
export function artifactMediaExtension(type: string): string | undefined {
  return ARTIFACT_MEDIA_TYPES[type]?.extension;
}

/**
 * The bytes to store, as a buffer holding nothing but them.
 *
 * `subarray` into a larger buffer is the ordinary way a producer slices bytes,
 * and binding the view would store the backing buffer — every neighbouring byte
 * with it, served under this entry's type. A view over a whole buffer is passed
 * through; anything else is copied.
 */
export function normalizeMediaBytes(
  data: ArrayBuffer | Uint8Array
): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const { buffer, byteOffset, byteLength } = data;
  if (
    buffer instanceof ArrayBuffer &&
    byteOffset === 0 &&
    byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  const copy = new Uint8Array(byteLength);
  copy.set(data);
  return copy.buffer;
}

/**
 * Thrown for a type nothing here accepts, and for one the bytes contradict.
 *
 * One class for both, because a caller branches before the call rather than on
 * what it catches — see {@link artifactMediaType}. What the message owes is the
 * rule, since that is all the throw site has left to say by the time it reaches
 * somebody.
 */
export class ArtifactMediaTypeError extends Error {
  constructor(declared: string, detected: string | null) {
    const accepted = Object.keys(ARTIFACT_MEDIA_TYPES).join(", ");
    super(
      // The declared type is caller-controlled, so the lookup is by *own*
      // property. `in` reaches `Object.prototype`, and every inherited name —
      // `toString`, `constructor`, `__proto__` — comes back true, so a caller
      // declaring one of those would be told its bytes contradict a type that
      // is not on the allowlist at all, instead of being told the allowlist.
      // The same rule, for the same reason, as `tenantAgent` in
      // {@link file://../worker/index.ts createA2AWorker}.
      Object.hasOwn(ARTIFACT_MEDIA_TYPES, declared)
        ? `artifact media declared ${declared} does not start with that type's ` +
            `signature — the bytes are ${detected ?? "no accepted type"}. The ` +
            "type a bytes URL is served under is checked against the bytes, so " +
            "declare what they are."
        : `${declared} is not an artifact media type. Artifacts accept ` +
            `${accepted}. SVG is refused rather than sanitized, because a bytes ` +
            "URL can be opened directly and an SVG served from this origin runs " +
            "script on the origin that serves the agent's A2A endpoint."
    );
    this.name = "ArtifactMediaTypeError";
  }
}

/** Thrown past {@link MAX_ARTIFACT_MEDIA_BYTES}, naming the limit it broke. */
export class ArtifactMediaTooLargeError extends Error {
  constructor(byteLength: number) {
    super(
      `artifact media is ${byteLength} bytes, past the limit of ` +
        `${MAX_ARTIFACT_MEDIA_BYTES}. An entry is written in one call and never ` +
        "appended to, so a payload this size is one to re-encode rather than split."
    );
    this.name = "ArtifactMediaTooLargeError";
  }
}
