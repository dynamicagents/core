#!/usr/bin/env node
/**
 * Fail if a comment names a path that is not there.
 *
 * The rule, both classes of reference and why only comments are read live in
 * `scripts/references.mjs`, which this prints the findings of. What a
 * repository scans and what it allows live in its own `references.config.mjs`.
 *
 * Run from a repository root:
 *
 * ```sh
 * npm run verify:references   # here
 * da-verify-references        # a consumer, from this package's bin
 * ```
 */
import { CONFIG_FILE, verifyReferences } from "./references.mjs";

try {
  const { failures } = await verifyReferences(process.cwd());

  for (const { file, line, ref } of failures)
    console.error(`✗ ${file}:${line} names ${ref}, which does not exist`);

  if (failures.length > 0) {
    console.error(
      "\nA comment points at a file that is not there. Either the path moved " +
        "and the comment did not, or the reference was never right. Fix the " +
        "comment, and if the path really is outside this repository, say so in " +
        `\`external\` in ${CONFIG_FILE}, with the reason.`
    );
    process.exit(1);
  }

  console.log("Every path named in a comment exists.");
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
