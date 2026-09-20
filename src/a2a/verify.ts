import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload
} from "jose";
import {
  A2A_JWS_ALG,
  readIdentityClaim,
  readTenantClaim,
  type GatekeeperIdentity
} from "@dynamicagents/g2a-protocol";

/**
 * Verify the gatekeeper identity JWT (the "B authenticates A" half of zero-trust).
 *
 * The gatekeeper signs a short-lived EdDSA JWT and sends it as a Bearer token on
 * every A2A call. Per RFC 7515 §4.1.2 it embeds a `jku` header pointing at its
 * public JWKS, so remote agents don't need a separately configured JWKS URL —
 * they read `jku` straight from the token and verify the key from there.
 *
 * Security: the `jku` origin is validated against the allowed origins before
 * fetching, preventing key-injection attacks (an attacker cannot point `jku` at
 * their own JWKS and have it accepted).
 *
 * **This file is a guardian.** The four checks below — `jku` present → origin
 * allowlist → `iss` origin equals `jku` origin → `jwtVerify` pinned to EdDSA —
 * are the whole zero-trust contract, and they arrived here byte-identical from
 * two independently-evolved agents. Do not weaken any of them, do not make any
 * of them optional, and do not add a bypass for local development: run a local
 * gatekeeper instead.
 */

/**
 * The wire contract — claim names, algorithm, identity shape — comes from
 * `@dynamicagents/g2a-protocol`, which the gatekeeper also depends on directly.
 * The gatekeeper is not an agent and must not import this package, so declaring
 * the contract on each side is the alternative — and it drifts silently: the two
 * land on different claim namespaces, verification reads an empty tenant, and
 * every request 401s with both builds green.
 *
 * A namespace change is survivable only because both sides read it from one
 * package: bump the protocol dependency and ship core and `slack-gatekeeper` in
 * the same deploy.
 *
 * Re-exported below so nothing downstream of `@dynamicagents/core/a2a` has to
 * know about the split — an agent imports these from here.
 */
export {
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  type GatekeeperIdentity
} from "@dynamicagents/g2a-protocol";

/** Thrown when a gatekeeper token is missing or fails verification. */
export class GatekeeperAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatekeeperAuthError";
  }
}

// jose's remote JWKS helper caches keys + handles rotation; build one per URL
// and reuse it across requests in the same isolate.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, set);
  }
  return set;
}

/** Extract the Bearer token from an `Authorization` header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export interface VerifyOptions {
  /** Allowed gatekeeper origins — validates both the `jku` domain and `iss` claim. */
  allowedOrigins: string[];
  audience: string;
  /** Claim carrying the caller identity. Defaults to {@link IDENTITY_CLAIM}. */
  identityClaim?: string;
  /** Claim carrying the authorized tenant. Defaults to {@link TENANT_CLAIM}. */
  tenantClaim?: string;
}

/**
 * Normalize configured gatekeeper origins to the HTTPS origins emitted in gatekeeper
 * JWT `jku` and `iss` claims. This accepts a hostname, `http://` URL, or URL
 * with a trailing slash while keeping the verification allowlist exact.
 */
export function normalizeGatekeeperOrigins(origins: string[]): string[] {
  return origins.map((origin) => {
    const trimmed = origin.trim();
    if (!trimmed) {
      throw new GatekeeperAuthError(
        "allowed gatekeeper origin cannot be empty"
      );
    }
    try {
      return new URL(`https://${trimmed.replace(/^https?:\/\//i, "")}`).origin;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GatekeeperAuthError(
        `invalid allowed gatekeeper origin '${origin}': ${message}`
      );
    }
  });
}

/**
 * Verify a gatekeeper JWT and return its payload, parsed identity and authorized
 * tenant.
 *
 * The `jku` JWK Set URL is read directly from the token's protected header
 * (RFC 7515 §4.1.2) and validated against the allowlist before fetching, so no
 * separate JWKS URL configuration is needed on the remote side.
 *
 * `tenant` is returned rather than enforced: this function stays a pure
 * signature/origin question, and only the caller knows which tenant the request
 * actually addressed. {@link createA2AWorker} compares the two.
 *
 * Throws {@link GatekeeperAuthError} on any failure.
 */
export async function verifyGatekeeperToken(
  token: string,
  opts: VerifyOptions
): Promise<{
  payload: JWTPayload;
  identity: GatekeeperIdentity;
  tenant: string;
}> {
  try {
    const allowedOrigins = normalizeGatekeeperOrigins(opts.allowedOrigins);
    // Extract jku from the protected header — this is the standard way the
    // gatekeeper advertises where to fetch its public key (RFC 7515 §4.1.2).
    const header = decodeProtectedHeader(token) as { jku?: string };
    const jku = header.jku;
    if (!jku) {
      throw new GatekeeperAuthError(
        "gatekeeper JWT missing jku header (RFC 7515 §4.1.2)"
      );
    }
    // Security: validate the jku origin before fetching. Without this an
    // attacker could forge a token with jku pointing at their own JWKS.
    const jkuOrigin = new URL(jku).origin;
    if (!allowedOrigins.includes(jkuOrigin)) {
      throw new GatekeeperAuthError(
        `jku origin '${jkuOrigin}' is not in the allowed gatekeeper origins`
      );
    }
    // Prevent one listed gatekeeper from impersonating another: the origin where
    // keys are fetched must match the origin that issued the token.
    const rawIss = decodeJwt(token).iss ?? "";
    const issOrigin = new URL(rawIss).origin;
    if (issOrigin !== jkuOrigin) {
      throw new GatekeeperAuthError(
        `jku origin '${jkuOrigin}' does not match iss origin '${issOrigin}'`
      );
    }
    const { payload } = await jwtVerify(token, jwksFor(jku), {
      issuer: allowedOrigins,
      audience: opts.audience,
      algorithms: [A2A_JWS_ALG]
    });
    // Read through the protocol package's readers rather than indexing the
    // payload here: they are where "an absent or malformed claim yields an
    // empty value, never a default" has its single implementation, and the
    // emptiness is load-bearing — `createA2AWorker` compares the tenant against
    // the one the request body addressed, and `""` matches none of them.
    return {
      payload,
      identity: readIdentityClaim(payload, opts.identityClaim),
      tenant: readTenantClaim(payload, opts.tenantClaim)
    };
  } catch (err) {
    if (err instanceof GatekeeperAuthError) throw err;
    throw new GatekeeperAuthError((err as Error).message);
  }
}
