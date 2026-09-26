/**
 * The storage half of {@link file://./do.ts Artifacts} — the tables, the token,
 * and the retention sweep.
 *
 * Split from the Durable Object because the object's other half is a live
 * concern (who is watching which token, and what wakes them), and mixing a
 * broadcast registry into the query methods makes both harder to read than
 * either is alone. Everything here is synchronous: `ctx.storage.sql` is, so a
 * whole `open`-then-`append` runs without an await and no second RPC can
 * interleave with it.
 */

/**
 * How long an artifact is kept. The same clock the rest of a Task's durable
 * state ages out on — see `TASK_RETENTION_MS` in
 * {@link file://../think/tasks.ts A2ATasks}.
 */
export const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The token alphabet and length.
 *
 * The token is the artifact's id **and** its authorization: nothing else guards
 * a read, so it is minted from `crypto.getRandomValues` and derived from
 * nothing — not the task, not the kind, not a key. Sixty-two symbols over this
 * length is ~238 bits, which is not a number anybody has to tune; it is far
 * enough past guessing that the next question is never about the token.
 */
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN_LENGTH = 40;

/**
 * The largest multiple of the alphabet size that fits in a byte. A byte at or
 * above it is redrawn rather than folded, because `byte % 62` alone would make
 * the first eight symbols of the alphabet measurably likelier than the rest.
 */
const UNBIASED_CEILING = 248;

/** Mint one artifact token. See {@link ALPHABET} for what it is made of. */
export function mintArtifactToken(): string {
  let token = "";
  while (token.length < TOKEN_LENGTH) {
    const bytes = new Uint8Array(TOKEN_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (token.length === TOKEN_LENGTH) break;
      if (byte >= UNBIASED_CEILING) continue;
      token += ALPHABET[byte % ALPHABET.length];
    }
  }
  return token;
}

/** One append-only note on an artifact. */
export interface ArtifactEntry {
  /** 1-based position in the artifact, and the SSE event id. */
  sequence: number;
  /** Who wrote it, as the viewer prints it beside the text. */
  label: string;
  text: string;
  /** When it was recorded, in epoch milliseconds. */
  at: number;
}

/** An artifact's own row: what it is, and whether it has finished. */
export interface Artifact {
  token: string;
  kind: string;
  createdAt: number;
  /** The status it settled in, or `null` while it is still running. */
  status: string | null;
  /** Whether its link has been delivered — see {@link ArtifactStore.announce}. */
  announced: boolean;
}

/**
 * What an append did. `appended` is false for a replay an `entry.key` caught,
 * and the entry is then the one recorded the first time — which is what lets a
 * caller replay a post loop without telling every live reader twice.
 *
 * `announced` rides along because the writer branches on it for every note and
 * the row was read here anyway; see {@link ArtifactStore.announce}.
 */
export interface AppendResult {
  entry: ArtifactEntry;
  appended: boolean;
  announced: boolean;
}

/** What {@link ArtifactStore.append} is given. */
export interface ArtifactEntryInput {
  label: string;
  text: string;
  /**
   * A caller-side dedupe id, making the append idempotent.
   *
   * Both emission sites already hold one — the notification key, which the
   * gatekeeper dedupes replayed progress on and which is therefore derived from
   * position rather than from content or a clock. Reusing it here is what lets a
   * finished run replay its notes and leave the log as it found it: a note
   * recorded once, on the sequence it already had, rather than a second copy
   * beside it. See {@link file://../a2a/push.ts PushChannel.working}.
   */
  key?: string;
}

/**
 * ## Why this schema carries a version
 *
 * {@link file://./do.ts Artifacts} is addressed by a well-known name — one
 * instance per deployment — and, unlike an agent object, it survives a
 * deployment's fresh start. So its hand-written schema owes its own
 * bookkeeping — see {@link CURRENT_SCHEMA_VERSION}.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
     token TEXT PRIMARY KEY NOT NULL,
     kind TEXT NOT NULL,
     source_key TEXT,
     created_at INTEGER NOT NULL,
     settled_at INTEGER,
     status TEXT,
     announced_at INTEGER
   )`,
  // NULLs compare distinct in a SQLite unique index, so an artifact opened
  // without a key never collides with another one.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_kind_source_key
     ON artifacts (kind, source_key)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts (created_at)`,
  `CREATE TABLE IF NOT EXISTS artifact_entries (
     token TEXT NOT NULL,
     sequence INTEGER NOT NULL,
     entry_key TEXT,
     label TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (token, sequence)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_entries_key
     ON artifact_entries (token, entry_key)`
];

/**
 * The schema version this build writes, recorded in the `schema_meta` row.
 *
 * Bump it and add the matching step to {@link upgrade} in the same commit. What
 * the version buys is the branch: an artifact is kept for
 * {@link ARTIFACT_RETENTION_MS}, so a deployment changing shape meets months of
 * rows it cannot drop and has to know which shape they are in.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Move a store recorded at `from` up to the shape this build expects. */
