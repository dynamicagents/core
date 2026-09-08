import { describe, it, expect } from "vitest";
import {
  AgentCard,
  canonicalizeAgentCard,
  verifyAgentCardSignature
} from "@a2a-js/sdk";
import {
  A2A_RPC_PATH,
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard,
  wireCard,
  type AgentManifest
} from "./card.js";
import { AGENT_ORIGIN, TEST_AGENT_PRIVATE_JWK } from "../testing/fixtures.js";

/**
 * The second guardian: **the served AgentCard is a fixed point under repeated
 * `fromJSON`.**
 *
 * A verifier does not canonicalize the document it fetched — it re-encodes it,
 * `AgentCard.toJSON(AgentCard.fromJSON(doc))`, and verifies the signature over
 * *that*. So if decoding the served card twice yields a different document than
 * decoding it once, every signature fails in production while every local
 * round-trip looks fine.
 *
 * `SecurityScheme` is the card's only protobuf *oneof*, and it used to be where
 * the property broke: older SDK releases had `fromJSON` read the wire spelling
 * (`{ httpAuthSecurityScheme: … }`) and not the decoded `$case` form, so a second
 * decode collapsed the scheme to `{}` and the signature failed. That is the
 * reason `advertiseSecuritySchemes` defaults to `false`.
 *
 * **Under the SDK this package peers it no longer breaks.** The specs below
 * pin the property in the positive for *both* settings — schemes omitted and
 * schemes advertised — and additionally that an advertised-schemes signature
 * survives the double decode `slack-gatekeeper`'s `canonicalCardPayload` performs.
 * So these tests now serve two purposes: they guard the fixed point, and they are
 * the evidence for flipping the default. If a later SDK regresses the oneof, the
 * advertised-schemes cases fail and the default must stay where it is.
 */

