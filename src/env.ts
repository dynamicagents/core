/**
 * The Worker `env` slices core reads, declared structurally.
 *
 * A published package cannot reference the ambient `Env` that `wrangler types`
 * generates into a consumer's `worker-configuration.d.ts` — that interface only
 * exists inside the app. So core never names `Env`. Every function that needs a
 * binding either takes it as a parameter, or takes an object satisfying one of
 * the slices below, and a consumer's generated `Env` satisfies them structurally
 * with no cast.
 *
 * The two secrets are the zero-trust contract and are the only names core
 * insists on; everything else is passed in. Even these are only a *default*:
 * `createA2AWorker`'s `secrets` option reads them from wherever a consumer keeps
 * them, so a Worker whose bindings are already named something else does not
 * have to rename them.
 *
 * That is *all* it does. The secrets are read once per request and belong to the
 * deployment, not to an agent: several agents share one Worker as tenants of one
 * origin, and they share this one signing identity with it. What separates them
 * is the tenant claim on the gatekeeper token, not a key apiece. See
 * {@link file://./worker/index.ts}.
 *
 * A slice here is something core cannot run without, and every one of them is
 * required. There is no optional slice: a binding core reads on a path a
 * deployment cannot disable is part of what an agent *is*, and modelling it as
 * `T | undefined` buys an if-branch at every call site to describe a deployment
 * that is simply misconfigured.
 */

import type { Artifacts } from "./artifacts/do.js";

/** Workers AI, backing the chat loop (and whatever a plugin runs on it). */
export interface AiEnv {
  AI: Ai;
}

/**
 * The two secrets every Dynamic Agent must carry.
 *
 * - `A2A_SIGNING_KEY` — Ed25519 private JWK (JSON, **must** include `kid`). Signs
 *   the AgentCard and every push-notification callback JWT. Its public half is
 *   served at the agent's JWKS path and pinned by the gatekeeper on first
 *   registration (Trust-On-First-Use).
 * - `GATEKEEPER_ORIGINS` — JSON array of origins allowed to call this agent. The
 *   allowlist a gatekeeper JWT's `jku` and `iss` are checked against; see
 *   {@link file://./a2a/verify.ts}.
 *
 * No shared secret ever crosses the boundary in either direction: the agent
 * verifies the gatekeeper with the gatekeeper's public JWKS, and the gatekeeper verifies
 * the agent with the agent's.
 */
export interface A2ASecretsEnv {
  A2A_SIGNING_KEY: string;
  GATEKEEPER_ORIGINS: string;
}

/**
 * The artifacts object, holding what a run had to say.
 *
 * **Required**, because every sub-agent run writes to it: a labelled note
 * goes on the Task's transcript and the thread gets a link, and there is no
 * per-deployment switch that turns that back into a thread full of notes. The
 * binding is therefore a structural assumption of core, checked once where a
 * missing one is cheap to say something useful about — see
 * {@link file://./artifacts/binding.ts assertArtifactsBound} — rather than an
 * `if` at each of the sites that writes.
 *
 * The class behind it is core's own and ships whole:
 * {@link file://./artifacts/do.ts Artifacts}, exported from the consumer's
 * Worker unchanged.
 */
export interface ArtifactsEnv {
  ARTIFACTS: DurableObjectNamespace<Artifacts>;
}

/** The minimum an agent Worker must bind for core to function. */
export type CoreEnv = AiEnv & A2ASecretsEnv & ArtifactsEnv;

/**
 * Parse `GATEKEEPER_ORIGINS`. Accepts a JSON array (the documented form) or a
 * single bare origin, so a misconfigured secret fails with a readable message
 * rather than as an empty allowlist that rejects every caller identically.
 */
export function parseGatekeeperOrigins(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("GATEKEEPER_ORIGINS is empty");
  if (!trimmed.startsWith("[")) return [trimmed];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `GATEKEEPER_ORIGINS is not valid JSON: ${(err as Error).message}`
    );
  }
  if (!Array.isArray(parsed) || parsed.some((o) => typeof o !== "string")) {
    throw new Error(
      "GATEKEEPER_ORIGINS must be a JSON array of origin strings"
    );
  }
  if (parsed.length === 0) throw new Error("GATEKEEPER_ORIGINS is empty");
  return parsed as string[];
}
