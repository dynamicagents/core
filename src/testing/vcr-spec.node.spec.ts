import { describe, it, expect } from "vitest";
import type { RunnerTestCase, RunnerTestSuite } from "vitest";
import { cassetteNameFor } from "./vcr-spec.js";

/**
 * A cassette name is a **filename committed to a repo**, so the only property
 * that matters is that it depends on nothing outside the repo. It is derived
 * from a Vitest task, and the derivation used to take `.pop()` of a split that
 * could fail to match — which returns the input unchanged, i.e. the absolute
 * path, i.e. a name containing the developer's home directory. That reproduces
 * as "works on my machine, missing cassette in CI", so it is pinned here.
 */

/**
 * Minimal task tree: a File task at the root, then nested describe suites.
 * `rel` is Vitest's project-relative `file.name`; `filepath` is absolute and is
 * only reached by the fallback.
 */
function task(
  rel: string,
  name: string,
  suites: string[] = [],
  filepath = `/home/dev/repo/${rel}`
) {
  // Only the fields the derivation reads are populated; casting through
  // `unknown` because a real task carries a dozen more that nothing here needs.
  let suite = { filepath } as unknown as RunnerTestSuite;
  for (const suiteName of suites) {
    suite = { name: suiteName, suite } as unknown as RunnerTestSuite;
  }
  return {
    name,
    suite,
    file: { name: rel, filepath }
  } as unknown as RunnerTestCase;
}

describe("cassetteNameFor", () => {
  it("names a spec by its project-relative path", () => {
    expect(
      cassetteNameFor(task("test/arc-agi/recorded.spec.ts", "plays a game"))
    ).toBe("test-arc-agi-recorded--plays-a-game.snapshot.json");
  });

  it("names a spec beside its code under src/ the same way", () => {
    expect(
      cassetteNameFor(task("src/arc-agi/recorded.spec.ts", "plays a game"))
    ).toBe("src-arc-agi-recorded--plays-a-game.snapshot.json");
  });

  it("never puts the developer's own directories into the name", () => {
    // The first defect here: a path with no recognised root used to fall
    // through to the *absolute* path, so the cassette was named after whoever
    // recorded it and CI could never find it. `file.name` is repo-relative by
    // construction, so the absolute path cannot leak in at all.
    const name = cassetteNameFor(
      task("test/recorded.spec.ts", "one", [], "/home/dev/src/work/repo/x.ts")
    );
    expect(name).toBe("test-recorded--one.snapshot.json");
    expect(name).not.toContain("home");
  });

  it("falls back to the bare filename when the runner supplies no name", () => {
    const bare = {
      name: "a b",
      suite: { filepath: "/repo/recorded.spec.ts" },
      file: { filepath: "/repo/recorded.spec.ts" }
    } as unknown as RunnerTestCase;
    expect(cassetteNameFor(bare)).toBe("recorded--a-b.snapshot.json");
  });

  it("includes each describe level, in order, kebab-cased", () => {
    expect(
      cassetteNameFor(
        task("test/arc-agi/recorded.spec.ts", "Reads The Score!", [
          "arc (recorded real API)",
          "scoring"
        ])
      )
    ).toBe(
      "test-arc-agi-recorded--arc-recorded-real-api--scoring--reads-the-score.snapshot.json"
    );
  });
});
