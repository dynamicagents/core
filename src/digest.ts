/**
 * A content digest, for naming a thing by what it holds.
 *
 * Here for the reason {@link file://./tool-output.ts truncateOutput} is: a plugin
 * cannot import from a sibling plugin, so the alternative is a copy per caller.
 */

/**
 * SHA-256 of `text`, lower-case hex.
 *
 * Hex rather than base64 because every consumer so far puts it in an idempotency
 * key or a filename, and both want a safe alphabet more than they want the four
 * characters base64 saves.
 *
 * A caller that only needs to tell a handful of values apart truncates the
 * result; it is a digest, not a commitment, and nothing here resists a preimage
 * attack on a shortened one.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
