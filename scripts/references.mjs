/**
 * The comment-reference check, in one home for the whole train.
 *
 * Every repository here comments heavily and cross-references constantly, and a
 * reference is the part that rots first: the file moves, the comment stays, and
 * the next reader spends a minute proving the note is stale rather than reading
 * it. A path in a comment is checkable, so this checks it.
 *
 * This module is the engine. `scripts/verify-references.mjs` is the bin that
 * prints its findings, published as `da-verify-references` so a consumer runs
 * the same checker rather than keeping a copy of it. What varies by repository
 * is the config, not the rule: see `loadConfig` for the file and its defaults.
 *
 * **Two classes of reference, because each is blind where the other sees.** A
 * relative one, spelled the way an import is, is what a rename inside a
 * directory leaves behind, and `tsc` cannot see it because a path inside a
 * comment is not an import. A repository-rooted one, starting at a scanned
 * directory, is what prose reaches for when the file is nowhere near. The two
 * were once two scripts, each checking only its own class, and the gap between
 * them is where both of the pointers that prompted this one had rotted.
 *
 * **Comments only, and that is the whole scope.** A path in a string literal is
 * data rather than a note: prompt copy naming an example file, a config value, a
 * URL. Those belong to whatever reads them, and checking them means an allowlist
 * of things that were never wrong. Prose is the subject here, so Markdown counts
 * whole-file and a `#` line counts in a Dockerfile or an `.env.example`.
 *
 * A reference spelled `.js` resolves against the `.ts` beside it, so a comment
 * written the way an import is spelled still checks out.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The file a repository configures this in, read from the directory it runs in. */
export const CONFIG_FILE = "references.config.mjs";

/**
 * What a repository gets when it writes no config.
 *
 * Deliberately narrow: the directories every repository of the train has, and
 * the one root file all of them keep prose in. A repository that wants its
 * `AGENTS.md` or its `wrangler.jsonc` covered says so, because which root files
 * carry references is the one thing that genuinely differs between them.
 */
export const DEFAULT_CONFIG = {
  scan: ["src", "test", "scripts"],
  loose: ["README.md"],
  external: new Map()
};

/** Files worth reading at all. */
const EXT = /\.(ts|mjs|js|md|json|jsonc)$/;

/** Comment-bearing files with no extension of ours, where `#` opens a comment. */
const HASH_COMMENTS = new Set(["Dockerfile", ".env.example"]);

// Longest alternative first. Regex alternation is ordered, so a shorter
// extension listed ahead of a longer one that starts with it truncates the
// match and reports a file nobody named: `js` ahead of `json` did exactly that,
// and the predecessor script found it in itself.
const TARGET = "(?:jsonc|json|mjs|md|ts|js)";

/** A sibling or a neighbour, resolved against the file that names it. */
export const RELATIVE = new RegExp(
  `(?<![\\w.-])\\.{1,2}/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.${TARGET}`,
  "g"
);

const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A path from the repository root, resolved against it.
 *
 * Built from the scanned directories rather than from a list of its own, so one
 * config key decides both what is read and what a rooted reference may start
 * with. The cost is that a rooted path into a directory nobody scans is not
 * checked; adding it to `scan` is the fix.
 */
export const rootedPattern = (scan) =>
  new RegExp(
    `(?<![\\w/.-])(?:${scan.map(escape).join("|")})/` +
      `[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.${TARGET}`,
    "g"
  );

/**
 * The comment spans of one file, each carrying where in the file it started.
 *
 * The offset is the point: a line counted from the match's own position names
 * the comment that is wrong, where a search for the reference's first occurrence
 * in the file names whichever string literal happened to mention it earlier.
 */
export function commentSpans(file, text) {
  const name = path.basename(file);
  if (name.endsWith(".md")) return [{ start: 0, text }];
  if (HASH_COMMENTS.has(name)) return hashSpans(text);
  return codeSpans(text);
}

/** Whole lines whose first non-space character opens a comment. */
function hashSpans(text) {
  const spans = [];
  let start = 0;
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) spans.push({ start, text: line });
    start += line.length + 1;
  }
  return spans;
}

/**
 * The comment spans of anything with C-style comments: `.ts`, `.mjs`, `.js`,
 * and the `.json` and `.jsonc` files this train writes comments in.
 *
 * A lexer rather than a parser, and string-aware because it has to be: `"image/*"`
 * is a real value in this train, and a scan that does not track quotes reads it
 * as opening a block comment and runs to the next `*​/`. Template interpolations
 * are tracked too, by brace depth, so a nested template literal cannot end the
 * outer one early and shift every span after it.
 *
 * A `//` opens a line comment only at the start of a line or after whitespace.
 * That is what makes it unnecessary to lex regex literals: `/\/\//` carries a
 * `//` preceded by a backslash, and prettier puts a space before every trailing
 * comment it formats.
 */
