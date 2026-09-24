/**
 * What a kind is, from the side that declares one.
 *
 * {@link file://./do.ts Artifacts} keys a row on a kind and renders whatever it
 * was told, so the name a person reads has to arrive from the machinery that
 * owns the kind — the same split {@link file://./transcript.ts settleTranscript}
 * makes for a settle status, and for the same reason: a translation into words
 * belongs where the thing being translated is already known.
 *
 * So a kind that wants its page titled "Session Transcript" rather than
 * `session-transcript` says so here, once, and neither the object nor the viewer
 * grows a branch per kind. The alternative — a table of names either of them
 * consults — is the same code, in the one place that is supposed to hold none of
 * it, and it answers nothing for a kind it has not heard of.
 */

/** One kind, as the machinery that owns it declares it. */
export interface ArtifactKind {
  /** What a row is keyed by: machine form, matched on, never rendered. */
  id: string;
  /**
   * The name a page prints, in the case a person reads it in. Recorded with the
   * artifact rather than resolved when the page opens — see
   * {@link file://./store.ts ArtifactStore.open}.
   */
  displayName: string;
}

/** The id, from either spelling of a kind. */
export function artifactKindId(kind: ArtifactKind | string): string {
  return typeof kind === "string" ? kind : kind.id;
}

/**
 * The name the kind declared, or `null` for one given as a bare id.
 *
 * `null` is not a defect: a caller that has only an id is opening an artifact
 * whose page falls back to that id, which is what every artifact did before a
 * kind could carry a name — see {@link file://./viewer.ts ARTIFACT_VIEWER_HTML}.
 */
export function artifactKindDisplayName(
  kind: ArtifactKind | string
): string | null {
  return typeof kind === "string" ? null : kind.displayName;
}
