#!/usr/bin/env node
/**
 * Generate `src/db/migrations/index.ts` from the drizzle-kit output.
 *
 * Workers have no filesystem at runtime, so migration SQL cannot be read from
 * disk — it has to be inlined into the bundle. The predecessor repos did that by
 * hand ("copy the new .sql content here as m000N"), which is exactly the kind of
 * step that rots: one of them shipped a migration whose SQL had been hand-edited
 * into an invalid statement, and another had a journal entry whose `when` did not
 * match the file it named.
 *
 * So this reads `meta/_journal.json` as the source of truth, pairs each entry
 * with its `<tag>.sql`, and writes the module. Run it after every
 * `drizzle-kit generate`; `npm run db:generate` does both.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "src/db/migrations");

const journal = JSON.parse(
  readFileSync(join(DIR, "meta/_journal.json"), "utf8")
);
const sqlFiles = new Set(readdirSync(DIR).filter((f) => f.endsWith(".sql")));

const entries = [];
const bodies = [];

for (const entry of journal.entries) {
  const file = `${entry.tag}.sql`;
  if (!sqlFiles.has(file)) {
    console.error(
      `journal entry ${entry.idx} names ${file}, which does not exist in ${DIR}`
    );
    process.exit(1);
  }
  sqlFiles.delete(file);

  const key = `m${String(entry.idx).padStart(4, "0")}`;
  const sql = readFileSync(join(DIR, file), "utf8").trimEnd();
  // Backticks and `${` would terminate or interpolate the template literal.
  const escaped = sql
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  entries.push(
    `    {\n      idx: ${entry.idx},\n      when: ${entry.when},\n      tag: ${JSON.stringify(entry.tag)},\n      breakpoints: ${entry.breakpoints}\n    }`
  );
  bodies.push(`  ${key}: \`${escaped}\``);
}

if (sqlFiles.size > 0) {
  console.error(
    `unreferenced migration file(s): ${[...sqlFiles].join(", ")}. ` +
      "Every .sql file must have a journal entry — did drizzle-kit fail partway?"
  );
  process.exit(1);
}

const out = `/**
 * Drizzle migrations, inlined for Cloudflare Workers.
 *
 * GENERATED FILE — do not edit. Run \`npm run db:generate\` after changing
 * \`src/db/schema.ts\`; that runs \`drizzle-kit generate\` and then
 * \`scripts/build-migrations.mjs\`, which rebuilds this from
 * \`meta/_journal.json\` and the \`.sql\` files beside it.
 *
 * Key format: "m{zero-padded idx}" — what drizzle's durable-sqlite migrator
 * reads from \`config.migrations[key]\`.
 *
 * This journal is CORE's alone. A plugin must never add an entry: the journal is
 * a flat integer sequence over one shared \`__drizzle_migrations\` table, and two
 * independently-versioned packages writing to it will collide. See \`AgentDB\` in
 * \`src/db/db.ts\`.
 */
import type { migrate } from "drizzle-orm/durable-sqlite/migrator";

type MigrationConfig = Parameters<typeof migrate>[1];

const dbMigrations: MigrationConfig = {
  journal: {
    entries: [
${entries.join(",\n")}
    ]
  },
  migrations: {
${bodies.join(",\n")}
  }
};

export default dbMigrations;
`;

writeFileSync(join(DIR, "index.ts"), out);
console.log(
  `wrote src/db/migrations/index.ts (${journal.entries.length} migration${journal.entries.length === 1 ? "" : "s"})`
);
