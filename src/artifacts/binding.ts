/**
 * How core reaches the artifacts store.
 *
 * **The binding is required**, and that is the property to preserve when
 * editing anything below. A deployment that has not declared `ARTIFACTS` is
 * misconfigured, not configured differently: every delegating round files its
 * notes here, so the alternative to "the binding is there" is not a second
 * behaviour worth having — it is a thread full of the notes the link exists to
 * replace, chosen by nobody, reached by forgetting a line of `wrangler.jsonc`.
 *
 * So the absence is a fault with a name and a fix, raised once at DO start by
 * {@link assertArtifactsBound}, rather than a branch every writer carries.
 */

import type { ArtifactsEnv } from "../env.js";
import type { Artifacts } from "./do.js";

/** The name the binding is read from. */
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

/**
 * Thrown when `ARTIFACTS` is not bound — the wiring fault, named.
 *
 * Carries the fix rather than the symptom, on the same principle as
 * {@link file://../runtime/index.ts RuntimeSetupError}: what reaches a person
 * is a Durable Object that would not start, and the only useful thing to say
 * at that moment is which lines are missing and which files they go in.
 */
export class ArtifactsNotBoundError extends Error {
  constructor() {
    super(
      `${ARTIFACTS_BINDING} is not bound. @dynamicagents/core records every subagent ` +
        "note on the Task's transcript and posts a link, so the binding is required — " +
        "it is three lines in two files. In wrangler.jsonc, add " +
        `{ "name": "${ARTIFACTS_BINDING}", "class_name": "Artifacts" } to ` +
        'durable_objects.bindings and { "new_sqlite_classes": ["Artifacts"] } as the ' +
        "next migration tag. In the Worker entry, add " +
        '`export { Artifacts } from "@dynamicagents/core/artifacts";`.'
    );
    this.name = "ArtifactsNotBoundError";
  }
}

/**
 * The binding, or {@link ArtifactsNotBoundError}.
 *
 * Called at DO start — see `DynamicAgent.onStart` and
 * `RecipeSubagentBase.onStart` — so a deployment that forgot the binding fails
 * where `db.ensureReady()` fails, before any request reaches a writer. The
 * runtime check survives the required type because `ArtifactsEnv` describes
 * what a consumer *declared*, and a `wrangler.jsonc` that never grew the
 * binding still typechecks against an `Env` that claims it.
 */
export function assertArtifactsBound(
  env: ArtifactsEnv
): DurableObjectNamespace<Artifacts> {
  const namespace = env.ARTIFACTS as
    DurableObjectNamespace<Artifacts> | undefined;
  if (!namespace) throw new ArtifactsNotBoundError();
  return namespace;
}

/**
 * The stub for this deployment's artifacts object. See
 * {@link ARTIFACTS_OBJECT_NAME} for why there is only one, and
 * {@link assertArtifactsBound} for what an unbound namespace does here.
 */
export function requireArtifactsStub(
  env: ArtifactsEnv
): DurableObjectStub<Artifacts> {
  const namespace = assertArtifactsBound(env);
  return namespace.get(namespace.idFromName(ARTIFACTS_OBJECT_NAME));
}
