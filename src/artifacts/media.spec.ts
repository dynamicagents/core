import { describe, it, expect } from "vitest";
import {
  ARTIFACT_MEDIA_TYPES,
  ArtifactMediaTooLargeError,
  ArtifactMediaTypeError,
  artifactMediaExtension,
  artifactMediaType,
  MAX_ARTIFACT_MEDIA_BYTES,
  normalizeMediaBytes
} from "./media.js";

/**
 * The rules a bytes URL rests on.
 *
 * What is worth pinning is the *refusals*: the served `Content-Type` is only as
 * trustworthy as the signature check behind it, so every case here is a payload
 * that lies about itself in one of the ways a caller might.
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);
const HTML = new TextEncoder().encode("<!doctype html><html></html>");

describe("artifactMediaType", () => {
  it("names the type the bytes are, from either shape of buffer", () => {
    expect(artifactMediaType(PNG)).toBe("image/png");
    expect(artifactMediaType(JPEG)).toBe("image/jpeg");
    expect(artifactMediaType(normalizeMediaBytes(PNG))).toBe("image/png");
  });

  it.each([
    ["a signature cut short", PNG.subarray(0, 7)],
    ["a near miss on JPEG", new Uint8Array([0xff, 0xd8, 0x00, 0x00])],
    ["SVG, which is refused rather than sanitized", SVG],
    ["HTML", HTML],
    ["nothing at all", new Uint8Array()]
  ])("refuses %s", (_label, bytes) => {
    expect(artifactMediaType(bytes)).toBeNull();
  });

  it("has a signature to match for every type it accepts", () => {
    // An empty signature would admit every payload under that type, which is
    // the one way a new row here could undo the check the table exists for.
    for (const format of Object.values(ARTIFACT_MEDIA_TYPES)) {
      expect(format.signature.length).toBeGreaterThan(0);
    }
  });
});

describe("artifactMediaExtension", () => {
  it("answers an accepted type, and nothing for anything else", () => {
    expect(artifactMediaExtension("image/png")).toBe("png");
    expect(artifactMediaExtension("image/jpeg")).toBe("jpg");
    expect(artifactMediaExtension("image/svg+xml")).toBeUndefined();
  });
});

describe("normalizeMediaBytes", () => {
  it("stores a view's own bytes, never the buffer behind it", () => {
    const backing = new Uint8Array([0x99, 0x99, ...PNG, 0x99]);
    const view = backing.subarray(2, 2 + PNG.byteLength);

    const stored = normalizeMediaBytes(view);
    expect(stored.byteLength).toBe(PNG.byteLength);
    expect(new Uint8Array(stored)).toEqual(PNG);
  });

  it("passes through what is already exactly the bytes", () => {
    const whole = new Uint8Array(PNG);
    expect(normalizeMediaBytes(whole)).toBe(whole.buffer);
    const buffer = whole.buffer;
    expect(normalizeMediaBytes(buffer)).toBe(buffer);
  });
});

describe("the refusals", () => {
  it("names the allowlist for a type nothing accepts, and says why not SVG", () => {
    const error = new ArtifactMediaTypeError("image/svg+xml", null);
    expect(error.name).toBe("ArtifactMediaTypeError");
    expect(error.message).toContain("image/png");
    expect(error.message).toContain("image/jpeg");
    expect(error.message).toContain("sanitized");
  });

  it("says what the bytes are when they contradict an accepted type", () => {
    const error = new ArtifactMediaTypeError("image/png", "image/jpeg");
    expect(error.message).toContain("declared image/png");
    expect(error.message).toContain("image/jpeg");
  });

  it("names the limit it broke", () => {
    const error = new ArtifactMediaTooLargeError(MAX_ARTIFACT_MEDIA_BYTES + 1);
    expect(error.name).toBe("ArtifactMediaTooLargeError");
    expect(error.message).toContain(String(MAX_ARTIFACT_MEDIA_BYTES + 1));
    expect(error.message).toContain(String(MAX_ARTIFACT_MEDIA_BYTES));
  });
});
