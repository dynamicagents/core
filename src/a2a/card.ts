import type { JWK } from "jose";
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  generateAgentCardSignature
} from "@a2a-js/sdk";
import {
  A2A_JWS_ALG,
  A2A_RPC_PATH,
  endpointUrl
} from "@dynamicagents/g2a-protocol";

/**
 * The card signature uses the one algorithm every Dynamic Agents A2A signature uses,
 * and the default RPC path is the one the gatekeeper also knows. Both come from
 * `@dynamicagents/g2a-protocol` — see {@link file://./verify.ts} for why that is a
 * separate package rather than a constant declared on each side.
 */
export { A2A_RPC_PATH } from "@dynamicagents/g2a-protocol";

/**
 * The transport-independent half of an {@link AgentCard} — everything that does
 * not depend on the request origin. {@link buildBaseCard} adds
 * `supportedInterfaces` and the security fields.
 *
 * Derived from the SDK `AgentCard` rather than hand-declared so a protocol field
 * that gains a requirement fails the build here instead of silently going
 * unadvertised.
 */
export type AgentManifest = Pick<
  AgentCard,
  | "name"
  | "description"
  | "version"
  | "capabilities"
  | "defaultInputModes"
  | "defaultOutputModes"
  | "skills"
>;

/**
 * An AgentCard in its **protobuf-JSON** encoding — the form served at the
 * well-known path and the exact document a signature is computed over. Distinct
 * from the in-memory `AgentCard`: the wire form omits proto defaults and renders
 * oneofs (`securitySchemes`, `Part.content`) as a single key rather than a
 * `$case` tag.
 */
export type WireAgentCard = Record<string, unknown>;

export interface CardSigningConfig {
  /** Ed25519 private JWK (with `kid`) that signs the card. */
  privateJwk: JWK & { kid: string };
  /** Public URL serving this agent's JWKS — embedded as the JWS `jku`. */
  jku: string;
}

export interface BuildCardOptions {
  /** Origin the card is served from; the interface `url` is built under it. */
  origin: string;
  /** Path this agent answers JSON-RPC on. Defaults to {@link A2A_RPC_PATH}. */
  rpcPath?: string;
  /**
   * The tenant this card describes, advertised on its interface entry.
   *
   * Several agents share one endpoint here, so `tenant` is what says *which*
   * one — A2A spec §8.3.2 requires a client to echo the declared value on every
   * request, and this Worker refuses a request that does not.
   *
   * Omitted for the **root stub card**, which describes the origin rather than
   * any agent: it advertises the endpoint and `extendedAgentCard`, and a caller
   * reaches a real agent by asking for its tenant.
   */
  tenant?: string;
  /**
   * Advertise the gatekeeper's Bearer-JWT scheme in `securitySchemes`.
   *
   * **Defaults to `false` for historical reasons that no longer hold — see
   * below before relying on the default.**
   *
   * `SecurityScheme` is the card's only protobuf *oneof*, and in earlier SDK
   * releases `SecurityScheme.fromJSON` read only the wire spelling
   * (`{ httpAuthSecurityScheme: … }`) and not the decoded `$case` form. A
   * verifier that decodes the fetched card and then canonicalizes it through
   * `toJSON(fromJSON(card))` decodes twice, and the second pass collapsed
   * `{ gatekeeperJwt: { httpAuthSecurityScheme: … } }` to `{ gatekeeperJwt: {} }` — a
   * different document from the one that was signed, so the signature failed.
   * slack-gatekeeper's `canonicalCardPayload` double-decodes exactly this way.
   *
   * **The SDK this package peers no longer does that.** `card.spec.ts` asserts it
   * directly: an advertised-schemes card is a fixed point under repeated
   * decoding, and its signature verifies both as served and after a double
   * decode. So the safety argument for the `false` default is gone, and the
   * remaining reason to keep it is deployment ordering — a gatekeeper resolving
   * an older SDK copy would still collapse the oneof. Flip the default once the
   * gatekeepers in play are known to decode it as a fixed point; the specs will
   * hold the line if
   * a later SDK regresses.
   *
   * `securityRequirements` is unaffected either way — it is a plain map, not a
   * oneof — so the card always declares that auth is *required*, it just may not
   * describe the scheme.
   */
  advertiseSecuritySchemes?: boolean;
}

