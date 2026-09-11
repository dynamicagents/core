import { describe, it, expect } from "vitest";
import {
  CHUNK_SOFT_MS,
  HUMAN_WAIT_MS,
  MAX_CHUNKS_PER_BRANCH,
  MAX_TOOL_CALL_MS,
  STEP_TIMEOUT_MS,
  STEPS_PER_INSTANCE
} from "./platform.js";
import { DEFAULT_CORE_CONFIG } from "./config.js";

/**
 * The arithmetic `platform.ts` claims but cannot enforce.
 *
 * Each constant there is documented as "held unreachable by" a relationship to
 * another one. Those relationships are load-bearing — the bug the file was
 * extracted during was exactly a derived bound drifting from the platform fact
 * it was sized against — and nothing but a test keeps them true when someone
 * nudges a default in `config.ts`.
 */
describe("platform bounds", () => {
  it("checkpoints a chunk well inside the configured step timeout", () => {
    expect(CHUNK_SOFT_MS).toBeLessThan(STEP_TIMEOUT_MS);
    /**
     * Not merely under it: a turn already in flight when the soft limit trips
     * still has to finish inside the same step, and a turn is a model call *plus*
     * a tool call.
     *
     * This assertion used to demand only 60s of headroom, and that is the hole a
     * production task fell through: 4-minute chunks under a 10-minute timeout
     * passed this test, then one `sb_exec` ran past both and Workflows killed the
     * step at 600000ms and replayed the whole chunk. A minute was never enough to
     * cover a tool call that may take ten.
     */
    expect(STEP_TIMEOUT_MS - CHUNK_SOFT_MS).toBeGreaterThanOrEqual(
      MAX_TOOL_CALL_MS + 5 * 60_000
    );
  });

  it("leaves a blocking tool call room to finish inside its chunk", () => {
    // The contract hosts have to honour when they install a shell or a container
    // command; see MAX_TOOL_CALL_MS. A tool permitted to outlast the chunk that
    // called it cannot be checkpointed around.
    expect(MAX_TOOL_CALL_MS).toBeLessThan(CHUNK_SOFT_MS);
  });

  it("cannot exhaust the chunk ceiling before the turn budget", () => {
    // A yielding chunk always advanced at least one turn, so a run takes at most
    // `maxTurns` chunks. Keeping the ceiling above that is what makes reaching
    // it a bug rather than a budget.
    expect(MAX_CHUNKS_PER_BRANCH).toBeGreaterThan(
      DEFAULT_CORE_CONFIG.subagentLimits.maxTurns
    );
  });

  it("waits on a person past the gatekeeper's expiry, and no longer than a wait may last", () => {
    // Past a week, so the gatekeeper's own timeout is what normally ends the
    // wait; inside a year, the longest `step.waitForEvent` accepts.
    expect(HUMAN_WAIT_MS).toBeGreaterThan(7 * 24 * 60 * 60_000);
    expect(HUMAN_WAIT_MS).toBeLessThanOrEqual(365 * 24 * 60 * 60_000);
  });

  it("keeps the worst-case step product under one Workflow instance", () => {
    // Every subtask fanned out, each burning the full chunk ceiling.
    const worstCase = DEFAULT_CORE_CONFIG.maxSubtasks * MAX_CHUNKS_PER_BRANCH;
    expect(worstCase).toBeLessThan(STEPS_PER_INSTANCE);
  });
});
