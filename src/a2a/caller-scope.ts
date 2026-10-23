import type { GatekeeperIdentity } from "./verify.js";

/**
 * Who a verified call is for, and the name the durable state it may reach is
 * served under.
 *
 * ## Two facts decide the scope, and only one of them is the issuer's
 *
 * A gatekeeper token carries an identity claim naming the caller instance it
 * dispatched for, and the issuer writes every field of it: the claim reader in
 * `@dynamicagents/g2a-protocol` returns that object as minted, and a signature
 * proves it was not altered, never that it was honest. What verification
 * establishes separately is the origin that signed: `iss`, required to be on the
 * allowlist and to equal the `jku` origin the key was fetched from.
 *
 * The Durable Object name composes both, so the objects one listed gatekeeper
 * can address are a disjoint set from every other listed gatekeeper's, and the
 * claim alone selects nothing. `GATEKEEPER_ORIGINS` answers *who may call*; it
 * cannot answer *whom a caller may act as*, because every origin on it satisfies
 * it equally. This composition is the second answer, and it needs no second
 * configuration value to give it.
 */
export interface VerifiedCaller {
  /**
   * The origin the token was verified against: its `iss`, which
   * {@link file://./verify.ts verifyGatekeeperToken} has already required to be
   * allowlisted and to equal the `jku` origin.
   */
  issuer: string;
  /**
   * The identity claim as the issuer minted it. Advisory from here on: it is
   * what the model is told about its caller
   * ({@link file://./caller.ts callerContext}) and selects nothing.
   */
  identity: GatekeeperIdentity;
  /**
   * The Durable Object name this caller is served under: its task host, the step
   * agents the host's workflow resolves, and everything a plugin keys by
   * `callerKey`.
   */
  scope: string;
}

/**
 * Separates the verified issuer from the key the issuer claimed.
 *
 * `#` cannot occur in an origin, and {@link verifiedCaller} refuses an issuer
 * that is not one, so splitting a scope at its first `#` recovers both halves
 * whatever the key contains: the composition is injective in the pair. That is
 * the whole security property. A key holding a `#` of its own therefore cannot
 * spell another issuer's scope, which a separator the issuer could contain
 * would allow.
 *
 * Not `|`: the sandbox name in `@dynamicagents/plugins` joins its caller and
 * repository halves on a pipe, and a second pipe in the caller half would blur
 * the boundary that join draws.
 */
const SCOPE_SEPARATOR = "#";

/**
 * Bind a verified issuer and the caller it claimed into the scope they are
 * served under.
 *
 * The verified half goes first, which is what keeps caller-controlled text off
 * the front of a Durable Object name. That matters because the name is read by
 * more than `idFromName`: the agents SDK treats a routed name carrying its own
 * `cf-agents:v2:` prefix as a sub-agent identity and returns the logical name
 * inside it from `Agent.name`, and core's task host publishes `this.name` as the
 * `callerKey` its workflow and step agents resolve by.
 *
 * The issuer is used exactly as verification produced it. Normalizing origins
 * has one home, {@link file://./verify.ts normalizeGatekeeperOrigins}, and an
 * `iss` has to equal an allowlisted `jku` origin to reach here, so the three
 * spellings of one configured origin (a bare host, `http://`, a trailing slash)
 * all arrive as the same string and none of them moves a scope.
 *
 * A keyless or issuer-less caller throws rather than falling back to a shared
 * name: a scope that two callers share is the thing this function exists to make
 * impossible. {@link file://../worker/index.ts createA2AWorker} refuses a
 * keyless token with a 400 before it gets this far, so the throw is the floor
 * under a caller that reached routing another way.
 *
 * **There is no legacy spelling of a scope, deliberately.** Objects written
 * before a deployment took this change are keyed by the bare claim, and a
 * fallback that still read them would be the same unbound claim wearing a
 * migration's clothes: in a deployment listing more than one origin, nothing in
 * such an object says which gatekeeper's callers wrote it, so no issuer can be
 * handed its contents. What this costs a deployment is one re-key, and
 * `README.md` says what to expect of it.
 *
 * **Injectivity is a property of the scopes composed here, not of the names
 * already in the namespace.** The old name was `identity.key` verbatim, and the
 * protocol leaves that an arbitrary string, so an object written before the
 * change can carry a name this composes today, and no encoding closes that: a
 * digest of the pair is public, and a gatekeeper choosing its own keys can
 * compute one. What bounds it is who minted the key rather than how the name is
 * spelled. On a deployment that has listed one origin throughout, that
 * gatekeeper is both the writer of such a name and the one now reaching it: it
 * mints every key it claims, and which of its own callers are distinct was its
 * decision before this change and still is. An object written while a second
 * origin was listed is the case the composition cannot speak for, and
 * `README.md` says what a deployment does about it.
 */
export function verifiedCaller(
  issuer: string,
  identity: GatekeeperIdentity
): VerifiedCaller {
  if (!identity.key) {
    throw new Error(
      "a verified caller needs an identity key: it is half of the Durable Object name"
    );
  }
  if (!isOrigin(issuer)) {
    throw new Error(
      `a verified caller's issuer must be the origin that signed its token, not '${issuer}'`
    );
  }
  return {
    issuer,
    identity,
    scope: `${issuer}${SCOPE_SEPARATOR}${identity.key}`
  };
}

/**
 * Whether a string is exactly an origin, which is what the separator above
 * rests on. A URL that parses but carries a path, a query or a fragment is not
 * one, and `URL.origin` is the only thing that can say so.
 */
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}
