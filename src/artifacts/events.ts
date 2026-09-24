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
 * The sequence a reconnecting reader already has, from its `Last-Event-ID`.
 *
 * Anything unreadable means "from the start": a header a proxy mangled must
 * cost a reader duplicates, never a gap.
 */
export function resumeFrom(lastEventId: string | null): number {
  const parsed = Number.parseInt(lastEventId ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
