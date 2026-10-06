import { describe, it, expect, vi } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Artifacts } from "./do.js";
import {
  ArtifactMediaTooLargeError,
  ArtifactMediaTypeError,
  MAX_ARTIFACT_MEDIA_BYTES
} from "./media.js";
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

/** A PNG as far as the signature check is concerned, which is far enough. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02
]);

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
   * The step that adds media, against a store the way version 3 left it: a card
   * written before images existed keeps its card, an entry written then reads
   * back with no descriptor, and an image is filed beside both afterwards.
   *
   * Versions 2 and 3's own `ALTER TABLE`s are spelled here because a store in
   * that shape is not something this build can produce — {@link upgrade} runs
   * every branch below the target, so asking for target 3 with the real steps
   * would add the media columns too and then the step under test would meet
   * them.
   */
  it("brings a version 3 store up to media, keeping the cards on it", async () => {
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
      sql.exec(
        `INSERT INTO artifact_entries
           (token, sequence, entry_key, label, body, created_at, detail)
         VALUES ('old', 1, NULL, 'a 0', 'written before images', 1000,
                 '{"title":"Bash","status":"ok"}')`
      );

      const store = makeArtifactStore(sql, () => 1_000);
      const before = store.entries("old");
      const appended = store.append("old", {
        label: "a 0",
        text: "a chart",
        media: { type: "image/png", data: PNG }
      });
      return {
        version: recorded(sql),
        before,
        appended: appended?.entry,
        after: store.entries("old"),
        bytes: store.media("old", 2)
      };
    });
    expect(found.version).toBe(CURRENT_SCHEMA_VERSION);
    // The card the v3 store wrote survives the step, and carries no media.
    expect(found.before).toEqual([
      {
        sequence: 1,
        label: "a 0",
        text: "written before images",
        at: 1000,
        detail: { title: "Bash", status: "ok" }
      }
    ]);
    expect(found.appended?.media).toEqual({
      type: "image/png",
      byteLength: PNG.byteLength
    });
    expect(found.after.map((entry) => entry.media?.type)).toEqual([
      undefined,
      "image/png"
    ]);
    expect(found.bytes?.type).toBe("image/png");
    expect(new Uint8Array(found.bytes!.data)).toEqual(PNG);
  });
});

/**
 * The refusals, as the classes they are.
 *
 * Only in here: a throw crossing Durable Object RPC keeps its message and loses
 * its class, so the object's spec asserts the sentence and this one asserts the
 * type — which is what a caller inside the Worker can actually catch.
 */
describe("appending media the store refuses", () => {
  const append = (store: ReturnType<typeof makeArtifactStore>, token: string) =>
    store.append(token, {
      label: "a 0",
      text: "a chart",
      media: { type: "image/png", data: new Uint8Array([0xff, 0xd8, 0xff]) }
    });

  it("throws the type error for bytes that are not what they claim", async () => {
    const thrown = await withSql("media-type", (sql) => {
      const store = makeArtifactStore(sql, () => 1_000);
      const token = store.open("kind");
      try {
        append(store, token);
        return null;
      } catch (error) {
        return {
          isTypeError: error instanceof ArtifactMediaTypeError,
          entries: store.entries(token).length
        };
      }
    });
    expect(thrown?.isTypeError).toBe(true);
    // Nothing partial: the check runs before either insert.
    expect(thrown?.entries).toBe(0);
  });

  it("throws the size error past the limit, and files no bytes", async () => {
    const thrown = await withSql("media-size", (sql) => {
      const store = makeArtifactStore(sql, () => 1_000);
      const token = store.open("kind");
      const huge = new Uint8Array(MAX_ARTIFACT_MEDIA_BYTES + 1);
      huge.set(PNG.subarray(0, 8));
      try {
        store.append(token, {
          label: "a 0",
          text: "a chart",
          media: { type: "image/png", data: huge }
        });
        return null;
      } catch (error) {
        return {
          isTooLarge: error instanceof ArtifactMediaTooLargeError,
          entries: store.entries(token).length,
          blobs: sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM artifact_entry_media"
            )
            .one().n
        };
      }
    });
    expect(thrown?.isTooLarge).toBe(true);
    expect(thrown?.entries).toBe(0);
    expect(thrown?.blobs).toBe(0);
  });
});

/**
 * The entry's row and its bytes are one write.
 *
 * The blob insert is the one statement in an append that can fail on its own, so
 * the fixture is a real collision: a media row already at the sequence the
 * append is about to allocate. Without the transaction the entry commits and its
 * bytes do not, which is worse than losing the note — the descriptor rides every
 * read of the log, so the viewer asks for a URL that 404s for the artifact's
 * life, and the keyed retry that repairs every other partial write finds the
 * entry already there and writes nothing.
 */
describe("appending an image whose bytes the blob table refuses", () => {
  const chart = { type: "image/png", data: PNG } as const;

  it("rolls the entry back with them, and a keyed retry writes both", async () => {
    const found = await runInDurableObject(
      ns.get(ns.idFromName(`store:media-rollback:${crypto.randomUUID()}`)),
      (_instance, state) => {
        const sql = state.storage.sql;
        const atomically = (fn: () => void): void => {
          state.storage.transactionSync(fn);
        };
        const store = makeArtifactStore(sql, () => 1_000, atomically);
        const token = store.open("kind");
        // The collision, on the sequence the first append will take.
        sql.exec(
          `INSERT INTO artifact_entry_media (token, sequence, bytes)
           VALUES (?, 1, ?)`,
          token,
          PNG.buffer
        );

        let thrown: unknown;
        try {
          store.append(token, {
            key: "plan:0",
            label: "a 0",
            text: "a chart",
            media: chart
          });
        } catch (error) {
          thrown = error;
        }
        const rolledBack = {
          thrown: thrown instanceof Error,
          entries: store.entries(token).length
        };

        // The fixture, removed: what is under test is the retry, not the
        // collision, and the caller retrying has no idea either happened.
        sql.exec("DELETE FROM artifact_entry_media WHERE token = ?", token);
        const retried = store.append(token, {
          key: "plan:0",
          label: "a 0",
          text: "a chart",
          media: chart
        });
        return {
          ...rolledBack,
          appended: retried?.appended,
          entry: retried?.entry,
          bytes: store.media(token, 1)
        };
      }
    );
    expect(found.thrown).toBe(true);
    // Nothing committed: no entry, and so no sequence spent either.
    expect(found.entries).toBe(0);
    expect(found.appended).toBe(true);
    expect(found.entry?.sequence).toBe(1);
    expect(found.entry?.media).toEqual({
      type: "image/png",
      byteLength: PNG.byteLength
    });
    expect(new Uint8Array(found.bytes!.data)).toEqual(PNG);
  });
});
