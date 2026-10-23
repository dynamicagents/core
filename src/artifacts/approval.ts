import type { ArtifactsEnv } from "../env.js";
import { requireArtifactsStub } from "./binding.js";

/** The label a person's answer to an approval is filed under. */
export const APPROVAL_LABEL = "approval";

/**
 * File a person's answer on the artifact their approval was about, and lock it
 * in the same call when they approved: what they approved is what stays behind
 * the link. Keyed on the question, so an answer delivered twice is filed once.
 *
 * `answer.owner` is who is filing, and the store refuses the write unless the
 * artifact was opened by them. It is passed here rather than trusted from the
 * question that was parked, so the authority is re-established at the write:
 * the ask-time check and this one are the same question asked twice, of durable
 * state, by an object whose own identity cannot have changed in between.
 *
 * Answers whether it was filed — `false` when the artifact is not this
 * caller's, when another answer locked it first, when it had already settled
 * under an approval that would have to re-stamp it, or when it is gone.
 */
export async function fileApproval(
  env: ArtifactsEnv,
  artifact: string,
  answer: { key: string; text: string; approved: boolean; owner: string }
): Promise<boolean> {
  const filed = await requireArtifactsStub(env).addEntry(
    artifact,
    { label: APPROVAL_LABEL, text: answer.text, key: answer.key },
    {
      owner: answer.owner,
      ...(answer.approved ? { lock: "approved" } : {})
    }
  );
  return filed !== null;
}
