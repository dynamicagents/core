import type { ArtifactsEnv } from "../env.js";
import { requireArtifactsStub } from "./binding.js";

/** The label a person's answer to an approval is filed under. */
export const APPROVAL_LABEL = "approval";

/**
 * File a person's answer on the artifact their approval was about, and lock it
 * in the same call when they approved: what they approved is what stays behind
 * the link. Keyed on the question, so an answer delivered twice is filed once.
 *
 * Answers whether it was filed — `false` when another answer locked the
 * artifact first, or it is gone.
 */
export async function fileApproval(
  env: ArtifactsEnv,
  artifact: string,
  answer: { key: string; text: string; approved: boolean }
): Promise<boolean> {
  const filed = await requireArtifactsStub(env).addEntry(
    artifact,
    { label: APPROVAL_LABEL, text: answer.text, key: answer.key },
    answer.approved ? { lock: "approved" } : {}
  );
  return filed !== null;
}
