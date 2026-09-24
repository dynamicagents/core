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
 * **Nothing happens until a deployment binds the namespace.** Every helper
 * resolves to what the caller did before, so an agent that wires nothing keeps
 * posting every note to its thread, unchanged. A consumer opts in by exporting
 * {@link Artifacts} from its Worker, declaring the binding, and adding the one
 * line {@link handleArtifactRoute} documents.
 */

export { Artifacts } from "./do.js";

export {
  ARTIFACTS_BINDING,
  ARTIFACTS_OBJECT_NAME,
  artifactsBinding,
  artifactsStub,
  type ArtifactsEnv
} from "./binding.js";

export { handleArtifactRoute } from "./route.js";

export {
  ARTIFACT_PATH_PREFIX,
  artifactViewerUrl,
  parseArtifactPath,
  type ArtifactRoute
} from "./path.js";

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
  SESSION_TRANSCRIPT_KIND,
  settleTranscript,
  transcribeNote,
  type SubagentNote
} from "./transcript.js";
