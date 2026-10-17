import { beforeAll, describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import type { ArtifactsEnv } from "../env.js";
import type { Artifacts } from "./do.js";
import { ARTIFACTS_OBJECT_NAME, ArtifactsNotBoundError } from "./binding.js";
import {
  SESSION_TRANSCRIPT_KIND,
  reopenTranscript,
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
 *
 * Silence is the answer only once a post has **landed**, which is the property
 * most of these turn on: the posting is best-effort by contract, so a link
 * decided by anything other than delivery is a link one dropped POST loses for
 * the rest of the task.
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
  transcript: crypto.randomUUID(),
  origin: ORIGIN,
  source: { type: "claude-code", ordinal: 0 },
  text: "Running the suite.",
  key: "claude:0",
  ...overrides
});

/** A link, as the thread would receive it. */
const LINK = new RegExp(`^${ORIGIN}/a/[0-9A-Za-z]{40}$`.replace(/\//g, "\\/"));

/**
 * A push channel, captured rather than posted.
 *
 * `landed` is the whole point of the seam: `false` is `PushChannel.working`
 * swallowing a network failure or a non-2xx, which is the case the announcement
 * exists for.
 */
function poster(landed = true) {
  const posted: string[] = [];
  return {
    posted,
    post: async (text: string): Promise<boolean> => {
      posted.push(text);
      return landed;
    }
  };
}

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
  it("posts the link once it has landed, and nothing after that", async () => {
    const transcript = crypto.randomUUID();
    const first = poster();
    await transcribeNote(
      wired,
      note({ transcript, text: "first", key: "claude:0" }),
      first.post
    );
    expect(first.posted).toHaveLength(1);
    expect(first.posted[0]).toMatch(LINK);

    // Everything after it is on the transcript and nowhere else — which is the
    // whole point: a long run used to put dozens of these in the thread.
    const rest = poster();
    await transcribeNote(
      wired,
      note({ transcript, text: "second", key: "claude:1" }),
      rest.post
    );
    await transcribeNote(
      wired,
      note({ transcript, text: "third", key: "claude:2" }),
      rest.post
    );
    expect(rest.posted).toEqual([]);
  });

  /**
   * The failure the announcement exists for.
   *
   * `PushChannel.working` swallows a network failure and a non-2xx by contract,
   * so nothing throws and no step retries. Deciding the link by "this note
   * opened the artifact" would therefore lose it for good: the artifact is no
   * longer new, and every later note would stay silent on a transcript nobody
   * has the URL for.
   */
  it("carries the link again until a post reaches the thread", async () => {
    const transcript = crypto.randomUUID();
    const dropped = poster(false);
    await transcribeNote(
      wired,
      note({ transcript, text: "first", key: "claude:0" }),
      dropped.post
    );
    expect(dropped.posted[0]).toMatch(LINK);

    // The next note carries the same link, because nothing ever arrived.
    const retried = poster();
    await transcribeNote(
      wired,
      note({ transcript, text: "second", key: "claude:1" }),
      retried.post
    );
    expect(retried.posted).toEqual([dropped.posted[0]]);

    // And now that one landed, the rest are silent.
    const after = poster();
    await transcribeNote(
      wired,
      note({ transcript, text: "third", key: "claude:2" }),
      after.post
    );
    expect(after.posted).toEqual([]);
  });

  /**
   * A replay of the note that already delivered the link says nothing, and the
   * transcript is not written twice. Both emission sites sit inside durable
   * steps, so the same note arrives again whenever a step is retried past its
   * post.
   */
  it("says nothing on a replay of the note that delivered it", async () => {
    const transcript = crypto.randomUUID();
    const first = poster();
    await transcribeNote(
      wired,
      note({ transcript, key: "claude:0" }),
      first.post
    );
    const replay = poster();
    await transcribeNote(
      wired,
      note({ transcript, key: "claude:0" }),
      replay.post
    );
    expect(first.posted[0]).toMatch(LINK);
    expect(replay.posted).toEqual([]);
  });

  it("keeps two runs' transcripts apart, each with its own link", async () => {
    const one = poster();
    const other = poster();
    await transcribeNote(wired, note(), one.post);
    await transcribeNote(wired, note(), other.post);
    expect(one.posted[0]).toMatch(LINK);
    expect(other.posted[0]).not.toBe(one.posted[0]);
  });

  it("records the note under the label the thread would have shown", async () => {
    const transcript = crypto.randomUUID();
    await transcribeNote(
      wired,
      note({
        transcript,
        source: { type: "claude-code", ordinal: 2 },
        text: "hello"
      }),
      poster().post
    );
    await settleTranscript(wired, transcript, "completed");

    const token = await artifacts().tokenFor(
      SESSION_TRANSCRIPT_KIND,
      transcript
    );
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
    const captured = poster();
    await expect(
      transcribeNote(unbound, note({ text: "unchanged" }), captured.post)
    ).rejects.toThrow(ArtifactsNotBoundError);
    expect(captured.posted).toEqual([]);
  });

  it("posts the note unchanged before this instance knows its own origin", async () => {
    // A link needs an origin, and the origin arrives with a turn. Filing the
    // note against a URL nobody could be given would only bury it.
    const transcript = crypto.randomUUID();
    const captured = poster();
    await transcribeNote(
      wired,
      note({ transcript, origin: undefined, text: "early" }),
      captured.post
    );
    expect(captured.posted).toEqual(["[claude-code 0] early"]);
    expect(
      await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, transcript)
    ).toBeNull();
  });

  /**
   * A card is one tool call. Posting those verbatim is what put one Slack
   * message per Bash, Read and Edit in front of the person, so neither fallback
   * does — while a card that is the first note still delivers the link.
   */
  describe("a note with a card", () => {
    const CARD = { ref: "t1", status: "running" as const, title: "Bash" };

    it("is never posted before this instance knows its origin", async () => {
      const captured = poster();
      await transcribeNote(
        wired,
        note({ origin: undefined, text: "npm test", detail: CARD }),
        captured.post
      );
      expect(captured.posted).toEqual([]);
    });

    it("can be the note that delivers the link, and is recorded with its card", async () => {
      const transcript = crypto.randomUUID();
      const captured = poster();
      await transcribeNote(
        wired,
        note({ transcript, text: "npm test", detail: CARD }),
        captured.post
      );
      expect(captured.posted[0]).toMatch(LINK);
      const token = await artifacts().tokenFor(
        SESSION_TRANSCRIPT_KIND,
        transcript
      );
      const read = await artifacts().readArtifact(token!);
      expect(read?.entries[0]).toMatchObject({
        text: "npm test",
        detail: CARD
      });
    });

    it("is recorded at the time it says it happened", async () => {
      const transcript = crypto.randomUUID();
      const at = Date.now() - 5_000;
      await transcribeNote(
        wired,
        note({ transcript, text: "npm test", detail: CARD, at }),
        poster().post
      );
      const token = await artifacts().tokenFor(
        SESSION_TRANSCRIPT_KIND,
        transcript
      );
      expect((await artifacts().readArtifact(token!))?.entries[0]?.at).toBe(at);
    });
  });

  it("lets an unreachable store throw, so the step can retry", async () => {
    await expect(
      transcribeNote(broken, note({ text: "still said" }), poster().post)
    ).rejects.toThrow("no such namespace");
  });

  /**
   * The lost ack, which is the case the throw is *for*.
   *
   * A durable step's failure is not "the write did not happen" — it is "nobody
   * heard whether it did". The ingest commits in the object and the answer is
   * lost on the way back, so the step retries against a store that already has
   * the note. Swallowing the failure would spend that first attempt: the note
   * would go to the thread verbatim, and then be posted a second time by the
   * retry or not at all. Dedupe on the key is what lets the retry record the
   * note once and still find a link nobody has announced.
   */
  it("delivers the link on the retry after an ack is lost", async () => {
    const transcript = crypto.randomUUID();
    const committed = note({ transcript, text: "first", key: "claude:0" });

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

    const lost = poster();
    await expect(transcribeNote(lossy, committed, lost.post)).rejects.toThrow(
      "connection lost"
    );
    expect(lost.posted).toEqual([]);

    // What the run's replay does next, against the store that took the write.
    const retried = poster();
    await transcribeNote(wired, committed, retried.post);
    expect(retried.posted[0]).toMatch(LINK);

    // And recorded exactly once, not twice: the key caught the replay, so the
    // retry read back the sequence the lost attempt wrote rather than appending
    // beside it.
    await settleTranscript(wired, transcript, "completed");
    const token = await artifacts().tokenFor(
      SESSION_TRANSCRIPT_KIND,
      transcript
    );
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    expect(body.match(/"text":"first"/g)).toHaveLength(1);
  });
});

