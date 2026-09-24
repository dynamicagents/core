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
    // A version past the current one, so this case keeps testing the branch
    // rather than the number the build happens to be at.
    const next = CURRENT_SCHEMA_VERSION + 1;
    const found = await withSql("upgrade", (sql) => {
      // A store at the current version, the way production leaves one.
      makeArtifactStore(sql, () => 1_000);
      const steps = vi.fn((db: SqlStorage, from: number) => {
        if (from < next) db.exec("ALTER TABLE artifacts ADD COLUMN trial TEXT");
      });
      ensureArtifactSchema(sql, { steps, target: next });
      const afterUpgrade = recorded(sql);
      // And again, as a wake-up would: the `ALTER TABLE` is what throws if the
      // recorded version failed to hold the step back.
      ensureArtifactSchema(sql, { steps, target: next });
      return {
        calls: steps.mock.calls.map(([, from]) => from),
        afterUpgrade,
        version: recorded(sql),
        column: sql.exec("SELECT trial FROM artifacts").toArray()
      };
    });
    expect(found.calls).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(found.afterUpgrade).toBe(next);
    expect(found.version).toBe(next);
    expect(found.column).toEqual([]);
  });

  /**
   * The first column the steps actually added, against the store shape that
   * predates it. A display name is recorded with the artifact rather than
   * resolved when a page opens — see {@link file://./kind.ts ArtifactKind} —
   * so every row written before this ran has none, and keeps none.
   */
  it("gives a store written before kinds carried a name the column", async () => {
    const found = await withSql("display-name", (sql) => {
      // Version 1: the tables the DDL creates, and nothing the steps have added.
      ensureArtifactSchema(sql, { steps: () => {}, target: 1 });
      // An artifact that build left behind, and retention will keep for a month.
      sql.exec(
        `INSERT INTO artifacts (token, kind, source_key, created_at)
         VALUES ('older', 'review-log', 'old', 1000)`
      );

      const store = makeArtifactStore(sql, () => 1_000);
      const named = store.open(
        { id: "review-log", displayName: "Review Log" },
        "new"
      );
      // A second construction, as a wake-up is: the `ALTER TABLE` is what
      // throws if the recorded version failed to hold the step back.
      makeArtifactStore(sql, () => 1_000);
      return {
        version: recorded(sql),
        older: store.get("older"),
        named: store.get(named)?.displayName
      };
    });
    expect(found.version).toBe(CURRENT_SCHEMA_VERSION);
    // Still there, and still readable — with no name, which is what the page
    // falls back on the kind for.
    expect(found.older).toMatchObject({
      kind: "review-log",
      displayName: null
    });
    expect(found.named).toBe("Review Log");
  });

  it("gives a store that has never been opened every step from zero", async () => {
    const found = await withSql("from-zero", (sql) => {
      const steps = vi.fn();
      const from = ensureArtifactSchema(sql, {
        steps,
        target: CURRENT_SCHEMA_VERSION + 1
      });
      return { from, calls: steps.mock.calls.map(([, at]) => at) };
    });
    expect(found.from).toBe(0);
    expect(found.calls).toEqual([0]);
  });

  it("refuses a database written by a newer build", async () => {
    const newer = CURRENT_SCHEMA_VERSION + 1;
    const thrown = await withSql("downgrade", (sql) => {
      ensureArtifactSchema(sql, { steps: () => {}, target: newer });
      try {
        ensureArtifactSchema(sql);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(thrown).toMatch(
      new RegExp(`schema version ${newer} .* downgrade is not supported`)
    );
  });
});