export type SchemaUpgrade = (sql: SqlStorage, from: number) => void;

/**
 * Every change to the shape above, one `if (from < n)` per version, in order.
 *
 * {@link DDL} stays frozen at version 1, so a store that has never been opened
 * arrives here at 0 and runs every step. That is the rule that keeps the branch
 * honest: a column written into the `CREATE TABLE` *and* into a step is added
 * twice on a fresh store, and the `ALTER TABLE` is what fails.
 */
const upgrade: SchemaUpgrade = () => {
  // Version 1 is what the DDL creates, so there is nothing to move yet. The
  // first added column goes here as `if (from < 2) sql.exec("ALTER TABLE …")`.
};

/** Test seams for {@link ensureArtifactSchema}. */
export interface ArtifactSchemaOptions {
  /** The steps to run. Defaults to {@link upgrade}. */
  steps?: SchemaUpgrade;
  /** The version to end at. Defaults to {@link CURRENT_SCHEMA_VERSION}. */
  target?: number;
}

/**
 * Create the tables and bring a store below `target` up to it. Returns the
 * version found on disk — 0 for a store that has never been opened — so a
 * caller can tell an upgrade from a no-op.
 *
 * Runs on every construction of the store, and so on every wake-up: a store
 * already at `target` runs no step at all, which is what makes re-running this
 * free rather than merely safe.
 *
 * `steps` and `target` are parameters for the reason `now` is one in
 * {@link makeArtifactStore}: with a single version declared there is no upgrade
 * to exercise, and the branch the first added column will land on has to be
 * covered before somebody writes it.
 */
