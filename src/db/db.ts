import {
  drizzle,
  type DrizzleSqliteDODatabase
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import * as schema from "./schema.js";
import dbMigrations from "./migrations/index.js";
import { makeTasks } from "./models/tasks.js";
import { makeSubtasks } from "./models/subtasks.js";
import { makeObservations } from "./models/observations.js";

export type DB = DrizzleSqliteDODatabase<typeof schema>;

/**
 * A table owner outside core's migration journal.
 *
 * What a plugin cannot share is the **migrator**. `drizzle-orm/durable-sqlite/
 * migrator` keeps one flat integer journal and one global
 * `__drizzle_migrations` table, and two independently-versioned npm packages
 * cannot share that index space — not hypothetically: the two predecessor
 * agents, both consuming the same `notify_tasks` module, had already forked the
 * journal at index 1 (`0001_unusual_nova` vs `0001_great_goliath`). Worse,
 * `drizzle-kit generate` diffs against a snapshot in one output directory, so a
 * plugin shipping from its own repo cannot produce a correct diff at all.
 *
 * **The query builder is a different thing entirely, and a plugin should use
 * it.** `drizzle(storage, { schema })` is a typed wrapper over the same
 * `DurableObjectStorage`; it holds no journal, no connection, and no state that
 * a second handle could disturb. So the rule is narrow — *never import the
 * migrator* — rather than "no drizzle".
 *
 * A plugin therefore does three things: declares its tables with `sqliteTable`
 * as usual, emits idempotent DDL here, and queries through its own drizzle
 * handle. Version bookkeeping lives in the {@link PLUGIN_MIGRATIONS_TABLE} row
 * this class manages for it. Only the DDL is hand-written, and that pattern is
 * not novel here — it is what the subagent facet already does for its own two
 * tables.
 *
 * ```ts
 * // schema.ts — an ordinary drizzle table, under the plugin's own prefix.
 * export const arcScorecards = sqliteTable("arc_scorecards", {
 *   cardId: text("card_id").primaryKey(),
 *   lastUsedAt: integer("last_used_at").notNull()
 * });
 *
 * // The DDL half: idempotent, re-run on every hibernation wake-up.
 * const store: PluginStore = {
 *   plugin: "arc-agi",
 *   version: 2,
 *   ensureTables(sql, from) {
 *     sql.exec(`CREATE TABLE IF NOT EXISTS arc_scorecards (…)`);
 *     if (from < 2) sql.exec(`ALTER TABLE arc_scorecards ADD COLUMN …`);
 *   }
 * };
 *
 * // The query half: drizzle, over the plugin's own handle.
 * const db = drizzle(storage, { schema: { arcScorecards } });
 * db.select().from(arcScorecards).where(gte(arcScorecards.lastUsedAt, since));
 * ```
 */
export interface PluginStore {
  /** Stable identifier. Also the bookkeeping row's key — never rename it. */
  plugin: string;
  /**
   * Monotonically increasing schema version, starting at 1. Bump it whenever
   * {@link ensureTables} needs to do something it did not do before.
   */
  version: number;
  /**
   * Bring this plugin's tables up to {@link version}.
   *
   * Called once per DO instance, and re-called on every hibernation wake-up, so
   * it **must be idempotent**. `from` is the version last recorded for this
   * plugin (0 on first ever run), which is what lets an upgrade path branch
   * without re-running earlier DDL.
   */
  ensureTables(sql: SqlStorage, from: number): void;
}

/** Bookkeeping for {@link PluginStore} versions. Core owns the table; plugins own their rows. */
export const PLUGIN_MIGRATIONS_TABLE = "plugin_migrations";

export interface AgentDBOptions {
  /**
   * Plugin-owned stores to bring up alongside core's own tables. Order is
   * preserved but must not matter: a plugin that depends on another plugin's
   * table is a plugin that should have been one plugin.
   */
  stores?: readonly PluginStore[];
  /**
   * `CoreConfig.maxSubtasks` — the durable guard `createDecomposition` enforces.
   * Passed rather than imported so one resolved config governs both the schema
   * offered to the model and the write that has to hold.
   */
  maxSubtasks: number;
}

/**
 * The agent's database: one drizzle handle over the DO's SQLite, with a memoized
 * namespace per table domain (`db.tasks`, `db.subtasks`).
 *
 * Constructed once per DO instance. Core's migrations run in the constructor —
 * the durable-sqlite migrator is idempotent, so a fresh `AgentDB` on every
 * hibernation wake-up re-validates the schema safely. Call `ensureReady()` (and
 * await it) before issuing any queries.
 *
 * Plugin stores are brought up in the same place but through a different
 * mechanism, deliberately — see {@link PluginStore}.
 */
export class AgentDB {
  private readonly db: DB;
  private readonly _ready: Promise<void>;
  private _tasks?: ReturnType<typeof makeTasks>;
  private _subtasks?: ReturnType<typeof makeSubtasks>;
  private _observations?: ReturnType<typeof makeObservations>;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly options: AgentDBOptions
  ) {
    this.db = drizzle(storage, { schema });
    this._ready = migrate(this.db, dbMigrations).then(() => {
      this.applyStores(options.stores ?? []);
    });
  }

  ensureReady(): Promise<void> {
    return this._ready;
  }

  get tasks() {
    return (this._tasks ??= makeTasks(this.db));
  }

  get subtasks() {
    return (this._subtasks ??= makeSubtasks(this.db, {
      maxSubtasks: this.options.maxSubtasks
    }));
  }

  get observations() {
    return (this._observations ??= makeObservations(this.db));
  }

  /**
   * Run each plugin store's DDL and record its version, after core's own
   * migrations so a plugin may safely reference core tables (nothing should, but
   * the ordering is free and the alternative is a surprising failure).
   *
   * A store that throws fails DO start rather than being skipped: a plugin whose
   * tables are missing would otherwise fail later, at its first tool call, in a
   * request the user is waiting on.
   */
  private applyStores(stores: readonly PluginStore[]): void {
    if (stores.length === 0) return;
    const sql = this.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${PLUGIN_MIGRATIONS_TABLE} (
         plugin TEXT PRIMARY KEY,
         version INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    );

    const seen = new Set<string>();
    for (const store of stores) {
      if (seen.has(store.plugin)) {
        throw new Error(
          `duplicate PluginStore '${store.plugin}' — two plugins claim the same storage namespace`
        );
      }
      seen.add(store.plugin);

      if (!Number.isInteger(store.version) || store.version < 1) {
        throw new Error(
          `PluginStore '${store.plugin}' version must be an integer >= 1, got ${store.version}`
        );
      }

      const row = sql
        .exec<{ version: number }>(
          `SELECT version FROM ${PLUGIN_MIGRATIONS_TABLE} WHERE plugin = ?`,
          store.plugin
        )
        .toArray()[0];
      const from = row?.version ?? 0;
      if (from > store.version) {
        throw new Error(
          `PluginStore '${store.plugin}' is at version ${from} on disk but the ` +
            `installed plugin declares ${store.version} — downgrade is not supported`
        );
      }

      store.ensureTables(sql, from);

      if (from !== store.version) {
        sql.exec(
          `INSERT INTO ${PLUGIN_MIGRATIONS_TABLE} (plugin, version, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(plugin) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
          store.plugin,
          store.version,
          Date.now()
        );
      }
    }
  }
}
