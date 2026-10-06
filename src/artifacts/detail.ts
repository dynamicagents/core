/**
 * What an entry shows when it is opened — a card, in the viewer's terms.
 *
 * Generic on purpose: {@link file://./viewer.ts the viewer} renders a title, a
 * status, sections and a checklist, and never learns what produced them. A
 * writer that knows its domain — a Claude Code session's tools, a Think
 * sub-agent's — decides what goes in each slot.
 *
 * ## A card is completed by a second entry, not by an update
 *
 * The log stays append-only. A tool's call and its result are two entries
 * sharing {@link ArtifactEntryDetail.ref}, and the viewer folds the second into
 * the first. An update in place would need a second kind of frame and a resume
 * point that is not a sequence; folding at render keeps `Last-Event-ID` and the
 * entry key the only two mechanisms there are.
 */

/** How a section's body is set. Plain text when absent. */
export type EntrySectionFormat = "text" | "code" | "diff" | "markdown";

export interface EntrySection {
  /** Its heading — `Input`, `Output`. */
  label: string;
  body: string;
  format?: EntrySectionFormat;
}

export type ChecklistState = "pending" | "active" | "done";

export interface ChecklistItem {
  text: string;
  state: ChecklistState;
}

/** A card's state. The latest entry for a {@link ArtifactEntryDetail.ref} wins. */
export type EntryStatus = "running" | "ok" | "error";

export interface ArtifactEntryDetail {
  /** Groups entries into one card: a later entry with the same ref completes it. */
  ref?: string;
  status?: EntryStatus;
  /** A short monospace label, such as a tool's name. */
  title?: string;
  /** The collapsed body. */
  sections?: EntrySection[];
  /** Rendered open, and the latest one is pinned above the log. */
  checklist?: ChecklistItem[];
}

/**
 * The most of one section body an entry keeps, in characters.
 *
 * A ceiling, not a taste: a Durable Object's SQLite value tops out at 2 MB, and
 * a `cat` of a build log passes it — the write throws and the note is lost. The
 * value is set for a person reading a card, far below that. A writer clips
 * with {@link clipEntryBody} **before** its note is persisted anywhere, since
 * a sub-agent's milestone is the same kind of value in the same kind of store;
 * {@link readEntryDetail} clips again, so nothing past it reaches a reader.
 */
export const ENTRY_SECTION_MAX_CHARS = 8 * 1024;

/**
 * `text` cut to `max` characters, keeping its head and its tail.
 *
 * Both ends because both carry the news: a command's first lines say what it
 * ran, its last say how it ended. The cut is moved to a line boundary when one
 * is near, so neither half ends mid-line.
 */
export function clipEntryBody(
  text: string,
  max: number = ENTRY_SECTION_MAX_CHARS
): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  let headEnd = half;
  const lastBreak = text.lastIndexOf("\n", half);
  if (lastBreak > half / 2) headEnd = lastBreak;
  let tailStart = text.length - half;
  const nextBreak = text.indexOf("\n", tailStart);
  if (nextBreak !== -1 && nextBreak < tailStart + half / 2) {
    tailStart = nextBreak + 1;
  }
  const elided = text.slice(headEnd, tailStart);
  const lines = elided.split("\n").length - 1;
  const marker =
    lines > 0
      ? `… ${lines} line${lines === 1 ? "" : "s"} elided …`
      : `… ${elided.length} characters elided …`;
  return `${text.slice(0, headEnd)}\n${marker}\n${text.slice(tailStart)}`;
}

const FORMATS = new Set<string>(["text", "code", "diff", "markdown"]);
const STATES = new Set<string>(["pending", "active", "done"]);
const STATUSES = new Set<string>(["running", "ok", "error"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * A detail as this store keeps it, from whatever arrived — or `undefined` when
 * nothing usable did.
 *
 * Every door a detail comes through runs this: a sub-agent's milestone is
 * `unknown` by the time a parent reads it, and the store's own column is JSON.
 * What is malformed is dropped field by field, never thrown: a card that lost
 * its checklist is still a card, and a note is never worth losing over its
 * detail.
 */
export function readEntryDetail(
  value: unknown
): ArtifactEntryDetail | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const detail: ArtifactEntryDetail = {};
  const ref = str(raw.ref);
  if (ref) detail.ref = ref;
  const status = str(raw.status);
  if (status && STATUSES.has(status)) detail.status = status as EntryStatus;
  const title = str(raw.title);
  if (title) detail.title = title;
  if (Array.isArray(raw.sections)) {
    const sections: EntrySection[] = [];
    for (const item of raw.sections) {
      const section = record(item);
      if (!section || typeof section.body !== "string") continue;
      const format = str(section.format);
      sections.push({
        label: typeof section.label === "string" ? section.label : "",
        body: clipEntryBody(section.body),
        ...(format && FORMATS.has(format)
          ? { format: format as EntrySectionFormat }
          : {})
      });
    }
    if (sections.length > 0) detail.sections = sections;
  }
  if (Array.isArray(raw.checklist)) {
    const checklist: ChecklistItem[] = [];
    for (const item of raw.checklist) {
      const entry = record(item);
      const text = entry && str(entry.text);
      const state = entry && str(entry.state);
      if (!text || !state || !STATES.has(state)) continue;
      checklist.push({ text, state: state as ChecklistState });
    }
    // Kept when empty: a list cleared is news, and the pinned one must go.
    detail.checklist = checklist;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}
