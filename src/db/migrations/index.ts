/**
 * Drizzle migrations, inlined for Cloudflare Workers.
 *
 * GENERATED FILE — do not edit. Run `npm run db:generate` after changing
 * `src/db/schema.ts`; that runs `drizzle-kit generate` and then
 * `scripts/build-migrations.mjs`, which rebuilds this from
 * `meta/_journal.json` and the `.sql` files beside it.
 *
 * Key format: "m{zero-padded idx}" — what drizzle's durable-sqlite migrator
 * reads from `config.migrations[key]`.
 *
 * This journal is CORE's alone. A plugin must never add an entry: the journal is
 * a flat integer sequence over one shared `__drizzle_migrations` table, and two
 * independently-versioned packages writing to it will collide. Plugins own their
 * tables through `PluginStore` instead — see `src/db/db.ts`.
 */
import type { migrate } from "drizzle-orm/durable-sqlite/migrator";

type MigrationConfig = Parameters<typeof migrate>[1];

const dbMigrations: MigrationConfig = {
  journal: {
    entries: [
      {
        idx: 0,
        when: 1785537420937,
        tag: "0000_init",
        breakpoints: true
      },
      {
        idx: 1,
        when: 1786871925215,
        tag: "0001_drop_depends_on",
        breakpoints: true
      },
      {
        idx: 2,
        when: 1788817590937,
        tag: "0002_round_observations",
        breakpoints: true
      },
      {
        idx: 3,
        when: 1789148198330,
        tag: "0003_human_requests",
        breakpoints: true
      },
      {
        idx: 4,
        when: 1789150136450,
        tag: "0004_approval_exchanges",
        breakpoints: true
      }
    ]
  },
  migrations: {
    m0000: `CREATE TABLE \`notify_tasks\` (
	\`task_id\` text PRIMARY KEY NOT NULL,
	\`message_id\` text,
	\`context_id\` text DEFAULT '' NOT NULL,
	\`state\` text NOT NULL,
	\`task_json\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`notify_tasks_message_id_unique\` ON \`notify_tasks\` (\`message_id\`);--> statement-breakpoint
CREATE INDEX \`idx_notify_tasks_created_at\` ON \`notify_tasks\` (\`created_at\`);--> statement-breakpoint
CREATE INDEX \`idx_notify_tasks_context\` ON \`notify_tasks\` (\`context_id\`);--> statement-breakpoint
CREATE INDEX \`idx_notify_tasks_state\` ON \`notify_tasks\` (\`state\`);--> statement-breakpoint
CREATE TABLE \`subtasks\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`task_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`ordinal\` integer NOT NULL,
	\`type\` text NOT NULL,
	\`recipe_id\` text,
	\`recipe_version\` integer,
	\`prompt\` text NOT NULL,
	\`references_json\` text NOT NULL,
	\`depends_on_json\` text NOT NULL,
	\`params_json\` text DEFAULT '{}' NOT NULL,
	\`status\` text NOT NULL,
	\`result_parts_json\` text,
	\`error\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`completed_at\` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`idx_subtasks_task_ordinal\` ON \`subtasks\` (\`task_id\`,\`ordinal\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_task_round\` ON \`subtasks\` (\`task_id\`,\`round\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_status\` ON \`subtasks\` (\`status\`);--> statement-breakpoint
CREATE INDEX \`idx_subtasks_created_at\` ON \`subtasks\` (\`created_at\`);`,
    m0001: `ALTER TABLE \`subtasks\` DROP COLUMN \`depends_on_json\`;`,
    m0002: `CREATE TABLE \`round_observations\` (
	\`task_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`messages_json\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	PRIMARY KEY(\`task_id\`, \`round\`)
);
--> statement-breakpoint
CREATE INDEX \`idx_round_observations_created_at\` ON \`round_observations\` (\`created_at\`);`,
    m0003: `CREATE TABLE \`human_requests\` (
	\`request_id\` text PRIMARY KEY NOT NULL,
	\`task_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`request_json\` text NOT NULL,
	\`status\` text NOT NULL,
	\`answer_json\` text,
	\`answer_message_id\` text,
	\`parked_at\` integer,
	\`closed_at\` integer,
	\`created_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`idx_human_requests_task_round\` ON \`human_requests\` (\`task_id\`,\`round\`);--> statement-breakpoint
CREATE INDEX \`idx_human_requests_created_at\` ON \`human_requests\` (\`created_at\`);`,
    m0004: `ALTER TABLE \`human_requests\` ADD \`pending_json\` text;--> statement-breakpoint
ALTER TABLE \`human_requests\` ADD \`results_json\` text;`
  }
};

export default dbMigrations;