describe("settleTranscript", () => {
  it("ends the transcript in the state the run ended in", async () => {
    const transcript = crypto.randomUUID();
    await transcribeNote(wired, note({ transcript }), poster().post);
    await settleTranscript(wired, transcript, "completed");

    const token = await artifacts().tokenFor(
      SESSION_TRANSCRIPT_KIND,
      transcript
    );
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    // A word a person reads, not the protocol's spelling of it: the object
    // renders whatever string it was told, verbatim.
    expect(body).toContain('"status":"completed"');
  });

  it.each([
    ["error", "failed"],
    ["aborted", "canceled"],
    ["interrupted", "interrupted"]
  ] as const)("renders %s as its own word", async (state, word) => {
    const transcript = crypto.randomUUID();
    await transcribeNote(wired, note({ transcript }), poster().post);
    await settleTranscript(wired, transcript, state);

    const token = await artifacts().tokenFor(
      SESSION_TRANSCRIPT_KIND,
      transcript
    );
    const body = await (
      await artifacts().fetch(new Request(`${ORIGIN}/a/${token}/events`))
    ).text();
    expect(body).toContain(`"status":"${word}"`);
  });

  it("opens nothing for a run that never spoke", async () => {
    // A settle that created an artifact would leave one empty page per run
    // that said nothing.
    const transcript = crypto.randomUUID();
    await settleTranscript(wired, transcript, "completed");
    expect(
      await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, transcript)
    ).toBeNull();
  });

  it("throws without a binding", async () => {
    await expect(
      settleTranscript(unbound, "task-1", "completed")
    ).rejects.toThrow(ArtifactsNotBoundError);
  });

  it("never throws on a binding that is there and failing", async () => {
    // The one place the two are told apart. This runs at the run's terminal,
    // with nothing left to retry, so a store having a bad minute must not turn
    // a run that finished into a call that failed — while a
    // missing binding, which is a line somebody can go and add, still says so.
    await expect(
      settleTranscript(broken, "task-1", "completed")
    ).resolves.toBeUndefined();
  });
});

