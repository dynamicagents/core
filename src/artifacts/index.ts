/**
 * `@dynamicagents/core/artifacts` — what a run had to say, stored behind a link.
 *
 * A **general** store first and a transcript second. An artifact is a kind, a
 * token, an append-only list of labelled notes and a settle status; nothing in
 * {@link Artifacts} knows what a kind means or when a run is finished, because
 * the machinery that owns the work is the only thing that does. The first kind
 * is `session-transcript` and it needs no code inside the object, which is how
 * the split is checked.
 *
 * Three pieces, wired independently:
 *
 * - **The object** — {@link Artifacts}, one per deployment, bound as `ARTIFACTS`.
 * - **The routes** — {@link handleArtifactRoute}, one delegation from a Worker's
 *   `fetch`, serving the viewer page and the event stream behind it.
 * - **The emission** — {@link transcribeNote} and {@link settleTranscript},
 *   which core's round and subagent machinery already call.
 *
 * **The binding is required**, and a deployment that omits it fails at DO
 * start with the lines it is missing — see
 * {@link file://./binding.ts ArtifactsNotBoundError}. Wiring it is exporting
 * {@link Artifacts} from the Worker, declaring the namespace and its migration
 * in `wrangler.jsonc`, and adding the one line {@link handleArtifactRoute}
 * documents. Nothing here degrades to posting every note to the thread,
 * because that is the behaviour the link exists to replace.
 */

export { Artifacts, type RecordedNote } from "./do.js";

export {
  ARTIFACTS_BINDING,
  ARTIFACTS_OBJECT_NAME,
  ArtifactsNotBoundError,
  assertArtifactsBound,
  requireArtifactsStub
} from "./binding.js";

export type { ArtifactsEnv } from "../env.js";

export { handleArtifactRoute } from "./route.js";

export {
  ARTIFACT_PATH_PREFIX,
  artifactViewerUrl,
  parseArtifactPath,
  type ArtifactRoute
} from "./path.js";

export type { ArtifactKind } from "./kind.js";

export {
  ARTIFACT_RETENTION_MS,
  mintArtifactToken,
  type AppendResult,
  type Artifact,
  type ArtifactEntry,
  type ArtifactEntryInput
} from "./store.js";

export {
  ARTIFACT_EVENTS,
  type ReadyEvent,
  type SettledEvent
} from "./events.js";

export { ARTIFACT_VIEWER_HTML, artifactViewerResponse } from "./viewer.js";

export {
  SESSION_TRANSCRIPT,
  SESSION_TRANSCRIPT_KIND,
  settleTranscript,
  transcribeNote,
  type SubagentNote
} from "./transcript.js";
