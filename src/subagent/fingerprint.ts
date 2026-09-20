import type { RecipeExecutionRequest } from "../subtasks/types.js";
import type { AgentLimits } from "../config.js";

/**
 * Version of the canonicalization format below.
 *
 * Bump it **only** when a change to `canonicalRequest` would make two equal
 * executions hash differently. Bumping invalidates every cached result and every
 * in-flight run's checkpoint, so it is a deliberate act, not a side effect.
 */
export const FINGERPRINT_VERSION = 1;

/**
 * Canonical JSON of the fields that define an execution's identity, rebuilt as
 * literals in fixed key order so `JSON.stringify` is deterministic (object
 * insertion order). Array order is semantic and preserved: the parent builds
 * references from ordinal-ordered rows, so a retry of the same execution is
 * byte-identical.
 *
 * **Limits are canonicalized as *declared*, not as merged.** Merging them
 * against the house baseline first is the tempting alternative — `{}` and an
 * explicit restatement of the baseline are the same execution and should hash
 * alike — but its cost is not payable once the baseline lives in a versioned
 * package: a patch release that nudges a default would change every fingerprint
 * at once, and every in-flight subagent run would miss its checkpoint and
 * restart from turn zero having already spent its budget.
 *
 * Hashing the sparse declaration inverts that trade. A recipe that spells out
 * the baseline explicitly gets a different key from one that omits it — worth
 * exactly one redundant execution, once, for a recipe nobody writes — and the
 * host's baseline becomes free to move. {@link FINGERPRINT_VERSION} is the
 * deliberate lever for that invalidation, rather than a merge causing it by
 * accident.
 */
export function canonicalRequest(request: RecipeExecutionRequest): string {
  const canonical = {
    v: FINGERPRINT_VERSION,
    taskId: request.taskId,
    subtaskId: request.subtaskId,
    type: request.type,
    recipe: {
      key: request.recipe.key,
      version: request.recipe.version,
      // No model ids. Their absence is the same trade this file already makes
      // for `limits`: the host's own configuration stays out of the fingerprint,
      // so changing it does not invalidate every checkpoint at once and restart
      // every in-flight run from turn zero with its budget already spent. A run
      // that resumes on a newly configured model resumes from conversation
      // state, which is model-independent.
      soul: request.recipe.soul,
      toolFamilies: request.recipe.toolFamilies,
      enabled: request.recipe.enabled,
      limits: canonicalLimits(request.recipe.limits),
      historyWindow: request.recipe.historyWindow,
      reportMetrics: request.recipe.reportMetrics
    },
    prompt: request.prompt,
    references: request.references.map((ref) => ({
      role: ref.role,
      text: ref.text
    })),
    // Params ARE identity: the same prompt against a different external resource
    // is different work, and must not replay a cached result. Key order is fixed
    // by sorting, so an equivalent params object always canonicalizes identically.
    params: Object.fromEntries(
      Object.entries(request.params).sort(([a], [b]) => (a < b ? -1 : 1))
    )
  };
  return JSON.stringify(canonical);
}

/**
 * A recipe's declared budget, normalized: only positive integers count (matching
 * what `resolveLimits` would honor), and fields appear in fixed order with
 * absent ones omitted. So `{}`, `{ maxTurns: 0 }`, and `{ maxTurns: 1.5 }` all
 * canonicalize alike — they all mean "inherit the baseline".
 */
function canonicalLimits(
  limits: Partial<AgentLimits> | undefined
): Partial<AgentLimits> {
  const keep = (n: number | undefined): number | undefined =>
    typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
  const out: Partial<AgentLimits> = {};
  const maxTurns = keep(limits?.maxTurns);
  if (maxTurns !== undefined) out.maxTurns = maxTurns;
  const maxWallMs = keep(limits?.maxWallMs);
  if (maxWallMs !== undefined) out.maxWallMs = maxWallMs;
  return out;
}

/**
 * SHA-256 hex digest of the canonical request — the deterministic key for the
 * subagent's single cached terminal result. The raw (pre-validation) request is
 * fingerprinted, so the key matches exactly what the parent re-sends on retry.
 */
export async function fingerprintRequest(
  request: RecipeExecutionRequest
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRequest(request));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
