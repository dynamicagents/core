/**
 * How core reaches the artifacts store — if a deployment wired one.
 *
 * **The binding is optional and the whole feature is dormant without it.** A
 * consumer that declares no `ARTIFACTS` namespace gets the behaviour it had
 * before this module existed: every helper here resolves to nothing, and every
 * caller falls back to what it did anyway. That is the property to preserve
 * when editing anything below — a deployment should never have to opt *out*.
 */

import type { Artifacts } from "./do.js";

/** The name the binding is read from, when a deployment declares one. */
export const ARTIFACTS_BINDING = "ARTIFACTS";

/**
 * The name the artifacts object is addressed by.
 *
 * **One object for the deployment, not one per task**, and the read path is
 * what forces it: `GET /a/<token>` arrives holding a token and nothing else, so
 * the object it must reach has to be addressable from the token alone — and a
 * token cannot double as a Durable Object name, because whoever writes the
 * *first* note has to find the object before any token exists.
 *
 * So the artifacts of one deployment share an object and are keyed inside it,
 * which is also what makes the retention sweep a single cheap delete rather
 * than a visit to every task that ever ran. What it costs is that every ingest
 * serializes through one object; the writes are a row apiece, so the bound that
 * matters is how much a deployment writes at once, and sharding on a prefix the
 * token carries is the change to make if that bound is ever the problem.
 */
export const ARTIFACTS_OBJECT_NAME = "artifacts";

/** The `env` slice this feature reads. Optional, deliberately — see above. */
export interface ArtifactsEnv {
  ARTIFACTS?: DurableObjectNamespace<Artifacts>;
}

/**
 * The binding, if the deployment declared one.
 *
 * Takes `object` rather than {@link ArtifactsEnv} because a type whose every
 * property is optional is a *weak type*, and TypeScript refuses an argument
 * that shares no property with it — which describes exactly the `Env` of every
 * agent that has not wired the binding, i.e. the case this has to serve. So the
 * read is one cast, made here, rather than a constraint pushed onto every
 * agent's `Env`.
 */
export function artifactsBinding(
  env: object
): DurableObjectNamespace<Artifacts> | undefined {
  return (env as ArtifactsEnv).ARTIFACTS;
}

/**
 * The stub for this deployment's artifacts object, or `undefined` when nothing
 * is bound. See {@link ARTIFACTS_OBJECT_NAME} for why there is only one.
 */
export function artifactsStub(
  env: object
): DurableObjectStub<Artifacts> | undefined {
  const namespace = artifactsBinding(env);
  return namespace?.get(namespace.idFromName(ARTIFACTS_OBJECT_NAME));
}
