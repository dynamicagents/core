import { isCompactionMessage, type SessionMessage } from "agents/sessions";
import { sessionText } from "../agent/history.js";
import type { SubtaskReference } from "./types.js";

/**
 * One entry of the ephemeral, per-round reference catalog: a verbatim
 * `user`/`assistant` turn plus the 1-based index the model selects it by.
 * Structurally a {@link SubtaskReference} with an `index`, so selecting an entry
 * and snapshotting it onto a Subtask is a plain subset copy.
 */
export interface ReferenceCatalogEntry extends SubtaskReference {
  /** 1-based, ephemeral, per-round index the model references. */
  index: number;
}

/**
 * Whether a history message is a referenceable turn: a verbatim `user` or
 * `assistant` turn with actual content.
 *
 * Compaction summaries are excluded via the SDK's `isCompactionMessage` (their
 * `compaction_` id prefix) — they are generated text, never original conversation
 * evidence. Whitespace-only turns are excluded because there is nothing to
 * reference.
 *
 * This is the single eligibility rule, and it has exactly one caller:
 * {@link file://../round/turn.ts renderTurnMessages} numbers the messages it accepts
 * *and* marks those same messages with their `[ref N]` index, in one pass. One
 * predicate, one walk — the marked messages and the catalog indices cannot drift.
 *
 * What that leaves eligible: verbatim `user` and `assistant` turns with content.
 * System prompts, context blocks, and anything a tool injected never appear as
 * plain history messages, so they are excluded structurally. Whitespace-only
 * turns are skipped — there is nothing to reference, and since the model only
 * ever selects from the catalog the renderer returns, skipping them cannot
 * misalign indices.
 *
 * The inbound user turn is appended to the Session before the round infers, so
 * one catalog covers both the current task input and past turns. The selected
 * entries' exact text is snapshotted onto the Subtask when the round delegates,
 * so nothing is resolved lazily and later compaction cannot affect a Subtask in
 * flight.
 */
export function isCatalogEligible(message: SessionMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (isCompactionMessage(message)) return false;
  return sessionText(message).trim().length > 0;
}
