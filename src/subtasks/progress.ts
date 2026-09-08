/**
 * How a subagent's progress note is attributed to the subagent that wrote it.
 *
 * Every `working` snapshot a Task posts arrives in one place, in one voice: the
 * main agent's round acknowledgement, its intermediate step text, and the notes
 * its subagents emit mid-execution all land in the same thread with nothing to
 * tell them apart. A reader could not tell which sentence the agent they are
 * talking to wrote and which came out of a subagent it delegated to — they had
 * to infer it from content, and content is exactly what does not say.
 *
 * This is **not** a reversal of the policy in
 * {@link file://../../../plugins/src/claude-code/events.ts describe}, which
 * deleted the per-message tool-name prefix. That prefix cost one Slack message
 * per Bash/Read/Edit and named a tool the reader could not act on. This one adds
 * no messages and names the author of a note that was going to be posted
 * anyway.
 */

/**
 * Prefix one progress note with the identity of the subagent that emitted it.
 *
 * **Text, not a field.** The A2A `working` Task carries only text parts and the
 * gatekeeper that renders them lives in another repo, so there is no structured
 * slot to put a source in — the label has to be in the sentence.
 *
 * **`type` and `ordinal` together, always both.** They are not decoration: each
 * Subtask executes in its own throwaway child that never constructs a Session
 * and never reads parent history beyond the references on its request (see
 * {@link file://../subagent/index.ts RecipeSubagent}), so two notes under
 * different ordinals came from instances that share no memory — even when they
 * share a type, a container, and a Task. `ordinal` is Task-wide and 0-based,
 * printed exactly as it is stored, so a line in the thread names the same
 * branch the logs and the `subtasks` table do.
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
