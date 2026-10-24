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
   * A step that throws after another has run. In one transaction, the earlier
   * `ALTER TABLE` is undone with it, and the retry runs both again rather than
   * failing on the column the first attempt left behind.
   */
  it("leaves nothing of an upgrade that failed, so a retry runs it whole", async () => {
    const next = CURRENT_SCHEMA_VERSION + 1;
    const found = await runInDurableObject(
      ns.get(ns.idFromName(`store:atomic:${crypto.randomUUID()}`)),
      (_instance, state) => {
        const sql = state.storage.sql;
        const atomically = (fn: () => void) =>
          state.storage.transactionSync(fn);
        makeArtifactStore(sql, () => 1_000);
        let broken = true;
        const steps = (db: SqlStorage, from: number) => {
          if (from < next) {
            db.exec("ALTER TABLE artifacts ADD COLUMN trial TEXT");
            if (broken) throw new Error("the next step failed");
          }
        };
        let thrown: string | undefined;
        try {
          ensureArtifactSchema(sql, { steps, target: next, atomically });
        } catch (error) {
          thrown = (error as Error).message;
        }
        const afterFailure = recorded(sql);
        broken = false;
        ensureArtifactSchema(sql, { steps, target: next, atomically });
        return { thrown, afterFailure, version: recorded(sql) };
      }
    );
    expect(found.thrown).toBe("the next step failed");
    expect(found.afterFailure).toBe(CURRENT_SCHEMA_VERSION);
    expect(found.version).toBe(next);
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

  /**
   * The real step, against a store the way version 1 left it: rows written
   * before `lock` existed read as unlocked, and take a lock.
   */
  it("brings a version 1 store up to `lock`, keeping its artifacts open", async () => {
    const found = await withSql("v1", (sql) => {
      ensureArtifactSchema(sql, { steps: () => {}, target: 1 });
      sql.exec(
        `INSERT INTO artifacts (token, kind, source_key, created_at)
         VALUES ('old', 'kind', NULL, 1000)`
      );
      const store = makeArtifactStore(sql, () => 1_000);
      const before = store.get("old");
      const locked = store.lock("old", "approved");
      return {
        version: recorded(sql),
        before,
        after: store.get("old"),
        locked
      };
    });
    expect(found.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(found.before?.locked).toBe(false);
    expect(found.locked).toBe(true);
    expect(found.after).toMatchObject({ locked: true, status: "approved" });
  });

  /**
   * The real step, against a store the way version 2 left it: an entry
   * written before cards existed reads back as plain text, and the next one
   * keeps its card.
   */
  it("brings a version 2 store up to cards, keeping its notes as text", async () => {
    const found = await withSql("v2", (sql) => {
      ensureArtifactSchema(sql, {
        steps: (db, from) => {
          if (from < 2)
            db.exec("ALTER TABLE artifacts ADD COLUMN locked_at INTEGER");
        },
        target: 2
      });
      sql.exec(
        `INSERT INTO artifacts (token, kind, source_key, created_at)
         VALUES ('old', 'kind', NULL, 1000)`
      );
      sql.exec(
        `INSERT INTO artifact_entries
           (token, sequence, entry_key, label, body, created_at)
         VALUES ('old', 1, 'k1', 'a 0', 'before', 1000)`
      );
      const store = makeArtifactStore(sql, () => 1_000);
      const card = {
        ref: "t1",
        status: "running" as const,
        title: "Bash",
        sections: [
          { label: "Input", body: "npm test", format: "code" as const }
        ]
      };
      store.append("old", {
        key: "k2",
        label: "a 0",
        text: "npm test",
        detail: card
      });
      const replayed = store.append("old", {
        key: "k2",
        label: "a 0",
        text: "npm test",
        detail: card
      });
      return {
        version: recorded(sql),
        entries: store.entries("old"),
        replayed: replayed?.entry
      };
    });
    expect(found.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(found.entries[0]).toEqual({
      sequence: 1,
      label: "a 0",
      text: "before",
      at: 1000
    });
    expect(found.entries[1]?.detail).toEqual({
      ref: "t1",
      status: "running",
      title: "Bash",
      sections: [{ label: "Input", body: "npm test", format: "code" }]
    });
    // A replay its key catches returns the card it wrote the first time.
    expect(found.replayed?.detail).toEqual(found.entries[1]?.detail);
  });

  /**
   * The real step, against a store the way version 3 left it: an artifact
   * opened before owners existed has none, and nothing asserting one may write
   * on it — which is the fail-closed half of the owner check, measured here
   * rather than argued.
   */
  it("brings a version 3 store up to owners, leaving its artifacts owned by nobody", async () => {
    const found = await withSql("v3", (sql) => {
      ensureArtifactSchema(sql, {
        steps: (db, from) => {
          if (from < 2)
            db.exec("ALTER TABLE artifacts ADD COLUMN locked_at INTEGER");
          if (from < 3)
            db.exec("ALTER TABLE artifact_entries ADD COLUMN detail TEXT");
        },
        target: 3
      });
      sql.exec(
        `INSERT INTO artifacts (token, kind, source_key, created_at)
         VALUES ('old', 'kind', NULL, 1000)`
      );
      const store = makeArtifactStore(sql, () => 1_000);
      return {
        version: recorded(sql),
        old: store.get("old"),
        asserted: store.append(
          "old",
          { label: "a 0", text: "mine now" },
          { owner: "custom:1:someone" }
        ),
        unasserted: store.append("old", { label: "a 0", text: "no claim" })
      };
    });
    expect(found.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(found.old?.owner).toBe(null);
    expect(found.asserted).toBe(null);
    // A writer that claims nothing writes as it always did: the column is what
    // a claim is checked against, not a permission every writer now needs.
    expect(found.unasserted?.appended).toBe(true);
  });
});

describe("an artifact's owner", () => {
  it("is recorded as the opener named it, and read back on the artifact", async () => {
    const found = await withSql("owner", (sql) => {
      const store = makeArtifactStore(sql, () => 1_000);
      const mine = store.open("plan", undefined, "custom:1:mine");
      const nobodys = store.open("plan");
      return { mine: store.get(mine), nobodys: store.get(nobodys) };
    });
    expect(found.mine?.owner).toBe("custom:1:mine");
    expect(found.nobodys?.owner).toBe(null);
  });

  /**
   * The key is what makes `open` idempotent, so a second caller naming the same
   * one is handed the artifact that exists. It does not inherit it: the owner
   * stays whoever opened it, and the second caller holds a token it cannot
   * write on.
   */
  it("stays the first opener's when a second open finds the same source key", async () => {
    const found = await withSql("owner-key", (sql) => {
      const store = makeArtifactStore(sql, () => 1_000);
      const first = store.open("plan", "task:run", "custom:1:first");
      const second = store.open("plan", "task:run", "custom:2:second");
      return {
        first,
        second,
        artifact: store.get(first),
        write: store.append(
          second,
          { label: "plan", text: "theirs" },
          { owner: "custom:2:second" }
        )
      };
    });
    expect(found.second).toBe(found.first);
    expect(found.artifact?.owner).toBe("custom:1:first");
    expect(found.write).toBe(null);
  });
});
