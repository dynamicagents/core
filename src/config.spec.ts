import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config.js";
import { TEST_MODELS } from "./testing/fixtures.js";

/**
 * What `resolveConfig` refuses.
 *
 * Every case here is a value that **typechecks** and then fails somewhere far
 * from the config that caused it — a JavaScript consumer, an `as` cast, or a
 * number that is the right type and the wrong kind. The type system has already
 * caught everything else.
 */

const base = { model: TEST_MODELS } as const;

/** Deferrals on, in the shape an agent that wants them declares. */
const waiting = {
  ...base,
  mainAgentLimits: {
    maxTurns: 20,
    maxWallMs: 60_000,
    maxDeferrals: 30,
    maxDeferredMs: 900_000
  }
};

describe("the deferral bounds", () => {
  it("accepts an agent that asks for waiting, and one that does not", () => {
    expect(() => resolveConfig(waiting)).not.toThrow();
    // Absent is the default and the whole feature is off. Nothing to validate.
    expect(() => resolveConfig(base)).not.toThrow();
  });

  it("refuses a fractional count of waits", () => {
    // 0.5 is not "half a wait": it admits the first and refuses the second, so
    // it enables exactly the behaviour the config did not ask for.
    expect(() =>
      resolveConfig({
        ...waiting,
        mainAgentLimits: { ...waiting.mainAgentLimits, maxDeferrals: 0.5 }
      })
    ).toThrow(/maxDeferrals must be a non-negative integer/);
  });

  it("refuses a duration that is not a number", () => {
    // Worse than out of range: `NaN` compares false against every bound, so it
    // turns waiting off while reading as a generous allowance.
    expect(() =>
      resolveConfig({
        ...waiting,
        mainAgentLimits: { ...waiting.mainAgentLimits, maxDeferredMs: NaN }
      })
    ).toThrow(/maxDeferredMs must be a non-negative number/);
  });

  it("refuses negatives, and allows zero as the way to turn waiting off", () => {
    for (const limits of [
      { maxDeferrals: -1 },
      { maxDeferredMs: -1 }
    ] as const) {
      expect(() =>
        resolveConfig({
          ...waiting,
          mainAgentLimits: { ...waiting.mainAgentLimits, ...limits }
        })
      ).toThrow();
    }

    expect(() =>
      resolveConfig({
        ...waiting,
        mainAgentLimits: { ...waiting.mainAgentLimits, maxDeferrals: 0 }
      })
    ).not.toThrow();
  });

  it("polices a subagent's bounds too", () => {
    expect(() =>
      resolveConfig({
        ...base,
        subagentLimits: { maxTurns: 20, maxWallMs: 60_000, maxDeferrals: 1.5 }
      })
    ).toThrow(/subagentLimits.maxDeferrals/);
  });

  it("refuses waiting with nothing to carry it between rounds", () => {
    // The dependency neither side can see. A round that waits records why as an
    // observation; a window of 0 — legal, and how an agent opts out of carrying
    // anything — reads none of them back. The round that wakes then sees the
    // evidence that made it wait and no record of having waited, so it waits
    // again, identically, until the allowance is gone.
    expect(() =>
      resolveConfig({ ...waiting, roundObservationWindow: 0 })
    ).toThrow(/roundObservationWindow > 0/);

    // …and a window of 0 is still fine for an agent that never waits.
    expect(() =>
      resolveConfig({ ...base, roundObservationWindow: 0 })
    ).not.toThrow();
  });
});
