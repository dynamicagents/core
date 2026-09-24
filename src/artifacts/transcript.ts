/**
 * The session transcript — the first {@link file://./do.ts Artifacts} kind, and
 * the glue core's own machinery calls.
 *
 * ## The problem it solves
 *
 * A delegating round posts a labelled note every time a subagent has something
 * to say, and every one of them lands in the thread the person is reading, in
 * the same voice as the answer they are waiting for. A long run can produce
 * dozens. The notes are worth keeping — they are the only account of what the
 * run actually did — but a thread is the wrong place to keep them.
 *
 * So they go somewhere with a link, and the thread gets the link. A labelled
 * note is posted as that link until one such post **lands**; every note after
 * that is recorded and not posted at all. Main-agent progress — a round's
 * acknowledgement, its step text — is untouched: it is the conversation, not an
 * account of one.
 *
 * ## Why delivery, and not the sequence, is what ends the posting
 *
 * The obvious rule is "the note that opened the artifact carries the link", and
 * it loses the link outright. Posting is `PushChannel.working`, which swallows a
 * network failure and a non-2xx by contract, so under that rule a link whose one
 * post did not arrive is never offered again — and every later note, seeing an
 * artifact that is no longer new, stays silent on a transcript nobody can open.
 *
 * So the link is offered until a post reports that it landed, and that fact is
 * durable in the artifact rather than in the isolate that sent it: see
 * {@link file://./do.ts Artifacts.announce}. Two notes in flight at once can
 * both find it un-announced and both carry the link, which is the failure mode
 * chosen here — a thread with the link twice, rather than a thread without it.
 *
 * ## When the thread gets the note instead
 *
 * Twice, and both are facts about *this note* rather than about the wiring:
 * this deployment has not learned its own origin yet, so there is no link to
 * post; or retention has swept the artifact out from under the write, so there
 * is no longer one to link to. Neither can be fixed by the caller and neither
 * should cost the person the note, so both post it verbatim.
 *
 * An ingest that *fails* is not one of them, and does not fall back to posting
 * the note either. Both emission sites run inside durable steps, so the useful
 * answer to a store that did not take the write is to let the step retry — the
 * artifact dedupes on {@link SubagentNote.key}, so the replay records the note
 * once and finds the link still unannounced. Swallowing the failure here is what
 * would lose the note: it would be filed by an attempt that then failed, or
 * posted verbatim beside a transcript that already had it.
 */

import { TaskState } from "@a2a-js/sdk";
import {
  humanSubagentNoteLabel,
  labelSubagentNote,
  subagentNoteLabel
} from "../subtasks/progress.js";
import type { ArtifactsEnv } from "../env.js";
import { assertArtifactsBound, requireArtifactsStub } from "./binding.js";
import type { ArtifactKind } from "./kind.js";
import { artifactViewerUrl } from "./path.js";

/**
 * The kind a task's progress notes are recorded under, and the name its page is
 * titled with — see {@link file://./kind.ts ArtifactKind} for why the name is
 * declared here rather than known by the object or the viewer.
 */
export const SESSION_TRANSCRIPT: ArtifactKind = {
  id: "session-transcript",
  displayName: "Session Transcript"
};

/** Its id alone, for a caller that has nothing to open. */
export const SESSION_TRANSCRIPT_KIND = SESSION_TRANSCRIPT.id;

/** One labelled note, as both emission sites hold it. */
export interface SubagentNote {
  /** The task whose transcript this belongs on — the artifact's source key. */
  taskId: string;
  /**
   * This deployment's own public origin, for the link. Absent on an instance no
   * turn has reached yet, which is the one case that cannot produce a usable
   * link — see {@link file://../a2a/self-origin.ts SelfOrigin}.
   */
  origin: string | undefined;
  /** Who is speaking. Both halves, always — see `labelSubagentNote`. */
  source: { type: string; ordinal: number };
  text: string;
  /**
   * The notification key this note would be posted under: derived from
   * position, so it is stable across a replay. It is the dedupe id on both
   * sides — the gatekeeper's, and the artifact's.
   */
  key: string;
}

