/**
 * Node-realm spec (see `vitest.config.ts`): what the published tarball carries.
 *
 * `files` is an explicit list and a git install packs the clone by it too, so a
 * `bin` target left out of it is a command that resolves to a missing file in
 * every consumer and in nothing here. That is invisible to `tsc`, to the suite
 * and to `npm pack` alike, which is why it is asserted rather than remembered.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const manifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
);

/** `files` entries are paths or directories; a directory covers what is under it. */
const packed = (target) =>
  manifest.files.some(
    (entry) =>
      target === entry || target.startsWith(entry.replace(/\/$/, "") + "/")
  );

describe("what this package ships", () => {
  it("packs every file it declares as a bin", () => {
    for (const target of Object.values(manifest.bin))
      expect(packed(target), `${target} is not in \`files\``).toBe(true);
  });
});