describe("reopenTranscript", () => {
  /**
   * A session carried on — a plan edited, a pull request revised — goes on the
   * page it already has. Its link reached the thread the first time, so the
   * thread hears nothing new; the page streams again for whoever reloads it.
   */
  it("opens an ended transcript again, and its link is not posted twice", async () => {
    const transcript = crypto.randomUUID();
    const first = poster();
    await transcribeNote(wired, note({ transcript, key: "a:0" }), first.post);
    expect(first.posted[0]).toMatch(LINK);
    await settleTranscript(wired, transcript, "completed");
    const token = await artifacts().tokenFor(
      SESSION_TRANSCRIPT_KIND,
      transcript
    );
    expect((await artifacts().artifactState(token!))?.status).toBe("completed");

    await reopenTranscript(wired, transcript);
    expect((await artifacts().artifactState(token!))?.status).toBeNull();
    const resumed = poster();
    await transcribeNote(
      wired,
      note({ transcript, key: "b:0", text: "carrying on" }),
      resumed.post
    );
    expect(resumed.posted).toEqual([]);
    const read = await artifacts().readArtifact(token!);
    expect(read?.entries.map((e) => e.text)).toEqual([
      "Running the suite.",
      "carrying on"
    ]);
  });

  it("opens nothing for a transcript that was never written", async () => {
    const transcript = crypto.randomUUID();
    await reopenTranscript(wired, transcript);
    expect(
      await artifacts().tokenFor(SESSION_TRANSCRIPT_KIND, transcript)
    ).toBeNull();
  });

  it("throws without a binding, and never on a failing one", async () => {
    await expect(reopenTranscript(unbound, "run-1")).rejects.toThrow(
      ArtifactsNotBoundError
    );
    await expect(reopenTranscript(broken, "run-1")).resolves.toBeUndefined();
  });
});
