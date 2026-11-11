/**
 * What the devkit checkers read here, a section per checker.
 *
 * The checkers themselves are `.devkit/`, vendored from dev-agents'
 * `packages/devkit`; that package's README is the home of what each one fails
 * on and of every key below. This file is only what is this repository's.
 */
export default {
  references: {
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
        "../path/to.ts",
        "the shape of a `{@link file://…}` pointer, in the comment rule that teaches it"
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
  },

  exports: {
    /**
     * `@dynamicagents/core/testing*` is the test harness and is expected to
     * reach the test-only modules. It is a separate subpath precisely so it
     * cannot enter a runtime graph, which is what the rest of the realm check
     * holds for every other subpath here.
     */
    realmExempt: ["./testing"]
  }
};
