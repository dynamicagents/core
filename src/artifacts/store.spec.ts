import { describe, it, expect, vi } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Artifacts } from "./do.js";
import {
  CURRENT_SCHEMA_VERSION,
  ensureArtifactSchema,
  makeArtifactStore
} from "./store.js";

/**
 * The schema half of the store, against real SQLite.
 *
 * What is tested here is the bookkeeping rather than the queries — the notes,
 * the sweep and the token are the object's behaviour and
 * {@link file://./do.spec.ts do.spec.ts} drives them through it. A fake storage
 * could not carry this at all: an upgrade step is `ALTER TABLE`, and "the step
 * ran once" is SQLite refusing the second one.
 *
 * Each case takes a fresh object, so the database it opens has never been
 * written to and no teardown has to remember anything.
 */

// `wrangler types --include-env=false` leaves the ambient `Env` without the
// test worker's bindings, so they are reached by name — as the other DO specs
// reach theirs.
const ns = (env as unknown as Record<string, DurableObjectNamespace<Artifacts>>)
  .ARTIFACTS!;

/** A never-used object's own SQLite, which the store has not touched. */
const withSql = <R>(label: string, fn: (sql: SqlStorage) => R): Promise<R> =>
  runInDurableObject(
    ns.get(ns.idFromName(`store:${label}:${crypto.randomUUID()}`)),
    (_instance, state) => fn(state.storage.sql)
  );

const recorded = (sql: SqlStorage): number | null =>
  sql
    .exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1")
    .toArray()[0]?.version ?? null;

describe("the artifacts schema version", () => {
  it("records the current version when the store is first opened", async () => {
    const version = await withSql("fresh", (sql) => {
      makeArtifactStore(sql, () => 1_000);
      return recorded(sql);
    });
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("runs nothing on a store already at the version, and keeps its rows", async () => {
    const found = await withSql("reopen", (sql) => {
      const token = makeArtifactStore(sql, () => 1_000).open("kind", "key");
      const steps = vi.fn();
      // The wake-up path: a second construction on the same database.
      const from = ensureArtifactSchema(sql, { steps });
      return {
        from,
        steps: steps.mock.calls.length,
        version: recorded(sql),
        stillThere: makeArtifactStore(sql, () => 1_000).tokenFor("kind", "key"),
        token
      };
    });
    expect(found.from).toBe(CURRENT_SCHEMA_VERSION);
    expect(found.steps).toBe(0);
    expect(found.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(found.stillThere).toBe(found.token);
  });

  it("runs the steps a store recorded below the target has not had", async () => {
    const found = await withSql("upgrade", (sql) => {
      // A store at 1, the way production leaves one.
      makeArtifactStore(sql, () => 1_000);
      const steps = vi.fn((db: SqlStorage, from: number) => {
        if (from < 2) db.exec("ALTER TABLE artifacts ADD COLUMN trial TEXT");
      });
      ensureArtifactSchema(sql, { steps, target: 2 });
      const afterUpgrade = recorded(sql);
      // And again, as a wake-up would: the `ALTER TABLE` is what throws if the
      // recorded version failed to hold the step back.
      ensureArtifactSchema(sql, { steps, target: 2 });
      return {
        calls: steps.mock.calls.map(([, from]) => from),
        afterUpgrade,
        version: recorded(sql),
        column: sql.exec("SELECT trial FROM artifacts").toArray()
      };
    });
    expect(found.calls).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(found.afterUpgrade).toBe(2);
    expect(found.version).toBe(2);
    expect(found.column).toEqual([]);
  });

  it("gives a store that has never been opened every step from zero", async () => {
    const found = await withSql("from-zero", (sql) => {
      const steps = vi.fn();
      const from = ensureArtifactSchema(sql, { steps, target: 2 });
      return { from, calls: steps.mock.calls.map(([, at]) => at) };
    });
    expect(found.from).toBe(0);
    expect(found.calls).toEqual([0]);
  });

  it("refuses a database written by a newer build", async () => {
    const thrown = await withSql("downgrade", (sql) => {
      ensureArtifactSchema(sql, { steps: () => {}, target: 2 });
      try {
        ensureArtifactSchema(sql);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(thrown).toMatch(/schema version 2 .* downgrade is not supported/);
  });
});
