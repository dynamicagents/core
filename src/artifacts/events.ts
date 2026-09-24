/**
 * What an artifact's event stream carries, and how a frame is spelled.
 *
 * Its own module because both ends read it: the Durable Object writes these
 * frames ({@link file://./do.ts Artifacts}) and the page parses them
 * ({@link file://./viewer.ts ARTIFACT_VIEWER_HTML}), and a wire format with two
 * independent spellings is a wire format that drifts.
 */

import type { ArtifactEntry } from "./store.js";

/**
 * The event names on the wire.
 *
 * `ready` rather than `open`: a server-sent event named `open` arrives through
 * the same `EventSource` listener slot as the native connection-opened event,
 * and the two then cannot be told apart.
 */
export const ARTIFACT_EVENTS = {
  /** The artifact itself — its kind, and its status if it has already settled. */
  ready: "ready",
  /** One appended note. Carries the sequence as the SSE event id. */
  entry: "entry",
  /** The status the artifact finished in. The last frame on the stream. */
  settled: "settled"
} as const;

/** The first frame on every stream. `status` is non-null for a replay. */
export interface ReadyEvent {
  kind: string;
  /**
   * What the page titles itself, as the kind declared it — `null` for an
   * artifact opened under a bare id, which the page renders from `kind`
   * instead. See {@link file://./kind.ts ArtifactKind}.
   */
  displayName: string | null;
  status: string | null;
}

/** The terminal frame. Nothing follows it; the stream closes. */
export interface SettledEvent {
  status: string;
}

/** One frame, ready to write. `id` is what a reconnect resumes from. */
export function sseFrame(
  event: string,
  data: ReadyEvent | ArtifactEntry | SettledEvent,
  id?: number
): string {
  // `JSON.stringify` cannot emit a raw newline inside a string, which is what
  // would otherwise split one `data:` line into two frames.
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * What a whole `Last-Event-ID` may say, and nothing else.
 *
 * Anchored both ends because the alternative — `parseInt` — reads a numeric
 * *prefix*: `2garbage` and `2.5` both come back as 2, so a mangled header would
 * be honoured as a resume point and silently cost the reader every entry before
 * it. The ids this stream writes are decimal sequences, so anything else is not
 * a value to salvage.
 */
const SEQUENCE = /^\d+$/;

/**
 * The sequence a reconnecting reader already has, from its `Last-Event-ID`.
 *
 * Anything unreadable means "from the start": a header a proxy mangled must
 * cost a reader duplicates, never a gap.
 */
export function resumeFrom(lastEventId: string | null): number {
  if (lastEventId === null || !SEQUENCE.test(lastEventId)) return 0;
  const parsed = Number(lastEventId);
  // Enough digits to leave the safe range is not a sequence this stream wrote.
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
