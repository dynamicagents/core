import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { importJWK, SignJWT } from "jose";
import {
  GatekeeperAuthError,
  IDENTITY_CLAIM,
  bearerToken,
  normalizeGatekeeperOrigins,
  verifyGatekeeperToken
} from "./verify.js";
import { makeGatekeeperToken } from "../testing/auth.js";
import {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  SECOND_GATEKEEPER_ORIGIN,
  TEST_GATEKEEPERS,
  TEST_GATEKEEPER_PRIVATE_JWK,
  TEST_SECOND_GATEKEEPER,
  gatekeeperPublicJwks
} from "../testing/fixtures.js";

/**
 * The rejection matrix for the zero-trust contract.
 *
 * `verify.ts` calls itself a guardian: its four checks — `jku` present → origin
 * allowlist → `iss` origin equals `jku` origin → `jwtVerify` pinned to EdDSA —
 * arrived byte-identical from two independently-evolved predecessor agents, and
 * they are the entire reason an agent can trust a caller it has no shared secret
 * with. Every one of them is asserted below, negatively. A change that makes any
 * check optional, or adds a local-development bypass, has to delete a test here
 * to land — which is the point.
 */

const JWKS_URL = `${GATEKEEPER_ORIGIN}/.well-known/jwks.json`;
const ALLOWED = [GATEKEEPER_ORIGIN];

/**
 * What a gatekeeper mints for an agent at the default RPC path: the agent's
 * **endpoint**, not its origin. Every token here carries it — including the ones
 * built by hand to test some *other* rejection, so that each of those still
 * fails for the reason it names rather than tripping the audience check first.
 */
const AGENT_AUDIENCE = `${AGENT_ORIGIN}/a2a`;

/**
 * `createRemoteJWKSet` fetches the gatekeeper's public keys over the network. Serve
 * them from a stub so the specs are hermetic — and so `jwksFetches` can prove the
 * allowlist check happens *before* the fetch, not after.
 */
