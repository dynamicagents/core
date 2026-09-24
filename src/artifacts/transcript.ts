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
 * So they go somewhere with a link, and the thread gets the link. The **first**
 * labelled note of a task is posted as that link and nothing else; every note
 * after it is recorded and not posted at all. Main-agent progress — a round's
 * acknowledgement, its step text — is untouched: it is the conversation, not an
 * account of one.
 *
 * ## When the thread gets the note instead
 *
 * Twice, and both are facts about *this note* rather than about the wiring:
 * this deployment has not learned its own origin yet, so there is no link to
 * post; or retention has swept the artifact out from under the write, so there
 * is no longer one to link to. Neither can be fixed by the caller and neither
 * should cost the person the note, so both post it verbatim.
 *
 * An ingest that *fails* is not one of them. Both emission sites run inside
 * durable steps, so the useful answer to a store that did not take the write is
 * to let the step retry — the artifact dedupes on {@link SubagentNote.key}, so
 * the replay lands on the sequence it would have had and the link still goes
 * out. Swallowing the failure here is what would lose it, by consuming the one
 * post that carries the URL on an attempt that filed nothing.
 */

import { TaskState } from "@a2a-js/sdk";
import { labelSubagentNote, subagentNoteLabel } from "../subtasks/progress.js";
import type { ArtifactsEnv } from "../env.js";
import { assertArtifactsBound, requireArtifactsStub } from "./binding.js";
import { artifactViewerUrl } from "./path.js";

/** The kind a task's progress notes are recorded under. */
export const SESSION_TRANSCRIPT_KIND = "session-transcript";

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
 * Record one labelled note on its task's transcript, and answer what the push
 * channel should carry now: the note itself, the link, or nothing.
 *
 * `undefined` means the transcript has it and the thread needs nothing more.
 *
 * **Why the link is decided by the sequence** rather than by "did this call
 * create the artifact": both emission sites run inside durable steps that can
 * be retried, and a retry that re-created nothing would suppress the one post
 * that carries the link — leaving a transcript nobody has the URL for. The
 * artifact dedupes on {@link SubagentNote.key}, so a replayed note lands on the
 * sequence it had the first time, and "sequence 1" stays true however many
 * times the step runs.
 */
export async function transcribeNote(
  env: ArtifactsEnv,
  note: SubagentNote
): Promise<string | undefined> {
  // Before the store is touched: filing the note anyway would spend the first
  // sequence — and with it the one post that could have carried the link — on a
  // turn that has no origin to build a link out of.
  if (note.origin === undefined)
    return labelSubagentNote(note.text, note.source);

  const stub = requireArtifactsStub(env);
  const token = await stub.createArtifact(SESSION_TRANSCRIPT_KIND, note.taskId);
  const sequence = await stub.addEntry(token, {
    key: note.key,
    label: subagentNoteLabel(note.source),
    text: note.text
  });
  // `null` is retention having swept the artifact between the two calls. Rare,
  // and not worth a retry: the note is a month old by construction, so the
  // thread gets it and the run goes on.
  if (sequence === null) return labelSubagentNote(note.text, note.source);
  return sequence === 1 ? artifactViewerUrl(note.origin, token) : undefined;
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
    const token = await stub.tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
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
