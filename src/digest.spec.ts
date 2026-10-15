import { describe, it, expect } from "vitest";
import { sha256Hex } from "./digest.js";

describe("sha256Hex", () => {
  it("answers the published digest for the empty string", () => {
    // The one value worth pinning literally: it is in the FIPS test vectors, so
    // a wrong encoding — base64, byte order, a missing pad — fails here rather
    // than at a consumer comparing two of its own digests and agreeing with
    // itself.
    return expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("is lower-case hex, two characters per byte", async () => {
    const digest = await sha256Hex("anything");

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates inputs that differ by one character", async () => {
    expect(await sha256Hex("a")).not.toBe(await sha256Hex("b"));
  });

  it("is stable across calls, which is what an idempotency key needs", async () => {
    expect(await sha256Hex("same")).toBe(await sha256Hex("same"));
  });
});
