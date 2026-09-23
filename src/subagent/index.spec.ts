import { describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { PushChannel, TurnPushContext } from "../a2a/push.js";
import type {
  ChunkProgressContext,
  ProgressEvent,
  RecipeExecutionRequest
} from "../subtasks/types.js";
import type { TestSubagent } from "../../test/worker.js";

/**
 * Live progress: a facet posting its own notes while a chunk runs.
 *
 * The rules worth pinning are the three that decide whether a note reaches a
 * person, and every one of them is a *refusal* — the posting itself is
 * `PushChannel.working`, which has its own coverage. What belongs to this module
 * is when it declines to call it, because each of those is a way for a subagent
 * to keep talking after it should have stopped.
 *
 * A real facet rather than a fake, because `noteProgressContext` reads `request`
 * and the instance field it writes is the thing under test. `pushChannel` is
 * overridden per instance — the same seam a deployment keeping its key elsewhere
 * would use — so no spec here needs a signing key.
 */

// `wrangler types --include-env=false` leaves the ambient `Env` without the
// test worker's bindings, so they are reached by name — the same way the
// scheduler specs reach theirs.
const ns = (
  env as unknown as Record<string, DurableObjectNamespace<TestSubagent>>
).TEST_SUBAGENT!;

const fresh = () => ns.get(ns.idFromName(`live:${crypto.randomUUID()}`));

const PUSH: TurnPushContext = {
  taskId: "task-1",
  contextId: "ctx-1",
  pushUrl: "https://gatekeeper.example/a2a/notifications",
  pushToken: "token",
  jku: "https://agent.example/.well-known/jwks.json"
};

const REQUEST = {
  taskId: "task-1",
  subtaskId: 7,
  type: "claude-code"
} as unknown as RecipeExecutionRequest;

/** The protected surface these specs drive, and the one they stub. */
interface Facet {
  pushChannel(context: TurnPushContext): PushChannel;
  noteProgressContext(
    request: RecipeExecutionRequest,
    live?: ChunkProgressContext
  ): void;
  postProgress(event: ProgressEvent): Promise<void>;
  abortRun(): Promise<boolean>;
  yieldRun(): Promise<void>;
  inflight?: AbortController;
}

/** Drive one facet with its callback channel captured instead of posted. */
async function withFacet(
  fn: (facet: Facet, posted: { text: string; key: string }[]) => Promise<void>
): Promise<void> {
  await runInDurableObject(fresh(), async (instance) => {
    const posted: { text: string; key: string }[] = [];
    const facet = instance as unknown as Facet;
    facet.pushChannel = () =>
      ({
        working: async (text: string, key: string) => {
          posted.push({ text, key });
        }
      }) as unknown as PushChannel;
    await fn(facet, posted);
  });
}

describe("a facet's own progress notes", () => {
  it("labels a note with the subtask type and ordinal, and keys it verbatim", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(REQUEST, { push: PUSH, ordinal: 0 });
      await facet.postProgress({ key: "claude:3", text: "Running the suite." });

      // The label is the whole reason `ordinal` travels with the push context:
      // two branches of one round are different instances sharing a type.
      expect(posted).toEqual([
        { text: "[claude-code 0] Running the suite.", key: "claude:3" }
      ]);
    });
  });

  it("says nothing when the parent passed no context", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(REQUEST, undefined);
      await facet.postProgress({ key: "claude:0", text: "still working" });
      expect(posted).toEqual([]);
    });
  });

  it("stops posting once the run is aborted", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(REQUEST, { push: PUSH, ordinal: 2 });
      await facet.postProgress({ key: "claude:0", text: "before" });

      // What a cancellation actually does to a facet. The parent's own
      // suppression runs before *it* posts, and a note from here never reaches
      // that check.
      facet.inflight = new AbortController();
      await facet.abortRun();
      await facet.postProgress({ key: "claude:1", text: "after" });

      expect(posted.map((p) => p.key)).toEqual(["claude:0"]);
    });
  });

  it("keeps posting when a chunk is only asked to yield", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(REQUEST, { push: PUSH, ordinal: 1 });
      const inflight = new AbortController();
      facet.inflight = inflight;

      // What a retry does to the attempt it replaces: the run is interrupted,
      // and nothing is canceled — the retry goes on narrating the same work.
      await facet.yieldRun();
      await facet.postProgress({ key: "claude:4", text: "still going" });

      expect(inflight.signal.aborted).toBe(true);
      expect(posted.map((p) => p.key)).toEqual(["claude:4"]);
    });
  });

  it("stops posting for a facet that holds no interruptible model call", async () => {
    await withFacet(async (facet, posted) => {
      /**
       * The case the abort *signal* cannot answer, and the one that matters.
       *
       * `inflight` tracks a model call, and a facet overriding `executeChunk`
       * outright never sets one — so an absent controller has to mean "nothing
       * to interrupt", not "not canceled". Read the other way, such a facet goes
       * on narrating a canceled Task for the whole time its session takes to
       * unwind, which for a container command is a minute of talking about work
       * nobody asked for any more.
       */
      facet.noteProgressContext(REQUEST, { push: PUSH, ordinal: 0 });
      expect(facet.inflight).toBeUndefined();

      expect(await facet.abortRun()).toBe(false);
      await facet.postProgress({ key: "claude:0", text: "after the cancel" });

      expect(posted).toEqual([]);
    });
  });

  it("drops a previous turn's channel when a later chunk brings none", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(REQUEST, { push: PUSH, ordinal: 0 });
      // An isolate that already ran a chunk for one turn, reused by a chunk that
      // has no gatekeeper behind it. Left armed, it would post this chunk's notes
      // to the previous turn's callback.
      facet.noteProgressContext(REQUEST, undefined);
      await facet.postProgress({ key: "claude:0", text: "leaked" });
      expect(posted).toEqual([]);
    });
  });
});