function codeSpans(text) {
  const spans = [];
  /** Open quotes and interpolations, innermost last. */
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const frame = stack.at(-1);

    if (frame?.quote) {
      if (c === "\\") i += 1;
      // A `'` or `"` string cannot carry a raw newline, so one still open at the
      // end of a line was never a string: the quote was a character inside a
      // regex literal, which this does not lex. Closing it here is the language's
      // own rule, and it is what bounds that to the line it happened on. Without
      // it, the `"` inside a regex went on swallowing text until the next quote
      // in the file, which cost a doc comment and the reference in it.
      else if (frame.quote !== "`" && c === "\n") stack.pop();
      else if (frame.quote === "`" && c === "$" && text[i + 1] === "{") {
        stack.push({ braces: 0 });
        i += 1;
      } else if (c === frame.quote) stack.pop();
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      stack.push({ quote: c });
      continue;
    }

    // Inside a `${…}`, so a `}` may be this interpolation's end rather than an
    // object literal's or a block's.
    if (frame && c === "{") {
      frame.braces += 1;
      continue;
    }
    if (frame && c === "}") {
      if (frame.braces === 0) stack.pop();
      else frame.braces -= 1;
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      spans.push({ start: i, text: text.slice(i, stop) });
      i = stop - 1;
      continue;
    }

    if (
      c === "/" &&
      text[i + 1] === "/" &&
      (i === 0 || /\s/.test(text[i - 1]))
    ) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      spans.push({ start: i, text: text.slice(i, stop) });
      i = stop - 1;
    }
  }
  return spans;
}

/**
 * Every reference a file's comments name, with its absolute offset, in the
 * order they are written.
 *
 * Sorted because the two classes are two passes: without it, every relative
 * finding in a file is printed ahead of every rooted one, and a reader working
 * down the output jumps about the file for no reason they can see.
 */
export function references(file, text, rooted) {
  const found = [];
  for (const span of commentSpans(file, text)) {
    for (const [kind, pattern] of [
      ["relative", RELATIVE],
      ["rooted", rooted]
    ]) {
      for (const match of span.text.matchAll(pattern))
        found.push({
          ref: match[0],
          kind,
          index: span.start + match.index
        });
    }
  }
  return found.sort((one, other) => one.index - other.index);
}

const list = (value, key) => {
  if (value === undefined) return DEFAULT_CONFIG[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error(`${CONFIG_FILE}: \`${key}\` must be an array of strings.`);
  return value;
};

const external = (value) => {
  if (value === undefined) return new Map();
  if (value instanceof Map) return value;
  if (value && typeof value === "object") return new Map(Object.entries(value));
  throw new Error(
    `${CONFIG_FILE}: \`external\` must be a Map, or an object of path to reason.`
  );
};

/**
 * The config of the repository rooted at `root`, or the defaults.
 *
 * It is a module rather than JSON because every entry in it carries prose: why a
 * root file is scanned, and for each allowed path, why it is not this
 * repository's. An allowlist without reasons becomes a silencer, and JSON has
 * nowhere to write one. It sits at the root, which is also the one place this
 * checker does not read, so a config can neither report itself nor excuse itself.
 */
export async function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, configured: false };
  const loaded = (await import(pathToFileURL(file).href)).default;
  if (!loaded || typeof loaded !== "object")
    throw new Error(`${CONFIG_FILE}: must export a config object as default.`);
  return {
    scan: list(loaded.scan, "scan"),
    loose: list(loaded.loose, "loose"),
    external: external(loaded.external),
    configured: true
  };
}

/**
 * The files to read: every candidate under a scanned directory, plus the root
 * files named one by one.
 *
 * A scanned directory that is not there is skipped rather than fatal, because
 * the set of directories a repository of this train has is not fixed and a
 * checker that throws on the absence of `test/` is one nobody can adopt.
 */
export function collect(root, config) {
  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return EXT.test(entry) ? [full] : [];
    });

  return [
    ...config.scan.flatMap((dir) => {
      const full = path.join(root, dir);
      return existsSync(full) ? walk(full) : [];
    }),
    ...config.loose.map((file) => path.join(root, file)).filter(existsSync)
  ];
}

/** A reference resolves if it is there, or if its `.js` is a `.ts` beside it. */
const resolves = (abs) =>
  existsSync(abs) ||
  (abs.endsWith(".js") && existsSync(abs.slice(0, -".js".length) + ".ts"));

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every reference in the repository at `root` that names nothing.
 *
 * A file whose comments name the same missing path twice reports it once: the
 * finding is the path, and the first comment carrying it is where a reader
 * starts. Reading nothing at all is an error rather than a pass, because a
 * config whose directories have all moved would otherwise leave `check` green
 * over a repository this never looked at.
 */
export async function verifyReferences(root) {
  const config = await loadConfig(root);
  const files = collect(root, config);
  if (files.length === 0)
    throw new Error(
      `nothing to check under ${root}. Either this is not a repository root, or ` +
        `\`scan\` and \`loose\` in ${CONFIG_FILE} name no file that is there.`
    );

  const rooted = rootedPattern(config.scan);
  const failures = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const reported = new Set();
    for (const { ref, kind, index } of references(file, text, rooted)) {
      if (reported.has(ref) || config.external.has(ref)) continue;
      const abs =
        kind === "relative"
          ? path.resolve(path.dirname(file), ref)
          : path.join(root, ref);
      if (resolves(abs)) continue;
      reported.add(ref);
      failures.push({
        file: path.relative(root, file),
        line: lineOf(text, index),
        ref
      });
    }
  }
  return { files, failures };
}
