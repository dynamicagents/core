import { importJWK, SignJWT } from "jose";
import {
  A2A_JWS_ALG,
  A2A_RPC_PATH,
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  endpointUrl,
  jwksUrl
} from "@dynamicagents/g2a-protocol";
import {
  TEST_GATEKEEPER_PRIVATE_JWK,
  GATEKEEPER_ORIGIN,
  AGENT_ORIGIN
} from "./fixtures.js";

export interface GatekeeperTokenOptions {
  /**
   * Who the token is for. Defaults to an agent at the default RPC path
   * (`${AGENT_ORIGIN}${A2A_RPC_PATH}`), which is what a gatekeeper mints: the
   * agent's **endpoint**, not its origin.
   *
   * Pass this explicitly when a spec mounts an agent somewhere else — an agent
   * at `/support/a2a` expects that string and refuses this default, which is
   * the whole point of scoping the audience to the endpoint.
   */
  audience?: string;
  issuer?: string;
  /** Relative string ("5m"), absolute epoch seconds, or Date. Past values expire the token. */
  expiresIn?: string | number | Date;
  identity?: Record<string, unknown>;
  /** Claim the identity is carried in. Defaults to core's `IDENTITY_CLAIM`. */
  identityClaim?: string;
  /**
   * Which agent on the target origin this token authorizes, defaulting to
   * `"main"`.
   *
   * The tenants of one deployment share an endpoint and therefore an audience,
   * so this claim is the only thing distinguishing them. Set it to a *different*
   * tenant than the request addresses to exercise the replay case; set it to
   * `""` to mint a token carrying no tenant at all, which is rejected.
   */
  tenant?: string;
  /** Claim the tenant is carried in. Defaults to core's `TENANT_CLAIM`. */
  tenantClaim?: string;
}

/** The tenant `makeGatekeeperToken` authorizes unless a spec says otherwise. */
export const TEST_TENANT = "main";

/** Sign a short-lived EdDSA gatekeeper JWT using the test gatekeeper key. */
export async function makeGatekeeperToken(
  options: GatekeeperTokenOptions = {}
): Promise<string> {
  const privateKey = await importJWK(TEST_GATEKEEPER_PRIVATE_JWK, "EdDSA");
  const tenant = options.tenant ?? TEST_TENANT;
  return (
    new SignJWT({
      [options.identityClaim ?? IDENTITY_CLAIM]: options.identity ?? {
        key: "custom:1:test-agent",
        name: "Test Agent",
        kind: "custom",
        workspaceId: 1
      },
      // An empty tenant omits the claim entirely rather than signing `""` — that
      // is the "gatekeeper too old to scope its tokens" case, and it must be
      // rejected rather than treated as a wildcard.
      ...(tenant ? { [options.tenantClaim ?? TENANT_CLAIM]: tenant } : {})
    })
      // Composed from `@dynamicagents/g2a-protocol`, the same package the real
      // gatekeeper mints with. A fixture that agrees with the verifier but not with
      // the issuer is worse than no fixture: the suite goes green on tokens
      // nothing in production would ever send.
      .setProtectedHeader({
        alg: A2A_JWS_ALG,
        kid: TEST_GATEKEEPER_PRIVATE_JWK.kid,
        jku: jwksUrl(GATEKEEPER_ORIGIN)
      })
      .setIssuer(options.issuer ?? GATEKEEPER_ORIGIN)
      .setAudience(options.audience ?? endpointUrl(AGENT_ORIGIN, A2A_RPC_PATH))
      .setExpirationTime(options.expiresIn ?? "5m")
      .sign(privateKey)
  );
}
