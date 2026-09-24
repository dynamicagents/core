import { describe, it, expect } from "vitest";
import { artifactViewerUrl, parseArtifactPath } from "./path.js";
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

  it.each([
    ["another path entirely", "/.well-known/agent-card.json"],
    ["the prefix alone", "/a/"],
    ["a token too short to be one", "/a/abc123"],
    ["a token carrying punctuation", `/a/${TOKEN.slice(0, 39)}-`],
    ["a traversal attempt", "/a/../../etc/passwd"],
    ["a path segment nothing serves", `/a/${TOKEN}/raw`],
    ["a deeper path", `/a/${TOKEN}/events/extra`]
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
