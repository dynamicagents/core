/**
 * Node-realm spec (see `vitest.config.ts`): the reference checker reads
 * `node:fs` and never `cloudflare:test`, so it runs outside workerd.
 *
 * Every fixture is a repository built in a temporary directory, never a file
 * committed here. A committed fixture holding a deliberately dead reference
 * would sit inside a scanned directory, and the checker would report itself.
 *
 * The properties pinned here are the ones that decide whether this can live in
 * `check`: a scan that reads prose and not data, and that cannot silently stop
 * seeing a comment. Each one that names a measurement is a defect this had.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyReferences } from "./references.mjs";

const built = [];

afterEach(() => {
  while (built.length > 0)
    rmSync(built.pop(), { recursive: true, force: true });
});

/** A repository of `{ relative path: contents }`, in a temporary directory. */
function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "references-"));
  built.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const failures = async (files) =>
  (await verifyReferences(repo(files))).failures;
const refs = (list) => list.map((failure) => failure.ref);

describe("what counts as a reference", () => {
  it("reads a comment and not a string beside it", async () => {
    const found = await failures({
      "src/a.ts": [
        'export const copy = "the file ./in-a-string.ts explains it";',
        "// and ./in-a-comment.ts does too",
        ""
      ].join("\n")
    });

    expect(refs(found)).toEqual(["./in-a-comment.ts"]);
  });

  it("names the comment's line, not the file's first mention of the path", async () => {
    const found = await failures({
      "src/a.ts": [
        'export const copy = "see ./gone.ts";',
        "",
        "// see ./gone.ts",
        ""
      ].join("\n")
    });

    expect(found).toEqual([
      { file: path.join("src", "a.ts"), line: 3, ref: "./gone.ts" }
    ]);
  });

  it("reports a missing path once per file, however often it is named", async () => {
    const found = await failures({
      "src/a.ts": "// ./gone.ts\n// ./gone.ts again\n/** and ./gone.ts */\n"
    });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });

  it("takes the longest extension, so a `.json` is never reported as a `.js`", async () => {
    const found = await failures({ "src/a.ts": "// see ./gone.json\n" });

    expect(refs(found)).toEqual(["./gone.json"]);
  });

  it("resolves a `.js` reference against the `.ts` beside it", async () => {
    const found = await failures({
      "src/a.ts": "// see ./b.js\n",
      "src/b.ts": "export const b = 1;\n"
    });

    expect(found).toEqual([]);
  });

  it("checks a path from the repository root as well as a relative one", async () => {
    const found = await failures({
      "src/a.ts": "// see src/gone.ts and ./also-gone.ts\n"
    });

    expect(refs(found)).toEqual(["src/gone.ts", "./also-gone.ts"]);
  });

  it("leaves a rooted path alone when it is part of a relative one", async () => {
    const found = await failures({
      "src/a.ts": "// see ./src/gone.ts\n"
    });

    expect(refs(found)).toEqual(["./src/gone.ts"]);
  });
});

describe("the comment lexer", () => {
  it("does not read a quote inside a regex literal as opening a string", async () => {
    // The measurement: this shape is `scripts/verify-exports.mjs`, and a scan
    // that took that `"` for a string went on swallowing text to the next quote
    // in the file, which cost the doc comment below it and the reference in it.
    const found = await failures({
      "src/a.ts": [
        'const specifiers = /(?:from|import)\\s*"([^"]+)"/g;',
        "",
        "/** Walks ./gone.ts for them. */",
        "export const walk = () => specifiers;",
        ""
      ].join("\n")
    });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });

  it("does not read a `//` inside a regex literal as opening a comment", async () => {
    const found = await failures({
      "src/a.ts": 'const slashes = /[//]/; const hint = "./gone.ts";\n'
    });

    expect(found).toEqual([]);
  });

  it("does not read an escaped slash in a regex as opening a block comment", async () => {
    // The measurement: `/\/*$/` is in starter, and its `\/*` was read as opening
    // a comment that ran to the next `*​/`, which put the code in between into a
    // comment span. The reference below is in a string and must stay unread.
    const found = await failures({
      "src/a.ts": [
        'const trailing = url.replace(/\\/*$/, "/");',
        'const hint = "./gone.ts";',
        "/** A real comment, and ./also-gone.ts in it. */",
        ""
      ].join("\n")
    });

    expect(refs(found)).toEqual(["./also-gone.ts"]);
  });

  it("keeps `image/*` a value rather than the start of a block comment", async () => {
    const found = await failures({
      "src/a.ts": ['const kind = "image/*";', "// see ./gone.ts", ""].join("\n")
    });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });

  it("does not let a nested template literal end the outer one early", async () => {
    const found = await failures({
      "src/a.ts": [
        "const label = `outer ${`inner`} done`;",
        "// see ./gone.ts",
        ""
      ].join("\n")
    });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });

  it("reads a trailing comment, which is where half of these live", async () => {
    const found = await failures({
      "src/a.ts": "export const a = 1; // see ./gone.ts\n"
    });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });
});

