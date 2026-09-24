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
 * ## Dormant without a binding
 *
 * Every function here resolves to "post what you would have posted" when no
 * `ARTIFACTS` namespace is bound, when this deployment does not yet know its
 * own origin, and when the ingest fails for any reason at all. A transcript is
 * a place to put notes, not a dependency of the turn that writes them — so the
 * note reaching the person always wins over the note being filed.
 */

import { TaskState } from "@a2a-js/sdk";
import { labelSubagentNote, subagentNoteLabel } from "../subtasks/progress.js";
import { artifactsStub } from "./binding.js";
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
  env: object,
  note: SubagentNote
): Promise<string | undefined> {
  const asPosted = (): string => labelSubagentNote(note.text, note.source);
  try {
    // Inside the `try`, not before it: reading the binding and addressing the
    // object are as much a part of "the transcript is unreachable" as the RPC
    // is, and a malformed binding must not be the one that gets through.
    const stub = artifactsStub(env);
    if (!stub || note.origin === undefined) return asPosted();
    const token = await stub.createArtifact(
      SESSION_TRANSCRIPT_KIND,
      note.taskId
    );
    const sequence = await stub.addEntry(token, {
      key: note.key,
      label: subagentNoteLabel(note.source),
      text: note.text
    });
    // `null` is retention having swept the artifact between the two calls.
    if (sequence === null) return asPosted();
    return sequence === 1 ? artifactViewerUrl(note.origin, token) : undefined;
  } catch (err) {
    // Swallowed on the same principle the push channel swallows its own
    // failures: a run that cannot file its notes is still a run that should
    // report them. Falling back to the note means an outage costs a thread its
    // brevity, never its content.
    console.warn("[artifacts] note not transcribed", {
      taskId: note.taskId,
      key: note.key,
      err: String(err)
    });
    return asPosted();
  }
}

/**
 * End the task's transcript in the state the task settled in.
 *
 * Best-effort and silent about a task that never opened one, which is most of
 * them: a task whose subagents said nothing has no transcript to end.
 */
export async function settleTranscript(
  env: object,
  taskId: string,
  state: TaskState
): Promise<void> {
  try {
    const stub = artifactsStub(env);
    if (!stub) return;
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