export function ensureArtifactSchema(
  sql: SqlStorage,
  {
    steps = upgrade,
    target = CURRENT_SCHEMA_VERSION
  }: ArtifactSchemaOptions = {}
): number {
  for (const statement of DDL) sql.exec(statement);
  const from =
    sql
      .exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1")
      .toArray()[0]?.version ?? 0;
  if (from === target) return from;
  // An older build writing its own number over a newer one would then re-run
  // the steps between them, against tables that already have what they add.
  if (from > target)
    throw new Error(
      `artifacts store is at schema version ${from} on disk but this build ` +
        `writes ${target} — downgrade is not supported`
    );
  steps(sql, from);
  sql.exec(
    `INSERT INTO schema_meta (id, version) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
    target
  );
  return from;
}

// Type aliases, not interfaces: `SqlStorage.exec` constrains its row type to
// `Record<string, SqlStorageValue>`, and only an alias of an object literal
// gets the implicit index signature that satisfies it.
type ArtifactRow = {
  token: string;
  kind: string;
  created_at: number;
  status: string | null;
  announced_at: number | null;
};

type EntryRow = {
  sequence: number;
  label: string;
  body: string;
  created_at: number;
};

export interface ArtifactStore {
  /**
   * The artifact `sourceKey` names under `kind`, opening one if there is none.
   *
   * Idempotent on the pair, which is the whole reason a caller passes a key: a
   * note arriving on a task that already has a transcript must find it rather
   * than start a second one, and no caller holds the token between turns.
   * Omitting the key opens a fresh artifact every call.
   */
  open(kind: string, sourceKey?: string): string;
  /** The token `sourceKey` names under `kind`, or `null`. Opens nothing. */
  tokenFor(kind: string, sourceKey: string): string | null;
  /** One artifact by token, or `null` when the token names nothing. */
  get(token: string): Artifact | null;
  /**
   * Append one note as recorded — or `null` when the token names nothing,
   * which includes an artifact this call's own sweep has just aged out. An
   * `entry.key` already recorded returns the note it wrote the first time and
   * writes nothing.
   *
   * Accepted after a settle too. Settling ends the *stream*, not the log: a
   * late note is a caller getting its own ordering wrong, and recording it is
   * better than dropping it, though no live reader will see it.
   */
  append(token: string, entry: ArtifactEntryInput): AppendResult | null;
  /**
   * Record that this artifact's link has been delivered. Returns whether it
   * applied — `false` for an unknown token and for one already announced, the
   * distinction {@link settle} draws for the same reason.
   *
   * The store does not know what a link is or who received it. What it keeps is
   * the one bit the writer cannot keep for itself: the isolate that posted the
   * link does not outlive the turn, and a writer that cannot tell "the thread
   * has the link" from "nobody ever managed to send it" either posts it again
   * forever or never posts it at all. See
   * {@link file://./transcript.ts transcribeNote} for the caller this exists
   * for.
   */
  announce(token: string): boolean;
  /**
   * Record the status this artifact finished in. Returns whether it applied —
   * `false` for an unknown token and for one already settled, so a caller can
   * tell the transition from a repeat of it.
   */
  settle(token: string, status: string): boolean;
  /** Notes after `afterSequence`, oldest first. Zero reads the whole log. */
  entries(token: string, afterSequence?: number): ArtifactEntry[];
  /** Delete every artifact past {@link ARTIFACT_RETENTION_MS}, and its notes. */
  sweep(): void;
}

/**
 * Bind the queries to one object's SQLite.
 *
 * `now` is a parameter so the retention sweep is testable without waiting a
 * month; production passes `Date.now`.
 */
export function makeArtifactStore(
  sql: SqlStorage,
  now: () => number
): ArtifactStore {
  ensureArtifactSchema(sql);

  const rowTo = (row: ArtifactRow): Artifact => ({
    token: row.token,
    kind: row.kind,
    createdAt: row.created_at,
    status: row.status,
    announced: row.announced_at !== null
  });

  const rowToEntry = (row: EntryRow): ArtifactEntry => ({
    sequence: row.sequence,
    label: row.label,
    text: row.body,
    at: row.created_at
  });

  const tokenFor = (kind: string, sourceKey: string): string | null =>
    sql
      .exec<{ token: string }>(
        "SELECT token FROM artifacts WHERE kind = ? AND source_key = ?",
        kind,
        sourceKey
      )
      .toArray()[0]?.token ?? null;

  const get = (token: string): Artifact | null => {
    const row = sql
      .exec<ArtifactRow>(
        `SELECT token, kind, created_at, status, announced_at
           FROM artifacts WHERE token = ?`,
        token
      )
      .toArray()[0];
    return row ? rowTo(row) : null;
  };

  // A `const`, not a method read off `this`: the store is handed around as a
  // value and a destructured method would sweep nothing, silently.
  const sweep = (): void => {
    const cutoff = now() - ARTIFACT_RETENTION_MS;
    sql.exec(
      `DELETE FROM artifact_entries WHERE token IN
         (SELECT token FROM artifacts WHERE created_at < ?)`,
      cutoff
    );
    sql.exec("DELETE FROM artifacts WHERE created_at < ?", cutoff);
  };

  return {
    tokenFor,
    get,
    sweep,

    open(kind, sourceKey) {
      // Before the write, never after: a sweep that ran last would be free to
      // delete the artifact this call just opened.
      sweep();
      if (sourceKey !== undefined) {
        const existing = tokenFor(kind, sourceKey);
        if (existing !== null) return existing;
      }
      const token = mintArtifactToken();
      sql.exec(
        `INSERT INTO artifacts (token, kind, source_key, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, source_key) DO NOTHING`,
        token,
        kind,
        sourceKey ?? null,
        now()
      );
      // The insert can have lost to a concurrent open on the same key, in which
      // case the token that won is the one every caller must be given.
      return sourceKey === undefined
        ? token
        : (tokenFor(kind, sourceKey) ?? token);
    },

    append(token, entry) {
      sweep();
      const artifact = get(token);
      if (artifact === null) return null;
      const announced = artifact.announced;
      if (entry.key !== undefined) {
        const prior = sql
          .exec<EntryRow>(
            `SELECT sequence, label, body, created_at FROM artifact_entries
             WHERE token = ? AND entry_key = ?`,
            token,
            entry.key
          )
          .toArray()[0];
        if (prior)
          return { entry: rowToEntry(prior), appended: false, announced };
      }
      const sequence =
        sql
          .exec<{ next: number }>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM artifact_entries WHERE token = ?",
            token
          )
          .toArray()[0]?.next ?? 1;
      const at = now();
      sql.exec(
        `INSERT INTO artifact_entries
           (token, sequence, entry_key, label, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        token,
        sequence,
        entry.key ?? null,
        entry.label,
        entry.text,
        at
      );
      return {
        entry: { sequence, label: entry.label, text: entry.text, at },
        appended: true,
        announced
      };
    },

    announce(token) {
      const artifact = get(token);
      if (artifact === null || artifact.announced) return false;
      sql.exec(
        "UPDATE artifacts SET announced_at = ? WHERE token = ?",
        now(),
        token
      );
      return true;
    },

    settle(token, status) {
      const artifact = get(token);
      if (artifact === null || artifact.status !== null) return false;
      sql.exec(
        "UPDATE artifacts SET status = ?, settled_at = ? WHERE token = ?",
        status,
        now(),
        token
      );
      return true;
    },

    entries(token, afterSequence = 0) {
      return sql
        .exec<EntryRow>(
          `SELECT sequence, label, body, created_at FROM artifact_entries
           WHERE token = ? AND sequence > ? ORDER BY sequence`,
          token,
          afterSequence
        )
        .toArray()
        .map(rowToEntry);
    }
  };
}
