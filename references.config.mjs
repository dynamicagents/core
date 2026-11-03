/**
 * What `npm run verify:references` reads here, and what it is allowed to find.
 *
 * The checker is `scripts/references.mjs`, and its header is the home of what a
 * reference is and why only comments are read.
 */
export default {
  scan: ["src", "test", "scripts"],

  // `AGENTS.md` is in: it is the densest collection of pointers into this
  // package anywhere, and every one of them is the kind that rots. It documents
  // the `{@link file://…}` convention too, and the one path that is the example
  // rather than a reference is allowed below.
  loose: ["README.md", "AGENTS.md", "wrangler.jsonc"],

  /**
   * Paths that are deliberately not this package's, with the reason.
   *
   * Add to this only for a path that genuinely lives elsewhere, or is the
   * example rather than a reference. Never to silence a path that has simply
   * gone stale: that one is the finding.
   */
  external: new Map([
    [
      "./package.json",
      "an `exports` map key, not a sibling. The scripts here reason about subpaths"
    ],
    [
      "../path/to.ts",
      "the shape of a `{@link file://…}` pointer, in the comment rule that teaches it"
    ],
    [
      "./x.js",
      "a stand-in name in prose, for whatever `tsc` emitted beside a `.d.ts`"
    ],
    [
      "./wrangler.jsonc",
      "a consumer's own config, inside a fenced example of their `vitest.config.ts`"
    ],
    [
      "src/api.spec.ts",
      "an invented pair of names, showing two specs that collide"
    ],
    ["test/api.spec.ts", "the other half of that pair"],
    [
      "./worker-configuration.d.ts",
      "cited as a path that would *not* resolve from the config naming it, which is the note's whole point"
    ],
    ["test/worker-configuration.d.ts", "the same note, read as a rooted path"]
  ])
};
