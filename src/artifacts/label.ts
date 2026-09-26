/**
 * How a sub-agent's note is attributed to the run that wrote it.
 *
 * Everything a task posts arrives in one thread in one voice, and nothing in a
 * `working` snapshot says who wrote a sentence: a sub-agent reporting what it
 * ran reads exactly like the agent the user is talking to.
 */

/** Who is speaking: the sub-agent class and the run's per-parent ordinal. */
export interface NoteSource {
  type: string;
  ordinal: number;
}

/**
 * Prefix one note with its author. **Text, not a field**: the A2A `working`
 * task carries only text parts, so the label has to be in the sentence.
 *
 * `type` and `ordinal` together, always: two runs of one sub-agent class share
 * no memory, and a type alone cannot tell them apart.
 */
export function labelSubagentNote(text: string, source: NoteSource): string {
  return `[${subagentNoteLabel(source)}] ${text}`;
}

/**
 * The author half, without the brackets — for a renderer with a slot to put a
 * source in, such as the transcript's column.
 */
export function subagentNoteLabel(source: NoteSource): string {
  return `${source.type} ${source.ordinal}`;
}
