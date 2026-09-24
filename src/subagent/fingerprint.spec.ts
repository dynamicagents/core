import { describe, it, expect } from "vitest";
import {
  canonicalRequest,
  fingerprintRequest,
  FINGERPRINT_VERSION
} from "./fingerprint.js";
import { DEFAULT_CORE_CONFIG } from "../config.js";
import type { RecipeExecutionRequest } from "../subtasks/types.js";
import type { ResolvedRecipe } from "../contract/recipe.js";

/**
 * The fingerprint is the subagent's cache key *and* its resume key: a retry with
 * the same fingerprint replays a terminal result or resumes a partial run, and a
 * different one is treated as different work.
 *
 * That makes stability under *irrelevant* change the whole property. The specific
 * hazard this file was rewritten to avoid: the predecessor merged a recipe's
 * declared limits against the house baseline before hashing, which is defensible
 * until the baseline ships in a versioned npm package — at which point a patch
 * release nudging a default silently re-keys every in-flight run, and each one
 * restarts from turn zero having already spent its budget.
 */

const recipe = (over: Partial<ResolvedRecipe> = {}): ResolvedRecipe => ({
  key: "r",
  version: 1,
  soul: "you are a subagent",
  toolFamilies: ["workspace"],
  enabled: true,
  limits: {},
  historyWindow: 10,
  reportMetrics: false,
  ...over
});

const request = (
  over: Partial<RecipeExecutionRequest> = {}
): RecipeExecutionRequest => ({
  taskId: "t1",
  subtaskId: 1,
  type: "generic",
  recipe: recipe(),
  prompt: "do the thing",
  references: [],
  params: {},
  ...over
});

describe("what must NOT change the fingerprint", () => {
  it("is unaffected by the host's baseline limits moving", () => {
    // The landmine. `limits: {}` means "inherit the baseline", and it has to
    // hash the same whatever the baseline currently is — otherwise publishing a
    // patch of @dynamicagents/core strands every in-flight subagent run.
    const withEmptyLimits = request({ recipe: recipe({ limits: {} }) });
    const before = canonicalRequest(withEmptyLimits);

    // Whatever the baseline is, it is not an input here.
    expect(before).not.toContain(
      String(DEFAULT_CORE_CONFIG.subagentLimits.maxTurns)
    );
    expect(before).toContain('"limits":{}');
  });

  it("normalizes limits that resolveLimits would ignore anyway", () => {
    // `{}`, a zero, and a fraction all mean "inherit" — so they must hash alike
    // rather than minting three cache entries for one execution.
    const base = canonicalRequest(request({ recipe: recipe({ limits: {} }) }));

    expect(
      canonicalRequest(request({ recipe: recipe({ limits: { maxTurns: 0 } }) }))
    ).toBe(base);
    expect(
      canonicalRequest(
        request({ recipe: recipe({ limits: { maxTurns: 1.5 } }) })
      )
    ).toBe(base);
    expect(
      canonicalRequest(
        request({ recipe: recipe({ limits: { maxTurns: -3 } }) })
      )
    ).toBe(base);
  });

  it("is unaffected by the key order of params", async () => {
    const a = request({ params: { gameId: "g", cardId: "c" } });
    const b = request({ params: { cardId: "c", gameId: "g" } });

    expect(canonicalRequest(a)).toBe(canonicalRequest(b));
    expect(await fingerprintRequest(a)).toBe(await fingerprintRequest(b));
  });

  it("ignores fields outside the declared identity", async () => {
    // Anything not named in `canonicalRequest` is not identity — an extra
    // property riding along must not re-key the execution.
    const withExtra = {
      ...request(),
      runtime: { leasedSession: "s-1" }
    } as RecipeExecutionRequest;

    expect(await fingerprintRequest(withExtra)).toBe(
      await fingerprintRequest(request())
    );
  });
});

describe("what MUST change the fingerprint", () => {
  const base = () => fingerprintRequest(request());

  it("treats params as identity", async () => {
    // The same prompt against a different external resource is different work,
    // and must not replay a cached result.
    expect(
      await fingerprintRequest(request({ params: { gameId: "g1" } }))
    ).not.toBe(await base());
    expect(
      await fingerprintRequest(request({ params: { gameId: "g1" } }))
    ).not.toBe(await fingerprintRequest(request({ params: { gameId: "g2" } })));
  });

  it("separates a genuinely different budget", async () => {
    expect(
      await fingerprintRequest(
        request({ recipe: recipe({ limits: { maxTurns: 5 } }) })
      )
    ).not.toBe(await base());
  });

  it("separates a changed prompt, soul, tool set or recipe version", async () => {
    // Note what is *not* here: the model pair. A recipe cannot state one, and
    // the host's is deliberately outside the fingerprint — see
    // `canonicalRequest`. Changing your configured models does not restart every
    // in-flight run from turn zero with its budget already spent.
    const differs = await Promise.all([
      fingerprintRequest(request({ prompt: "something else" })),
      fingerprintRequest(request({ recipe: recipe({ soul: "different" }) })),
      fingerprintRequest(
        request({ recipe: recipe({ toolFamilies: ["something-else"] }) })
      ),
      fingerprintRequest(request({ recipe: recipe({ version: 2 }) }))
    ]);

    const original = await base();
    for (const hash of differs) expect(hash).not.toBe(original);
    expect(new Set(differs).size).toBe(differs.length);
  });

  it("preserves semantic array order", async () => {
    // References are built from ordinal-ordered rows, so order is meaning, not
    // incidental.
    const refs = [
      { role: "user" as const, text: "one" },
      { role: "user" as const, text: "two" }
    ];

    expect(await fingerprintRequest(request({ references: refs }))).not.toBe(
      await fingerprintRequest(request({ references: [...refs].reverse() }))
    );
  });

  it("is invalidated deliberately by the format version", () => {
    // The lever that replaces the accidental invalidation the merge used to
    // cause. It is in the hashed payload, so bumping it re-keys everything.
    expect(canonicalRequest(request())).toContain(`"v":${FINGERPRINT_VERSION}`);
  });
});

describe("the digest itself", () => {
  it("is a stable lowercase SHA-256 hex string", async () => {
    const hash = await fingerprintRequest(request());

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprintRequest(request())).toBe(hash);
  });
});