let jwksFetches: string[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    jwksFetches.push(url);
    // Both fixture gatekeepers, so a token honest about being the *other*
    // listed origin's verifies here as it would in a deployment listing both.
    const gatekeeper = TEST_GATEKEEPERS.find(
      (gk) => url === `${gk.origin}/.well-known/jwks.json`
    );
    if (gatekeeper) {
      return new Response(gatekeeperPublicJwks(gatekeeper), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("verifyGatekeeperToken", () => {
  it("accepts a well-formed gatekeeper token and returns the caller identity", async () => {
    const token = await makeGatekeeperToken();

    const { payload, identity } = await verifyGatekeeperToken(token, {
      allowedOrigins: ALLOWED,
      audience: AGENT_AUDIENCE
    });

    expect(payload.iss).toBe(GATEKEEPER_ORIGIN);
    expect(payload.aud).toBe(AGENT_AUDIENCE);
    // `key` is the only field anything downstream depends on.
    expect(identity.key).toBe("custom:1:test-agent");
    expect(identity.workspaceId).toBe(1);
  });

  it("returns the origin it verified against, which no claim can move", async () => {
    // The issuer is the one half of a caller's identity the issuer does not
    // write, and routing binds a scope to it, so it has to come from the checks
    // above rather than from the payload. The claim here says otherwise, twice.
    const token = await makeGatekeeperToken({
      identity: {
        key: "custom:1:test-agent",
        issuer: SECOND_GATEKEEPER_ORIGIN
      }
    });

    const { issuer, payload } = await verifyGatekeeperToken(token, {
      allowedOrigins: [GATEKEEPER_ORIGIN, SECOND_GATEKEEPER_ORIGIN],
      audience: AGENT_AUDIENCE
    });

    expect(issuer).toBe(GATEKEEPER_ORIGIN);
    expect(payload.iss).toBe(GATEKEEPER_ORIGIN);
  });

  it("returns the second listed origin for a token that origin signed", async () => {
    // The other direction: the returned issuer tracks who signed, not which
    // origin happens to be first on the allowlist.
    const token = await makeGatekeeperToken({
      gatekeeper: TEST_SECOND_GATEKEEPER
    });

    const { issuer } = await verifyGatekeeperToken(token, {
      allowedOrigins: [GATEKEEPER_ORIGIN, SECOND_GATEKEEPER_ORIGIN],
      audience: AGENT_AUDIENCE
    });

    expect(issuer).toBe(SECOND_GATEKEEPER_ORIGIN);
  });

  it("rejects a token with no jku header (RFC 7515 §4.1.2)", async () => {
    const privateKey = await importJWK(TEST_GATEKEEPER_PRIVATE_JWK, "EdDSA");
    const token = await new SignJWT({ [IDENTITY_CLAIM]: { key: "k" } })
      // No `jku` — the agent has nowhere to fetch keys from, and must not
      // fall back to a configured default.
      .setProtectedHeader({
        alg: "EdDSA",
        kid: TEST_GATEKEEPER_PRIVATE_JWK.kid
      })
      .setIssuer(GATEKEEPER_ORIGIN)
      .setAudience(AGENT_AUDIENCE)
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyGatekeeperToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(/missing jku/i);
  });

  it("rejects a jku origin outside the allowlist without fetching it", async () => {
    // The key-injection attack: a valid signature over attacker-chosen keys.
    // Allowing an unlisted origin here would make the whole scheme decorative.
    const token = await makeGatekeeperToken();
    jwksFetches = [];

    await expect(
      verifyGatekeeperToken(token, {
        allowedOrigins: ["https://not-the-gatekeeper.test"],
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(/not in the allowed gatekeeper origins/i);

    // Order matters as much as the check: validate, *then* fetch.
    expect(jwksFetches).toEqual([]);
  });

  it("rejects when iss origin does not match jku origin", async () => {
    // Both origins are allowlisted, so this is the check that stops one listed
    // gatekeeper from minting tokens that appear to come from another.
    const token = await makeGatekeeperToken({ issuer: "https://evil.test" });

    await expect(
      verifyGatekeeperToken(token, {
        allowedOrigins: [GATEKEEPER_ORIGIN, "https://evil.test"],
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(/does not match iss origin/i);
  });

  it("rejects a token signed with something other than EdDSA", async () => {
    const token = await new SignJWT({ [IDENTITY_CLAIM]: { key: "k" } })
      .setProtectedHeader({
        alg: "HS256",
        kid: TEST_GATEKEEPER_PRIVATE_JWK.kid,
        jku: JWKS_URL
      })
      .setIssuer(GATEKEEPER_ORIGIN)
      .setAudience(AGENT_AUDIENCE)
      .setExpirationTime("5m")
      .sign(new Uint8Array(32));

    await expect(
      verifyGatekeeperToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(GatekeeperAuthError);
  });

  it("rejects an expired token", async () => {
    const token = await makeGatekeeperToken({ expiresIn: "-1m" });

    await expect(
      verifyGatekeeperToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(GatekeeperAuthError);
  });

  it("rejects a token whose signature has been tampered with", async () => {
    const token = await makeGatekeeperToken();
    const [header, body, sig] = token.split(".");
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;

    await expect(
      verifyGatekeeperToken(`${header}.${body}.${flipped}`, {
        allowedOrigins: ALLOWED,
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(GatekeeperAuthError);
  });

  it("rejects a token minted for a different audience", async () => {
    const token = await makeGatekeeperToken({
      audience: "https://elsewhere.test"
    });

    await expect(
      verifyGatekeeperToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_AUDIENCE
      })
    ).rejects.toThrow(GatekeeperAuthError);
  });

  it("reads the identity from a configured non-default claim", async () => {
    // The claim is configurable for deployments not behind slack-gatekeeper;
    // the *checks* above are not.
    const claim = "https://example.test/identity";
    const token = await makeGatekeeperToken({
      identityClaim: claim,
      identity: { key: "custom:9:other" }
    });

    const { identity } = await verifyGatekeeperToken(token, {
      allowedOrigins: ALLOWED,
      audience: AGENT_AUDIENCE,
      identityClaim: claim
    });

    expect(identity.key).toBe("custom:9:other");
  });

  it("yields an empty identity when the claim is absent, rather than throwing", async () => {
    // Downstream rejects a caller with no `key`; verification itself stays a
    // pure signature/origin question.
    const token = await makeGatekeeperToken({
      identityClaim: "https://example.test/somewhere-else"
    });

    const { identity } = await verifyGatekeeperToken(token, {
      allowedOrigins: ALLOWED,
      audience: AGENT_AUDIENCE
    });

    expect(identity).toEqual({});
  });
});

describe("normalizeGatekeeperOrigins", () => {
  it("accepts a bare hostname, an http URL, and a trailing slash alike", () => {
    expect(
      normalizeGatekeeperOrigins([
        "gatekeeper.test",
        "http://gatekeeper.test",
        "https://gatekeeper.test/"
      ])
    ).toEqual([GATEKEEPER_ORIGIN, GATEKEEPER_ORIGIN, GATEKEEPER_ORIGIN]);
  });

  it("keeps the allowlist exact rather than matching by suffix", () => {
    // `evil-gatekeeper.test` must never satisfy an allowlist entry of
    // `gatekeeper.test`; normalization is to an origin, not to a pattern.
    const [normalized] = normalizeGatekeeperOrigins(["gatekeeper.test"]);
    expect(normalized).not.toBe("https://evil-gatekeeper.test");
    expect(normalizeGatekeeperOrigins(["evil-gatekeeper.test"])).toEqual([
      "https://evil-gatekeeper.test"
    ]);
  });

  it("rejects an empty or unparseable origin loudly", () => {
    expect(() => normalizeGatekeeperOrigins([""])).toThrow(GatekeeperAuthError);
    expect(() => normalizeGatekeeperOrigins(["   "])).toThrow(
      GatekeeperAuthError
    );
  });
});

describe("bearerToken", () => {
  it("extracts a Bearer token case-insensitively", () => {
    const req = (auth: string) =>
      new Request("https://agent.test", { headers: { authorization: auth } });

    expect(bearerToken(req("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
    expect(bearerToken(req("bearer abc.def.ghi"))).toBe("abc.def.ghi");
  });

  it("returns null when the header is missing or not a Bearer scheme", () => {
    expect(bearerToken(new Request("https://agent.test"))).toBeNull();
    expect(
      bearerToken(
        new Request("https://agent.test", {
          headers: { authorization: "Basic dXNlcjpwYXNz" }
        })
      )
    ).toBeNull();
  });
});
