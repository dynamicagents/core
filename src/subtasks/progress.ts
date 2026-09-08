/**
 * How a subagent's progress note is attributed to the subagent that wrote it.
 *
 * Everything a Task posts arrives in one thread in one voice — the main agent's
 * round acknowledgement, its intermediate step text, and the notes its subagents
 * emit mid-execution — and nothing in a `working` snapshot says which of them
 * wrote a given sentence. Content does not say it either: a subagent reporting
 * what it ran reads exactly like the agent the user is talking to.
 */

/**
 * Prefix one progress note with the identity of the subagent that emitted it.
 *
 * **Text, not a field.** The A2A `working` Task carries only text parts and the
 * gatekeeper that renders them is a separate deployment, so there is no
 * structured slot to put a source in — the label has to be in the sentence.
 *
 * **`type` and `ordinal` together, always both.** They are not decoration: each
 * Subtask executes in its own throwaway child that never constructs a Session
 * and never reads parent history beyond the references on its request (see
 * {@link file://../subagent/index.ts RecipeSubagent}), so two notes under
 * different ordinals came from instances that share no memory — even when they
 * share a type, a container, and a Task. A type alone cannot separate the
 * branches of one fanned-out round, which is the case worth separating.
 * `ordinal` is Task-wide and 0-based, printed exactly as stored, so a line in
 * the thread names the same branch the logs and the `subtasks` table do.
 *
 * One label per note, and no note that would not otherwise be posted: the label
 * names an author, and a reader who wants to know what a subagent *did* reads
 * the note. Deciding which events are worth a note at all belongs to the plugin
 * that emits them, not here.
 *
 * Applied where a note is posted rather than where it is built: it is a
 * rendering step at the egress point, and the
 * {@link file://./types.ts ProgressEvent} the originating chunk returns stays
 * unlabelled.
 */
export function labelSubagentNote(
  text: string,
  source: { type: string; ordinal: number }
): string {
  return `[${source.type} ${source.ordinal}] ${text}`;
}
