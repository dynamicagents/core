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
import { makeHumanRequests } from "./models/human-requests.js";

export type DB = DrizzleSqliteDODatabase<typeof schema>;

export interface AgentDBOptions {
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
 * **One journal, and it is this class's.** `drizzle-orm/durable-sqlite/migrator`
 * keeps one flat integer journal and one global `__drizzle_migrations` table, and
 * two independently-versioned packages cannot share that index space — two
 * packages consuming one shared table module fork it at index 1. So anything
 * else that keeps tables in a Durable Object's SQLite — the subagent facet, the
 * artifacts object — writes idempotent DDL by hand and never imports the
 * migrator. The query builder is a different thing: `drizzle(storage, { schema })`
 * holds no journal and no state a second handle could disturb.
 */
export class AgentDB {
  private readonly db: DB;
  private readonly _ready: Promise<void>;
  private _tasks?: ReturnType<typeof makeTasks>;
  private _subtasks?: ReturnType<typeof makeSubtasks>;
  private _observations?: ReturnType<typeof makeObservations>;
  private _humanRequests?: ReturnType<typeof makeHumanRequests>;

  constructor(
    storage: DurableObjectStorage,
    private readonly options: AgentDBOptions
  ) {
    this.db = drizzle(storage, { schema });
    this._ready = migrate(this.db, dbMigrations);
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

  get humanRequests() {
    return (this._humanRequests ??= makeHumanRequests(this.db));
  }
}