/**
 * Record one labelled note on its task's transcript, and post what the thread
 * should get for it: the link, the note itself, or nothing at all.
 *
 * `post` is handed the text and answers whether it **reached** the thread —
 * `PushChannel.working` is the one both emission sites pass. The posting is
 * inverted into this function, rather than left to the caller with a decision
 * returned, because the answer to "did it land" is what decides whether the link
 * is offered again, and a caller that forgot to say costs the person the link
 * for the rest of the task. Nothing here reads the result of a post that carried
 * the note verbatim: there is nothing further to do about one.
 */
export async function transcribeNote(
  env: ArtifactsEnv,
  note: SubagentNote,
  post: (text: string) => Promise<boolean>
): Promise<void> {
  // Before the store is touched: there is no link to announce on a turn with no
  // origin to build one out of, and filing the note would only bury it on a
  // transcript nothing has pointed at yet.
  if (note.origin === undefined) {
    await post(labelSubagentNote(note.text, note.source));
    return;
  }

  const stub = requireArtifactsStub(env);
  const token = await stub.createArtifact(SESSION_TRANSCRIPT, note.taskId);
  const recorded = await stub.addEntry(token, {
    key: note.key,
    label: subagentNoteLabel(note.source),
    text: note.text
  });
  // `null` is retention having swept the artifact between the two calls. Rare,
  // and not worth a retry: the note is a month old by construction, so the
  // thread gets it and the run goes on.
  if (recorded === null) {
    await post(labelSubagentNote(note.text, note.source));
    return;
  }
  if (recorded.announced) return;
  // Named, not bare: this lands in a thread beside the answer the person is
  // waiting for, and a URL on its own says neither what it opens nor which
  // branch of a fanned-out round opened it. The name is the note's own label as
  // prose — see {@link file://../subtasks/progress.ts humanSubagentNoteLabel}.
  const announcement =
    `Subtask Session (${humanSubagentNoteLabel(note.source)}): ` +
    artifactViewerUrl(note.origin, token);
  // The link first, the fact that it arrived second — in that order, because the
  // failure that lands between them costs a duplicate link and the other order
  // costs the only one. `announce` is unguarded for the reason the ingest above
  // is: inside a durable step, a store that would not take the write is worth a
  // retry, and the retry finds the note recorded and the link still to announce.
  if (await post(announcement)) {
    await stub.announce(token);
  }
}

/**
 * End the task's transcript in the state the task settled in.
 *
 * Silent about a task that never opened one, which is most of them: a task
 * whose subagents said nothing has no transcript to end.
 *
 * The RPC is best-effort where {@link transcribeNote}'s is not, and the
 * difference is what the caller can still do about it. This runs from
 * `DynamicAgent`'s settle path, *after* the terminal row is durable and with no
 * step left to retry — so a store that will not take the settle must not turn a
 * task that finished into a call that failed. The binding itself is checked
 * outside that, because an unbound namespace is a wiring fault rather than an
 * outage and has a fix worth raising.
 */
export async function settleTranscript(
  env: ArtifactsEnv,
  taskId: string,
  state: TaskState
): Promise<void> {
  // Outside the `try`, and the only thing that is: this raises
  // `ArtifactsNotBoundError`, which names a line a deployment is missing and
  // cannot be mistaken for a store having a bad minute. Everything else —
  // addressing the object included — is the store having a bad minute.
  assertArtifactsBound(env);
  try {
    const stub = requireArtifactsStub(env);
    const token = await stub.tokenFor(SESSION_TRANSCRIPT, taskId);
    if (token === null) return;
    await stub.settle(token, settleStatus(state));
  } catch (err) {
    console.warn("[artifacts] transcript not settled", {
      taskId,
      err: String(err)
    });
  }
}

/**
 * A `TaskState` as the page prints it.
 *
 * The object stores whatever string it is told and renders it verbatim, so the
 * translation from a protocol enum to a word a person reads belongs on this
 * side — where the enum is already known — and not in a kind-generic store.
 */
function settleStatus(state: TaskState): string {
  return (TaskState[state] ?? "unspecified")
    .replace("TASK_STATE_", "")
    .toLowerCase();
}