describe("the files it reads", () => {
  it("reads Markdown whole, fenced blocks included", async () => {
    const found = await failures({
      "src/a.ts": "export const a = 1;\n",
      "README.md":
        "An example:\n\n```ts\n// src/gone.ts\n```\n\nAnd ./also-gone.md.\n"
    });

    expect(refs(found)).toEqual(["src/gone.ts", "./also-gone.md"]);
  });

  it("reads a `#` line in a Dockerfile and leaves its instructions alone", async () => {
    const found = await failures({
      "references.config.mjs": `export default { loose: ["Dockerfile"] };\n`,
      "src/a.ts": "export const a = 1;\n",
      Dockerfile: [
        "COPY src/not-a-comment.ts /app",
        "# see src/gone.ts",
        ""
      ].join("\n")
    });

    expect(refs(found)).toEqual(["src/gone.ts"]);
  });

  it("skips a scanned directory that is not there", async () => {
    // The default `scan` names `test` and `scripts`; this repository has
    // neither, and the predecessor script threw on exactly that.
    const found = await failures({ "src/a.ts": "// see ./gone.ts\n" });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });

  it("refuses to pass when it has read nothing at all", async () => {
    await expect(
      verifyReferences(repo({ "docs/a.md": "// see ./gone.ts\n" }))
    ).rejects.toThrow(/nothing to check/);
  });
});

describe("the config", () => {
  it("suppresses an allowed path and keeps checking the rest", async () => {
    const found = await failures({
      "references.config.mjs": [
        "export default {",
        '  external: new Map([["./allowed.ts", "lives in another package"]])',
        "};",
        ""
      ].join("\n"),
      "src/a.ts": "// see ./allowed.ts and ./gone.ts\n"
    });

    expect(refs(found)).toEqual(["./gone.ts"]);
  });

  it("takes an allowlist written as a plain object", async () => {
    const found = await failures({
      "references.config.mjs": [
        "export default {",
        '  external: { "./allowed.ts": "lives in another package" }',
        "};",
        ""
      ].join("\n"),
      "src/a.ts": "// see ./allowed.ts\n"
    });

    expect(found).toEqual([]);
  });

  it("widens the rooted class with the directories it is told to scan", async () => {
    const found = await failures({
      "references.config.mjs": `export default { scan: ["lib"] };\n`,
      "lib/a.ts": "// see lib/gone.ts\n"
    });

    expect(refs(found)).toEqual(["lib/gone.ts"]);
  });

  it("fails loudly on a config it cannot read, rather than checking nothing", async () => {
    await expect(
      verifyReferences(
        repo({
          "references.config.mjs": `export default { scan: "src" };\n`,
          "src/a.ts": "export const a = 1;\n"
        })
      )
    ).rejects.toThrow(/`scan` must be a non-empty array of strings/);
  });

  it("refuses an empty `scan`, which would make the rooted class match anything", async () => {
    // `scan` also names the prefixes a rooted reference may start with, so an
    // empty one leaves an alternation that matches the empty string.
    await expect(
      verifyReferences(
        repo({
          "references.config.mjs": `export default { scan: [], loose: ["README.md"] };\n`,
          "README.md": "see /gone.ts\n"
        })
      )
    ).rejects.toThrow(/`scan` must be a non-empty array of strings/);
  });

  it("says which way it was configured when it has read nothing", async () => {
    await expect(
      verifyReferences(repo({ "docs/a.md": "nothing scanned here\n" }))
    ).rejects.toThrow(/There is no references\.config\.mjs here/);
  });
});

describe("what this package ships", () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
  );

  /** `files` entries are paths or directories; a directory covers what is under it. */
  const packed = (target) =>
    manifest.files.some(
      (entry) =>
        target === entry || target.startsWith(entry.replace(/\/$/, "") + "/")
    );

  it("packs every file it declares as a bin", () => {
    for (const target of Object.values(manifest.bin))
      expect(packed(target), `${target} is not in \`files\``).toBe(true);
  });

  it("packs what the bin imports", () => {
    // `files` is an explicit list, and a git install packs the clone by it too,
    // so the engine left out of it is a bin that resolves to a missing module in
    // every consumer and in nothing here.
    expect(packed("scripts/references.mjs")).toBe(true);
  });
});
