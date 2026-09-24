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
 * state ages out on — see `cleanupOldTasks` in
 * {@link file://../host/agent.ts DynamicAgent}.
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
}

/**
 * What an append did. `appended` is false for a replay an `entry.key` caught,
 * and the entry is then the one recorded the first time — which is what lets a
 * caller replay a post loop without telling every live reader twice.
 */
export interface AppendResult {
  entry: ArtifactEntry;
  appended: boolean;
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
   * position rather than from content or a clock. Reusing it here is what lets
   * a Workflow step retry its post loop and land on the same sequence numbers,
   * which is in turn what makes "this note opened the artifact" a durable fact
   * instead of a race. See {@link file://../a2a/push.ts PushChannel.working}.
   */
  key?: string;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS artifacts (
     token TEXT PRIMARY KEY NOT NULL,
     kind TEXT NOT NULL,
     source_key TEXT,
     created_at INTEGER NOT NULL,
     settled_at INTEGER,
     status TEXT
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

// Type aliases, not interfaces: `SqlStorage.exec` constrains its row type to
// `Record<string, SqlStorageValue>`, and only an alias of an object literal
// gets the implicit index signature that satisfies it.
type ArtifactRow = {
  token: string;
  kind: string;
  created_at: number;
  status: string | null;
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
  for (const statement of DDL) sql.exec(statement);

  const rowTo = (row: ArtifactRow): Artifact => ({
    token: row.token,
    kind: row.kind,
    createdAt: row.created_at,
    status: row.status
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
        "SELECT token, kind, created_at, status FROM artifacts WHERE token = ?",
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
      if (get(token) === null) return null;
      if (entry.key !== undefined) {
        const prior = sql
          .exec<EntryRow>(
            `SELECT sequence, label, body, created_at FROM artifact_entries
             WHERE token = ? AND entry_key = ?`,
            token,
            entry.key
          )
          .toArray()[0];
        if (prior) return { entry: rowToEntry(prior), appended: false };
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
        appended: true
      };
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
