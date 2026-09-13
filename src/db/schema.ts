import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

/**
 * Core's tables. All live in the caller's agent DO SQLite
 * (`this.ctx.storage`), so a row is unreachable from any other caller by
 * construction.
 *
 * A plugin's tables are **not** here and never will be: drizzle's durable-sqlite
 * migrator keeps one flat integer journal and one global `__drizzle_migrations`
 * table, which independently-versioned packages cannot share. Plugins own their
 * storage through `PluginStore` — idempotent `CREATE TABLE IF NOT EXISTS` plus
 * their own version bookkeeping, outside this journal entirely. See
 * {@link file://./db.ts}.
 *
 * Indexes are declared in each table's config callback rather than as standalone
 * `index(...)` exports: only the callback form is recorded in the drizzle-kit
 * snapshot, so the standalone form makes every later `generate` diff propose
 * dropping the index it can no longer see.
 */

/**
 * Durable state for async A2A tasks (the accept + notify lifecycle).
 *
 * One row per task: written by the Worker's accept path (`beginTask`, keyed by
 * `message_id` for gatekeeper dedupe) and mutated by the turn workflow via DO RPC
 * (`markWorking`, `saveTask`, `cancelTask`). `GetTask` / `ListTasks` read it
 * through `DurableTaskStore`.
 */
export const notifyTasks = sqliteTable(
  "notify_tasks",
  {
    taskId: text("task_id").primaryKey(),
    /** Gatekeeper-assigned dedupe key — null for tasks created outside `beginTask`. */
    messageId: text("message_id").unique(),
    /** A2A context id, denormalized out of `task_json` so `ListTasks` can filter on it. */
    contextId: text("context_id").notNull().default(""),
    /** Human-readable `TaskState` (`working`, `input-required`, …) — see `taskStateLabel`. */
    state: text("state").notNull(),
    /**
     * The task in its **A2A wire form** (`Task.toJSON`), not the in-memory proto
     * object. Storing the wire form means what is on disk is exactly what goes
     * on the wire, and both survive a change to the SDK's class shape;
     * `JSON.stringify(task)` would persist in-memory internals instead.
     */
    taskJson: text("task_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    index("idx_notify_tasks_created_at").on(table.createdAt),
    index("idx_notify_tasks_context").on(table.contextId),
    index("idx_notify_tasks_state").on(table.state)
  ]
);

/**
 * Durable subtasks: the units a parent A2A task is decomposed into.
 *
 * The integer primary key assigns a caller-local, monotonically increasing
 * `SubtaskId` (autoincrement, so ids are never reused after cleanup deletes
 * rows). References and result parts are stored as JSON text and parsed back
 * into the `Subtask` contract by `models/subtasks.ts`.
 * `recipe_id`/`recipe_version` are null until execution starts, then record the
 * resolved recipe after the fact.
 */
export const subtasks = sqliteTable(
  "subtasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    /** Main-agent round that delegated this subtask (0-based). */
    round: integer("round").notNull(),
    /** Position within the parent task, increasing across every round. */
    ordinal: integer("ordinal").notNull(),
    type: text("type").notNull(),
    /** Resolved recipe key, written only at execution start. */
    recipeId: text("recipe_id"),
    /** Resolved recipe version, written only at execution start. */
    recipeVersion: integer("recipe_version"),
    prompt: text("prompt").notNull(),
    /** JSON `SubtaskReference[]` — verbatim role+text snapshots from decomposition. */
    referencesJson: text("references_json").notNull(),
    /** JSON `SubtaskParams` — the type's required inputs, validated at delegation. */
    paramsJson: text("params_json").notNull().default("{}"),
    status: text("status").notNull(),
    /** JSON `SubtaskResultPart[]` — text-only terminal output; null until complete. */
    resultPartsJson: text("result_parts_json"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at")
  },
  (table) => [
    uniqueIndex("idx_subtasks_task_ordinal").on(table.taskId, table.ordinal),
    index("idx_subtasks_task_round").on(table.taskId, table.round),
    index("idx_subtasks_status").on(table.status),
    index("idx_subtasks_created_at").on(table.createdAt)
  ]
);

/**
 * What each round saw: the work-tool calls it made and what came back.
 *
 * One row per `(task_id, round)`, holding the round's exchanges as the AI SDK's
 * `ModelMessage[]` in JSON. Written by the delegating path of a round and read
 * by the rounds after it, which restore the calls as the pairs they were — the
 * same reconstruction `subtasks` already backs for the `delegate` call itself.
 *
 * Durable rather than in-memory because the reader is a *different* Workflow
 * step, often minutes later, and a Durable Object can be evicted or reset
 * between two rounds of one task. Rows rather than Session messages because
 * history is text-only and stays that way.
 *
 * A composite primary key, so a re-run of `turn:<round>` overwrites its own row
 * instead of appending a second copy of a round that happened once.
 */
export const roundObservations = sqliteTable(
  "round_observations",
  {
    taskId: text("task_id").notNull(),
    /** Main-agent round that made these calls (0-based). */
    round: integer("round").notNull(),
    /** JSON `ModelMessage[]` — already paired, re-identified and bounded. */
    messagesJson: text("messages_json").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.round] }),
    index("idx_round_observations_created_at").on(table.createdAt)
  ]
);

/**
 * A question a round put to the person the Task is for, and what came back.
 *
 * One row per `(task_id, round)`, because asking ends the round that asks. It is
 * written when the round decides to ask, stamped when the question is posted, and
 * closed by whichever of an answer, an expiry or a cancel lands first — every
 * transition out of `awaiting` is guarded on it, so the others find it closed.
 *
 * Here rather than on the Workflow event, because the event only wakes the run.
 * A gatekeeper may deliver the same answer twice, and a wake could be lost, so
 * this row is the one place that says what the answer was.
 */
export const humanRequests = sqliteTable(
  "human_requests",
  {
    /** The gatekeeper's correlation key too: its answer names this id. */
    requestId: text("request_id").primaryKey(),
    taskId: text("task_id").notNull(),
    /** Main-agent round that asked (0-based). */
    round: integer("round").notNull(),
    /** JSON `HitlRequestData` — exactly what the person is shown. */
    requestJson: text("request_json").notNull(),
    /** `awaiting` until an answer, an expiry or a cancel closes it. */
    status: text("status").notNull(),
    /** JSON of the answer as the gatekeeper sent it; null until answered. */
    answerJson: text("answer_json"),
    /** The message that answered, so its retry is known for the same one. */
    answerMessageId: text("answer_message_id"),
    /** When the question was posted: where the uncharged wait begins. */
    parkedAt: integer("parked_at"),
    /** When an answer or an expiry closed it. */
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("idx_human_requests_task_round").on(table.taskId, table.round),
    index("idx_human_requests_created_at").on(table.createdAt)
  ]
);