/**
 * The `httpAuthSecurityScheme` describing the gatekeeper's Bearer JWT, and the
 * requirement that references it. Split out so the requirement can be advertised
 * even when {@link BuildCardOptions.advertiseSecuritySchemes} keeps the scheme
 * itself off the wire.
 */
const GATEKEEPER_SCHEME_ID = "gatekeeperJwt";

/**
 * Build the (unsigned) AgentCard.
 *
 * v1.0 replaced the card's flat `url` / `preferredTransport` / `protocolVersion`
 * fields with an ordered `supportedInterfaces` list, where each entry pins its
 * own protocol binding *and* protocol version. That per-interface
 * `protocolVersion` is what a client's transport factory matches on and what the
 * Worker validates the `A2A-Version` request header against, so it must be the
 * real protocol version rather than the agent's own version string.
 */
export function buildBaseCard(
  manifest: AgentManifest,
  opts: BuildCardOptions
): AgentCard {
  const rpcPath = opts.rpcPath ?? A2A_RPC_PATH;
  return {
    ...manifest,
    capabilities: {
      // `extensions` is required on the proto type but absent from most
      // hand-written manifests, so it is defaulted before the spread rather
      // than after — a manifest that declares extensions keeps them.
      extensions: [],
      ...manifest.capabilities,
      // Forced on, not inherited from the manifest: an agent here is *only*
      // reachable as a tenant, and its card *only* through
      // `GetExtendedAgentCard`. The SDK gates that method on this flag, reading
      // it off whichever card the request handler was built with (spec §3.3.4 —
      // it MUST return `UnsupportedOperationError` when unset), so every card
      // this Worker serves has to carry it, the stub and the tenants alike.
      extendedAgentCard: true
    },
    supportedInterfaces: [
      {
        // The gatekeeper reads this URL off the card and mints `aud` from it with
        // `audienceFor`; this Worker derives its expected audience the same
        // way. `endpointUrl` is what makes those provably equal — the protocol
        // package pins `audienceFor(endpointUrl(o, p)) === endpointUrl(o, p)`
        // for every path, rather than leaving both sides to concatenate.
        url: endpointUrl(opts.origin, rpcPath),
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: opts.tenant ?? ""
      }
    ],
    provider: undefined,
    documentationUrl: undefined,
    iconUrl: undefined,
    securitySchemes: opts.advertiseSecuritySchemes
      ? {
          [GATEKEEPER_SCHEME_ID]: {
            scheme: {
              $case: "httpAuthSecurityScheme",
              value: { description: "", scheme: "bearer", bearerFormat: "JWT" }
            }
          }
        }
      : {},
    // v0.3's `security: [{ gatekeeperJwt: [] }]`. The empty `list` means the scheme
    // is required but carries no scopes. Safe to advertise unconditionally: this
    // is a plain map, so it survives the round trip that eats `securitySchemes`.
    securityRequirements: [
      { schemes: { [GATEKEEPER_SCHEME_ID]: { list: [] } } }
    ],
    signatures: []
  };
}

