import type { ToolSet } from "ai";
import type { SessionMessage } from "agents/sessions";
import type { SessionLike } from "../agent/session.js";

/**
 * An in-memory {@link SessionLike} standing in for the DO's real continuous
 * Session. Shared by the turn, decomposition, and composition specs so a change
 * to the Session contract breaks in one place.
 *
 * Mirrors the two real behaviors the phased pipeline depends on:
 *
 * - `appendMessage` **dedupes by id** — appending an existing id is a no-op, the
 *   property that makes deterministic-id appends exactly-once on a step re-run.
 * - `getMessage` reads the raw stored message back.
 */
export class FakeSession implements SessionLike {
  messages: SessionMessage[] = [];
  system = "SOUL BLOCK\n\n## memory\n(empty)";
  /** Compaction overlays to report — non-empty ⇒ history has been displaced. */
  compactions: unknown[] = [];

  appendMessage(m: SessionMessage) {
    if (this.messages.some((existing) => existing.id === m.id)) return;
    this.messages.push(m);
  }
  async getHistory() {
    return this.messages;
  }
  async getMessage(id: string) {
    return this.messages.find((m) => m.id === id) ?? null;
  }
  async refreshSystemPrompt() {
    return this.system;
  }
  async tools(): Promise<ToolSet> {
    return {};
  }
  async getCompactions() {
    return this.compactions;
  }
}
