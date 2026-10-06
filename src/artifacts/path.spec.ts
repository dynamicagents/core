import { describe, it, expect } from "vitest";
import { artifactMediaExtension } from "./media.js";
import {
  artifactEntryUrl,
  artifactViewerUrl,
  parseArtifactPath
} from "./path.js";
import { mintArtifactToken } from "./store.js";

/**
 * The grammar three readers share.
 *
 * What is worth pinning is the *refusals*. A pathname segment reaches
 * `idFromName` unaltered, so everything this parser declines is a name nothing
 * in the deployment can be addressed by — and the shape of a token is the whole
 * of that guard.
 */

const TOKEN = mintArtifactToken();

describe("parseArtifactPath", () => {
  it("matches the page and the stream behind it", () => {
    expect(parseArtifactPath(`/a/${TOKEN}`)).toEqual({
      token: TOKEN,
      route: "page"
    });
    expect(parseArtifactPath(`/a/${TOKEN}/`)).toEqual({
      token: TOKEN,
      route: "page"
    });
    expect(parseArtifactPath(`/a/${TOKEN}/events`)).toEqual({
      token: TOKEN,
      route: "events"
    });
  });

  it("matches an entry's bytes, with or without an extension", () => {
    expect(parseArtifactPath(`/a/${TOKEN}/1`)).toEqual({
      token: TOKEN,
      route: "bytes",
      sequence: 1
    });
    // Matched and ignored: the served `Content-Type` is the only authority.
    expect(parseArtifactPath(`/a/${TOKEN}/42.jpg`)).toEqual({
      token: TOKEN,
      route: "bytes",
      sequence: 42
    });
    expect(parseArtifactPath(`/a/${TOKEN}/999999999`)).toEqual({
      token: TOKEN,
      route: "bytes",
      sequence: 999999999
    });
  });

  it.each([
    ["another path entirely", "/.well-known/agent-card.json"],
    ["the prefix alone", "/a/"],
    ["a token too short to be one", "/a/abc123"],
    ["a token carrying punctuation", `/a/${TOKEN.slice(0, 39)}-`],
    ["a traversal attempt", "/a/../../etc/passwd"],
    ["a path segment nothing serves", `/a/${TOKEN}/raw`],
    ["a deeper path", `/a/${TOKEN}/events/extra`],
    ["a sequence no store mints", `/a/${TOKEN}/0`],
    // One decimal spelling per sequence, which is the form `artifactEntryUrl`
    // emits — `01` would be a second key for the same bytes in every cache.
    ["a sequence with a leading zero", `/a/${TOKEN}/01`],
    ["a sequence past the bound", `/a/${TOKEN}/1234567890`],
    ["a sequence with a path after it", `/a/${TOKEN}/1/extra`],
    ["an extension with no sequence", `/a/${TOKEN}/.jpg`],
    ["a sequence that is not a number", `/a/${TOKEN}/latest`]
  ])("declines %s", (_label, pathname) => {
    expect(parseArtifactPath(pathname)).toBeNull();
  });
});

describe("mintArtifactToken", () => {
  it("is alphanumeric, long, and never twice the same", () => {
    const minted = Array.from({ length: 64 }, () => mintArtifactToken());
    for (const token of minted) {
      expect(token).toMatch(/^[0-9A-Za-z]{40}$/);
      // The route has to accept what the minter produces, or a link is dead on
      // arrival — the one coupling between these two modules.
      expect(parseArtifactPath(`/a/${token}`)?.token).toBe(token);
    }
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("uses the whole alphabet rather than the first bytes of it", () => {
    // Rejection sampling is invisible in a single token and obvious in a
    // thousand: folding a byte with `% 62` instead would leave the tail of the
    // alphabet underrepresented by a fifth.
    const seen = new Set(
      Array.from({ length: 200 }, () => mintArtifactToken()).join("")
    );
    expect(seen.size).toBe(62);
  });
});

describe("artifactViewerUrl", () => {
  it("is the origin and the path the route matches", () => {
    const url = artifactViewerUrl("https://agent.example", TOKEN);
    expect(url).toBe(`https://agent.example/a/${TOKEN}`);
    expect(parseArtifactPath(new URL(url).pathname)).toEqual({
      token: TOKEN,
      route: "page"
    });
  });
});

describe("artifactEntryUrl", () => {
  it("is a path the route matches back, extension or not", () => {
    const plain = artifactEntryUrl("https://agent.example", TOKEN, 3);
    expect(plain).toBe(`https://agent.example/a/${TOKEN}/3`);
    expect(parseArtifactPath(new URL(plain).pathname)).toEqual({
      token: TOKEN,
      route: "bytes",
      sequence: 3
    });

    // The composition the extension exists for, and the coupling worth pinning:
    // what `media.ts` answers for a type has to be something this parser takes.
    const pretty = artifactEntryUrl(
      "https://agent.example",
      TOKEN,
      3,
      artifactMediaExtension("image/jpeg")
    );
    expect(pretty).toBe(`https://agent.example/a/${TOKEN}/3.jpg`);
    expect(parseArtifactPath(new URL(pretty).pathname)).toEqual({
      token: TOKEN,
      route: "bytes",
      sequence: 3
    });
  });
});
