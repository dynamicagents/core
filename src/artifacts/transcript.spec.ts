import { beforeAll, describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { TaskState } from "@a2a-js/sdk";
import type { ArtifactsEnv } from "../env.js";
import type { Artifacts } from "./do.js";
import { ARTIFACTS_OBJECT_NAME, ArtifactsNotBoundError } from "./binding.js";
import {
  SESSION_TRANSCRIPT_KIND,
  settleTranscript,
  transcribeNote,
  type SubagentNote
} from "./transcript.js";

/**
 * What the thread gets, note by note.
 *
 * Three answers and no fourth: the link, silence, or the note exactly as it
 * would have been posted before any of this existed. The last one is not a
 * fallback for a deployment that wired nothing — the binding is required, and
 * its absence throws here as it does at DO start. It is for the two cases that
 * are facts about *this note*: an origin this instance has not learned yet, and
 * an artifact retention swept. Neither is fixable by the caller and neither
 * should cost the person the note.
 */

const ns = (env as unknown as Record<string, DurableObjectNamespace<Artifacts>>)
  .ARTIFACTS!;

const wired: ArtifactsEnv = { ARTIFACTS: ns };

/**
 * The deployment that forgot the binding.
 *
 * Cast, because `ArtifactsEnv` now requires `ARTIFACTS` — which is the point:
 * this is a `wrangler.jsonc` that never grew the namespace while the generated
 * `Env` said it had. Only a runtime check catches that, so only a cast can
 * drive it.
 */
const unbound = {} as unknown as ArtifactsEnv;

/** A binding that is there and does not work — an outage, not a wiring fault. */
const broken = {
  ARTIFACTS: {
    idFromName() {
      throw new Error("no such namespace");
    }
  }
} as unknown as ArtifactsEnv;

const artifacts = () => ns.get(ns.idFromName(ARTIFACTS_OBJECT_NAME));

const ORIGIN = "https://agent.example";

const note = (overrides: Partial<SubagentNote> = {}): SubagentNote => ({
  taskId: crypto.randomUUID(),
  origin: ORIGIN,
  source: { type: "claude-code", ordinal: 0 },
  text: "Running the suite.",
  key: "claude:0",
  ...overrides
});

/**
 * Warm the object before the clock starts on a test.
 *
 * The first call into a Durable Object in a spec file instantiates
 * `test/worker.ts` and its whole module graph inside that object's isolate,
 * which takes seconds; every call after it takes single-digit milliseconds.
 * Without this the bill lands on whichever test happens to be first, and that
 * test fails whenever this file runs on its own. `tokenFor` opens nothing, so
 * the warm-up leaves no artifact behind.
 */
beforeAll(async () => {
  await artifacts().tokenFor("warm-up", "warm-up");
}, 30_000);

describe("transcribeNote", () => {
  it("answers the first note with a link and the rest with silence", async () => {
    const taskId = crypto.randomUUID();
    const link = await transcribeNote(
      wired,
      note({ taskId, text: "first", key: "claude:0" })
    );
    expect(link).toMatch(
      new RegExp(`^${ORIGIN}/a/[0-9A-Za-z]{40}$`.replace(/\//g, "\\/"))
    );

    // Everything after it is on the transcript and nowhere else — which is the
    // whole point: a long run used to put dozens of these in the thread.
    expect(
      await transcribeNote(
        wired,
        note({ taskId, text: "second", key: "claude:1" })
      )
    ).toBeUndefined();
    expect(
      await transcribeNote(
        wired,
        note({ taskId, text: "third", key: "claude:2" })
      )
    ).toBeUndefined();
  });

  /**
   * The case that decides whether a link is ever posted at all. Both emission
   * sites sit inside durable steps, and a retry that had been told "you did not
   * create it" would suppress the one post carrying the URL — leaving a
   * transcript nobody can open.
   */
  it("answers a replayed note with the same link", async () => {
    const taskId = crypto.randomUUID();
    const first = await transcribeNote(
      wired,
      note({ taskId, key: "claude:0" })
    );
    const replay = await transcribeNote(
      wired,
      note({ taskId, key: "claude:0" })
    );
    expect(replay).toBe(first);
  });

  it("keeps two tasks' transcripts apart", async () => {
    const one = await transcribeNote(wired, note());
    const other = await transcribeNote(wired, note());
    expect(one).not.toBe(other);
  });

  it("records the note under the label the thread would have shown", async () => {
    const taskId = crypto.randomUUID();
    await transcribeNote(
      wired,
      note({
        taskId,
        source: { type: "claude-code", ordinal: 2 },
        text: "hello"
      })
    );
    await settleTranscript(wired, taskId, TaskState.TASK_STATE_COMPLETED);

    const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    // The author is a field on the entry rather than brackets in the sentence,
    // because a page has a column to put it in and a thread does not.
    expect(body).toContain('"label":"claude-code 2"');
    expect(body).toContain('"text":"hello"');
    expect(body).not.toContain("[claude-code 2]");
  });

  it("throws when no binding is wired", async () => {
    // Not a deployment that chose differently — a deployment that is broken,
    // and the error says which lines it is missing. Posting the note instead
    // would hide that behind a thread that looks exactly like a working one.
    await expect(
      transcribeNote(unbound, note({ text: "unchanged" }))
    ).rejects.toThrow(ArtifactsNotBoundError);
  });

  it("posts the note unchanged before this instance knows its own origin", async () => {
    // A link needs an origin, and the origin arrives with a turn. Filing the
    // note anyway would spend the first sequence — and with it the one post
    // that could have carried the link.
    const taskId = crypto.randomUUID();
    expect(
      await transcribeNote(
        wired,
        note({ taskId, origin: undefined, text: "early" })
      )
    ).toBe("[claude-code 0] early");
    expect(
      await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId)
    ).toBeNull();
  });

  it("lets an unreachable store throw, so the step can retry", async () => {
    await expect(
      transcribeNote(broken, note({ text: "still said" }))
    ).rejects.toThrow("no such namespace");
  });

  /**
   * The lost ack, which is the case the throw is *for*.
   *
   * A durable step's failure is not "the write did not happen" — it is "nobody
   * heard whether it did". The ingest commits in the object and the answer is
   * lost on the way back, so the step retries against a store that already has
   * the note. Swallowing the failure would spend that first attempt: the note
   * would go to the thread verbatim, the retry would find sequence 1 already
   * taken by its own earlier write, and the link would never be posted by
   * anybody. Dedupe on the key is what makes the retry land on sequence 1
   * again, and the link go out.
   */
  it("delivers the link on the retry after an ack is lost", async () => {
    const taskId = crypto.randomUUID();
    const committed = note({ taskId, text: "first", key: "claude:0" });

    // The attempt whose ack never arrives: the RPC runs, and the reply is
    // dropped on the way back to the caller.
    const lossy: ArtifactsEnv = {
      ARTIFACTS: {
        idFromName: (name: string) => ns.idFromName(name),
        get(id: DurableObjectId) {
          const real = ns.get(id);
          return {
            createArtifact: (kind: string, sourceKey?: string) =>
              real.createArtifact(kind, sourceKey),
            async addEntry(token: string, entry: { key?: string }) {
              await real.addEntry(token, {
                key: entry.key,
                label: "claude-code 0",
                text: "first"
              });
              throw new Error("network error: connection lost");
            }
          };
        }
      } as unknown as DurableObjectNamespace<Artifacts>
    };

    await expect(transcribeNote(lossy, committed)).rejects.toThrow(
      "connection lost"
    );

    // What the Workflow step does next, against the store that took the write.
    const link = await transcribeNote(wired, committed);
    expect(link).toMatch(
      new RegExp(`^${ORIGIN}/a/[0-9A-Za-z]{40}$`.replace(/\//g, "\\/"))
    );

    // And recorded exactly once, not twice: the key caught the replay, so the
    // retry read back the sequence the lost attempt wrote rather than appending
    // beside it.
    await settleTranscript(wired, taskId, TaskState.TASK_STATE_COMPLETED);
    const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    expect(body.match(/"text":"first"/g)).toHaveLength(1);
  });
});

describe("settleTranscript", () => {
  it("ends the transcript in the state the task settled in", async () => {
    const taskId = crypto.randomUUID();
    await transcribeNote(wired, note({ taskId }));
    await settleTranscript(wired, taskId, TaskState.TASK_STATE_COMPLETED);

    const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    // A word a person reads, not the protocol's spelling of it: the object
    // renders whatever string it was told, verbatim.
    expect(body).toContain('"status":"completed"');
  });

  it.each([
    [TaskState.TASK_STATE_FAILED, "failed"],
    [TaskState.TASK_STATE_CANCELED, "canceled"],
    [TaskState.TASK_STATE_REJECTED, "rejected"]
  ])("renders %s as its own word", async (state, word) => {
    const taskId = crypto.randomUUID();
    await transcribeNote(wired, note({ taskId }));
    await settleTranscript(wired, taskId, state);

    const token = await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    expect(body).toContain(`"status":"${word}"`);
  });

  it("opens nothing for a task whose subagents never spoke", async () => {
    // Most tasks. A settle that created an artifact would leave one empty page
    // per task that ever ran.
    const taskId = crypto.randomUUID();
    await settleTranscript(wired, taskId, TaskState.TASK_STATE_COMPLETED);
    expect(
      await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, taskId)
    ).toBeNull();
  });

  it("throws without a binding", async () => {
    await expect(
      settleTranscript(unbound, "task-1", TaskState.TASK_STATE_COMPLETED)
    ).rejects.toThrow(ArtifactsNotBoundError);
  });

  it("never throws on a binding that is there and failing", async () => {
    // The one place the two are told apart. This runs after the terminal row is
    // durable and with no step left to retry, so a store having a bad minute
    // must not turn a task that finished into a call that failed — while a
    // missing binding, which is a line somebody can go and add, still says so.
    await expect(
      settleTranscript(broken, "task-1", TaskState.TASK_STATE_COMPLETED)
    ).resolves.toBeUndefined();
  });
});
