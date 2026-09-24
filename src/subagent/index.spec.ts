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
import type { Artifacts } from "../artifacts/do.js";
import { ARTIFACTS_OBJECT_NAME } from "../artifacts/binding.js";
import { SESSION_TRANSCRIPT_KIND } from "../artifacts/transcript.js";
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

/**
 * A request on a task of its own. A task's link is posted until it lands and
 * then never again, so specs sharing one would read an earlier spec's silence
 * as their own refusal.
 */
const requestOn = (taskId = crypto.randomUUID()): RecipeExecutionRequest =>
  ({ taskId, subtaskId: 7, type: "claude-code" }) as RecipeExecutionRequest;

/** The deployment's own origin, which a facet learns from the push context. */
const ORIGIN = new URL(PUSH.jku).origin;

/**
 * The link as the thread receives it: named for the branch that opened it, and
 * carrying none of the note's own text. See `transcribeNote`.
 */
const announced = (token: string | null, ordinal = 0) =>
  `Subtask Session (Claude Code ${ordinal}): ${ORIGIN}/a/${token}`;

const artifactsNs = (
  env as unknown as Record<string, DurableObjectNamespace<Artifacts>>
).ARTIFACTS!;

const artifacts = () =>
  artifactsNs.get(artifactsNs.idFromName(ARTIFACTS_OBJECT_NAME));

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

/**
 * Drive one facet with its callback channel captured instead of posted.
 *
 * `landed` is what `PushChannel.working` answers — whether the gatekeeper took
 * the post — and `false` is the swallowed failure a facet never hears about, so
 * it is the only way to reach the case where the link must be offered again.
 */
async function withFacet(
  fn: (facet: Facet, posted: { text: string; key: string }[]) => Promise<void>,
  landed = true
): Promise<void> {
  await runInDurableObject(fresh(), async (instance) => {
    const posted: { text: string; key: string }[] = [];
    const facet = instance as unknown as Facet;
    facet.pushChannel = () =>
      ({
        working: async (text: string, key: string) => {
          posted.push({ text, key });
          return landed;
        }
      }) as unknown as PushChannel;
    await fn(facet, posted);
  });
}

describe("a facet's own progress notes", () => {
  it("labels a note with the subtask type and ordinal, and keys it verbatim", async () => {
    await withFacet(async (facet, posted) => {
      const taskId = crypto.randomUUID();
      facet.noteProgressContext(requestOn(taskId), { push: PUSH, ordinal: 0 });
      await facet.postProgress({ key: "claude:3", text: "Running the suite." });

      // The note is the link and none of its own text, under the key the note
      // would have been posted under — that key is the gatekeeper's dedupe id
      // and the artifact's, so it travels unlabelled.
      expect(posted).toHaveLength(1);
      expect(posted[0]!.key).toBe("claude:3");
      expect(posted[0]!.text).toMatch(/^Subtask Session \(Claude Code 0\): /);

      // And the label is on the entry, which is where a page has a column for
      // it. It is the whole reason `ordinal` travels with the push context: two
      // branches of one round are different instances sharing a type.
      const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
      expect(posted[0]!.text).toBe(announced(token));
      // Settled first so the stream closes and the body can be read to its end.
      await artifacts().settle(token!, "completed");
      const body = await (
        await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
      ).text();
      expect(body).toContain('"label":"claude-code 0"');
      expect(body).toContain('"text":"Running the suite."');
    });
  });

  it("offers the link again when the post does not reach the thread", async () => {
    await withFacet(async (facet, posted) => {
      // A facet posts live, outside anything that retries: `working` swallows a
      // dropped POST, so a link suppressed after one attempt is a link nobody
      // ever gets. The rule the transcript holds to is delivery, not position —
      // see `transcribeNote`.
      const taskId = crypto.randomUUID();
      facet.noteProgressContext(requestOn(taskId), { push: PUSH, ordinal: 0 });
      await facet.postProgress({ key: "claude:0", text: "first" });
      await facet.postProgress({ key: "claude:1", text: "second" });

      const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
      expect(posted).toEqual([
        { text: announced(token), key: "claude:0" },
        { text: announced(token), key: "claude:1" }
      ]);
    }, false);
  });

  it("posts the link from a facet whose chunk never reached the base", async () => {
    await withFacet(async (facet, posted) => {
      // What an override of `executeChunk` does, and all it does: arm the
      // channel, then post. The `selfOrigin` argument never reaches the memo on
      // that path, so the origin has to come from the push context — or every
      // note goes to the thread verbatim.
      const taskId = crypto.randomUUID();
      facet.noteProgressContext(requestOn(taskId), { push: PUSH, ordinal: 0 });
      await facet.postProgress({ key: "claude:3", text: "Running the suite." });

      const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
      expect(posted).toEqual([{ text: announced(token), key: "claude:3" }]);
    });
  });

  it("says nothing when the parent passed no context", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(requestOn(), undefined);
      await facet.postProgress({ key: "claude:0", text: "still working" });
      expect(posted).toEqual([]);
    });
  });

  it("stops posting once the run is aborted", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(requestOn(), { push: PUSH, ordinal: 2 });
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
      facet.noteProgressContext(requestOn(), { push: PUSH, ordinal: 1 });
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
      facet.noteProgressContext(requestOn(), { push: PUSH, ordinal: 0 });
      expect(facet.inflight).toBeUndefined();

      expect(await facet.abortRun()).toBe(false);
      await facet.postProgress({ key: "claude:0", text: "after the cancel" });

      expect(posted).toEqual([]);
    });
  });

  it("drops a previous turn's channel when a later chunk brings none", async () => {
    await withFacet(async (facet, posted) => {
      facet.noteProgressContext(requestOn(), { push: PUSH, ordinal: 0 });
      // An isolate that already ran a chunk for one turn, reused by a chunk that
      // has no gatekeeper behind it. Left armed, it would post this chunk's notes
      // to the previous turn's callback.
      facet.noteProgressContext(requestOn(), undefined);
      await facet.postProgress({ key: "claude:0", text: "leaked" });
      expect(posted).toEqual([]);
    });
  });
});