const manifest: AgentManifest = {
  name: "test-agent",
  description: "An agent that exists to be encoded.",
  version: "1.2.3",
  capabilities: {
    streaming: true,
    pushNotifications: true,
    extensions: []
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

/** What a verifier does to the document it fetched, before checking the sig. */
const reencode = (doc: unknown): unknown =>
  AgentCard.toJSON(AgentCard.fromJSON(doc));

describe("AgentCard fixed point", () => {
  it("is stable under repeated decode/encode with schemes omitted (the default)", () => {
    const wire = wireCard(buildBaseCard(manifest, { origin: AGENT_ORIGIN }));

    const once = reencode(wire);
    const twice = reencode(once);

    // The property the signature depends on: however many times a verifier
    // normalizes, it lands on the same document.
    expect(once).toEqual(wire);
    expect(twice).toEqual(once);
  });

  it("still advertises that auth is required, schemes or not", () => {
    // `securityRequirements` is a plain map, not a oneof, so it survives the
    // round trip that eats `securitySchemes`. Dropping the scheme description
    // must not quietly turn the card into an open endpoint.
    const card = buildBaseCard(manifest, { origin: AGENT_ORIGIN });
    expect(card.securityRequirements).toEqual([
      { schemes: { gatekeeperJwt: { list: [] } } }
    ]);
    expect(card.securitySchemes).toEqual({});

    const wire = wireCard(card) as { securityRequirements?: unknown };
    expect(wire.securityRequirements).toBeDefined();
  });

  it("is ALSO stable with schemes advertised", () => {
    // Older SDK releases collapsed the `SecurityScheme` oneof to `{}` on a
    // second decode, breaking the signature — which is why
    // `advertiseSecuritySchemes` still defaults to false. The peered SDK does
    // not: the scheme survives, and so does the fixed point.
    //
    // Deliberately asserted in the positive so the default can be flipped with
    // evidence rather than hope. If a future SDK regresses, this fails.
    const wire = wireCard(
      buildBaseCard(manifest, {
        origin: AGENT_ORIGIN,
        advertiseSecuritySchemes: true
      })
    ) as { securitySchemes?: Record<string, unknown> };

    // `description: ""` is absent: the wire encoding omits protobuf defaults.
    expect(wire.securitySchemes?.gatekeeperJwt).toEqual({
      httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "JWT" }
    });

    const once = reencode(wire);
    expect(once).toEqual(wire);
    expect(reencode(once)).toEqual(wire);
  });

  it("keeps an advertised-schemes signature valid through a double-decoding verifier", async () => {
    // The concrete hazard `card.ts` warns about: slack-gatekeeper's
    // `canonicalCardPayload` decodes a card it already holds typed. Even that
    // now verifies, so nothing on either side is blocking the flip.
    const card = buildBaseCard(manifest, {
      origin: AGENT_ORIGIN,
      advertiseSecuritySchemes: true
    });
    const signed = await signCard(card, {
      privateJwk: TEST_AGENT_PRIVATE_JWK,
      jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
    });

    const { keys } = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    const verifier = verifyAgentCardSignature(async () => keys[0]);
    const asFetched = JSON.parse(JSON.stringify(signed));

    await expect(verifier(asFetched as never)).resolves.toBeUndefined();
    await expect(
      verifier(reencode(reencode(asFetched)) as never)
    ).resolves.toBeUndefined();
  });
});

describe("buildBaseCard", () => {
  it("pins the protocol version per interface, not the agent version", () => {
    const card = buildBaseCard(manifest, { origin: AGENT_ORIGIN });
    const [iface] = card.supportedInterfaces;

    // A client's transport factory matches on this, and the Worker validates
    // the `A2A-Version` header against it — so the agent's own "1.2.3" here
    // would make every request fail version negotiation.
    expect(iface.protocolVersion).toBe("1.0");
    expect(iface.protocolVersion).not.toBe(manifest.version);
    expect(iface.protocolBinding).toBe("JSONRPC");
    expect(iface.url).toBe(`${AGENT_ORIGIN}${A2A_RPC_PATH}`);
  });

  it("takes the manifest as a parameter rather than importing one", () => {
    // The predecessor imported its manifest at module scope, which is what tied
    // the A2A layer to one app. Two cards from one process, differing only by
    // input, is the property that kills it.
    const other = buildBaseCard(
      { ...manifest, name: "other-agent" },
      { origin: "https://other.test", rpcPath: "/rpc" }
    );

    expect(other.name).toBe("other-agent");
    expect(other.supportedInterfaces[0].url).toBe("https://other.test/rpc");
  });
});

describe("signCard", () => {
  it("produces a signature a verifier accepts over the served document", async () => {
    const card = buildBaseCard(manifest, { origin: AGENT_ORIGIN });
    const signed = await signCard(card, {
      privateJwk: TEST_AGENT_PRIVATE_JWK,
      jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
    });

    expect(Array.isArray(signed.signatures)).toBe(true);
    expect((signed.signatures as unknown[]).length).toBe(1);

    // The gatekeeper's side of Trust-On-First-Use: look the key up by the `kid`
    // in the protected header, then verify.
    const { keys } = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    const verifier = verifyAgentCardSignature(async (kid) => {
      const key = keys.find((k) => k.kid === kid);
      if (!key) throw new Error(`no key for kid ${kid}`);
      return key;
    });

    await expect(verifier(signed as never)).resolves.toBeUndefined();
  });

  it("fails verification when the served card is altered after signing", async () => {
    const card = buildBaseCard(manifest, { origin: AGENT_ORIGIN });
    const signed = await signCard(card, {
      privateJwk: TEST_AGENT_PRIVATE_JWK,
      jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
    });

    const { keys } = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    const verifier = verifyAgentCardSignature(async () => keys[0]);
    const tampered = { ...signed, name: "not-the-signed-name" };

    await expect(verifier(tampered as never)).rejects.toThrow();
  });

  it("signs the wire form, so the verifier's round trip reproduces it", async () => {
    // Signing the in-memory proto object would canonicalize `$case` tags and
    // proto defaults that never appear on the wire, and every signature would
    // fail. The check is that stripping signatures off the served document and
    // re-encoding it lands back on exactly the payload that was signed.
    const card = buildBaseCard(manifest, { origin: AGENT_ORIGIN });
    const signed = await signCard(card, {
      privateJwk: TEST_AGENT_PRIVATE_JWK,
      jku: `${AGENT_ORIGIN}/.well-known/jwks.json`
    });

    // `canonicalizeAgentCard` is the function the SDK requires *both* sides to
    // go through, so agreeing here is precisely the property that matters.
    expect(canonicalizeAgentCard(signed as never)).toBe(
      canonicalizeAgentCard(wireCard(card))
    );
  });
});

describe("key handling", () => {
  it("refuses a signing key with no kid", () => {
    // `kid` is required in the JWS protected header and is what the gatekeeper
    // pins on first registration; a key without one fails late and confusingly.
    const { kid: _kid, ...noKid } = TEST_AGENT_PRIVATE_JWK;
    void _kid;
    expect(() => parsePrivateJwk(JSON.stringify(noKid))).toThrow(/kid/);
  });

  it("never lets the private component into the served JWKS", () => {
    const { keys } = publicCardJwks(TEST_AGENT_PRIVATE_JWK);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty("d");
    expect(keys[0].kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(keys[0].alg).toBe("EdDSA");
  });

  it("round-trips a serialized key through parsePrivateJwk", () => {
    const parsed = parsePrivateJwk(JSON.stringify(TEST_AGENT_PRIVATE_JWK));
    expect(parsed.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
  });
});
