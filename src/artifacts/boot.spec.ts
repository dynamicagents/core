import { describe, it, expect } from "vitest";
// `env` from `cloudflare:workers`, not `cloudflare:test` — that one is
// deprecated and the type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { ArtifactsNotBoundError } from "./binding.js";

/**
 * The binding, checked where a missing one is still cheap to fix.
 *
 * `ARTIFACTS` is required, and the cost of requiring it is deciding *where* a
 * deployment that forgot finds out. The two answers are a writer part-way
 * through a round — which surfaces as a failed subtask naming a Durable Object
 * nobody wired — and DO start, which surfaces as the object refusing to start
 * and saying which lines are missing. This pins the second.
 *
 * Both seams, because they are two Durable Objects: a facet posts its own notes
 * on a path that never passes through its parent, so a check on the parent
 * alone leaves the object that does most of the writing unguarded.
 */

// Cast, as every spec here does: `worker-configuration.d.ts` is generated with
// `--include-env=false`, so this package's dev-only bindings are deliberately
// not on a global `Env` a consumer would inherit.
const namespaces = env as unknown as Record<string, DurableObjectNamespace>;

/** The `onStart` the SDK awaits before it dispatches any RPC. */
interface Bootable {
  env: unknown;
  onStart(): Promise<void>;
}

/** What `onStart` did, flattened so it can leave the object it happened in. */
interface Boot {
  named: boolean;
  message: string;
}

/**
 * Run `onStart` against an `env` the binding was stripped from.
 *
 * Stripped rather than declared absent, because that is the failure: the
 * generated `Env` claims `ARTIFACTS` from a `wrangler.jsonc` that no longer
 * declares it, so the type is satisfied and only the runtime read is not.
 *
 * The throw is caught *inside* the object and returned as data. A rejected
 * promise carries I/O created in that object's context, and workerd refuses to
 * let another one touch it — so an error assertion that crossed the boundary
 * would report that refusal instead of whatever `onStart` actually did.
 */
async function bootWithout(binding: string, name: string): Promise<Boot> {
  const ns = namespaces[binding]!;
  const stub = ns.get(ns.idFromName(`boot:${name}:${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (raw) => {
    const instance = raw as unknown as Bootable;
    const original = instance.env;
    const { ARTIFACTS: _stripped, ...rest } = original as Record<
      string,
      unknown
    >;
    instance.env = rest;
    try {
      await instance.onStart();
      return { named: false, message: "onStart resolved" };
    } catch (err) {
      return {
        named: err instanceof ArtifactsNotBoundError,
        message: (err as Error).message
      };
    } finally {
      instance.env = original;
    }
  });
}

describe("the artifacts binding at DO start", () => {
  it.each([
    ["DynamicAgent", "SETTLE_AGENT"],
    ["RecipeSubagentBase", "TEST_SUBAGENT"]
  ])("fails %s's onStart when nothing is bound", async (name, binding) => {
    expect(await bootWithout(binding, name)).toMatchObject({ named: true });
  });

  it("names the binding, the migration and the export in the message", async () => {
    // What a person has in front of them is a Durable Object that would not
    // start. The only useful thing to say then is which lines are missing and
    // which files they go in.
    const { message } = await bootWithout("SETTLE_AGENT", "message");
    expect(message).toMatch(/ARTIFACTS is not bound/);
    expect(message).toMatch(/durable_objects\.bindings/);
    expect(message).toMatch(/new_sqlite_classes/);
    expect(message).toMatch(/export \{ Artifacts \}/);
  });

  it.each([
    ["DynamicAgent", "SETTLE_AGENT"],
    ["RecipeSubagentBase", "TEST_SUBAGENT"]
  ])("lets %s start on an env that has it", async (_name, binding) => {
    // The other half of the check: an assertion that fires on the wired case
    // too would be indistinguishable from one that is simply broken.
    const ns = namespaces[binding]!;
    const stub = ns.get(ns.idFromName(`boot:ok:${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (raw) => {
      await expect(
        (raw as unknown as Bootable).onStart()
      ).resolves.toBeUndefined();
    });
  });
});