/**
 * Sign the card with a detached-payload EdDSA flattened JWS, returning the
 * signed **wire** card to serve. v1.0 standardized this (A2A spec §8.4), so the
 * canonicalization and JWS construction are the SDK's rather than a local
 * scheme: a JCS (RFC 8785) canonicalization of the card with `signatures`
 * removed, under a protected header carrying `alg`, `kid` and `typ` (all three
 * are required — the SDK verifier rejects a signature missing any of them).
 *
 * The card is normalized to its wire form *before* signing because that is what
 * the verifier canonicalizes: `verifyAgentCardSignature` re-encodes whatever
 * document it fetched through `AgentCard.toJSON(AgentCard.fromJSON(card))`.
 * Signing the in-memory proto object instead would canonicalize `$case` tags and
 * proto defaults that never appear on the wire, and every signature would fail.
 *
 * A verifying gatekeeper strips the `signatures` array, recomputes the canonical
 * payload, and verifies — pinning this key's `kid`+`jku` on first registration
 * (Trust-On-First-Use).
 */
export async function signCard(
  card: AgentCard,
  cfg: CardSigningConfig
): Promise<WireAgentCard> {
  const sign = generateAgentCardSignature(cfg.privateJwk, {
    alg: A2A_JWS_ALG,
    kid: cfg.privateJwk.kid,
    typ: "JOSE",
    jku: cfg.jku
  });
  const signed = await sign(wireCard(card));
  return signed as unknown as WireAgentCard;
}

/**
 * The same signature, attached to the **in-memory** card instead of the wire
 * one — for a caller that hands the card to something which will encode it
 * itself.
 *
 * That caller is `GetExtendedAgentCard`. The SDK's JSON-RPC transport runs
 * `AgentCard.toJSON()` over whatever the extended-card provider returns, so
 * returning {@link signCard}'s wire card means `toJSON` runs over a document
 * that has already been encoded. For most cards that is a no-op and looks fine
 * — which is the trap. `securitySchemes` is a protobuf *oneof*: encoding it
 * twice collapses `{ gatekeeperJwt: { httpAuthSecurityScheme: … } }` to
 * `{ gatekeeperJwt: {} }`, the served document stops matching the one that was
 * signed, and every signature verification fails.
 *
 * So the double encode is latent today only because
 * {@link BuildCardOptions.advertiseSecuritySchemes} defaults to `false`; it
 * would surface the day that flag is flipped, as a signature failure with
 * nothing pointing back here. Returning the in-memory card lets the SDK do the
 * single encode the signature was computed over, and is correct either way.
 *
 * `card.spec.ts` pins both halves.
 */
export async function signCardInPlace(
  card: AgentCard,
  cfg: CardSigningConfig
): Promise<AgentCard> {
  const signed = await signCard(card, cfg);
  return { ...card, signatures: signed.signatures as AgentCard["signatures"] };
}

/**
 * The card's protobuf-JSON encoding. Typed back as `AgentCard` for the SDK
 * signer, which is generic over "the document to canonicalize" rather than over
 * the in-memory shape specifically.
 *
 * Encode-only — never `toJSON(fromJSON(card))`. `fromJSON` reads the *wire*
 * spelling of a oneof, so running it over an in-memory card silently drops every
 * `$case`-tagged field. The verifier's round trip is the mirror image and stable:
 * it decodes the document it fetched and re-encodes it to exactly this.
 */
export function wireCard(card: AgentCard): AgentCard {
  return AgentCard.toJSON(card) as AgentCard;
}

/**
 * Parse and validate the `A2A_SIGNING_KEY` secret into the private JWK used to
 * sign the card. Throws if the JWK is missing its `kid` (required for the JWS
 * protected header and gatekeeper key-pinning).
 */
export function parsePrivateJwk(raw: string): CardSigningConfig["privateJwk"] {
  const jwk = JSON.parse(raw) as { kid?: string };
  if (!jwk.kid) throw new Error("A2A_SIGNING_KEY must include a `kid`");
  return jwk as CardSigningConfig["privateJwk"];
}

/** Public card-signing JWKS (served at the `jku`): the private JWK minus `d`. */
export function publicCardJwks(privateJwk: JWK & { kid: string }): {
  keys: JWK[];
} {
  const { d: _d, ...pub } = privateJwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: A2A_JWS_ALG }] };
}
