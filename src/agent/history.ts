import type { ModelMessage } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";

/**
 * Session-history glue for the agent runtime: parse the gatekeeper-authored `<turn>`
 * provenance wrapper, and bridge between plain text and the Agents-SDK Sessions
 * store. No A2A types cross this boundary — the {@link file://../a2a/parts.ts
 * A2A adapter} has already reduced the inbound message to a plain string.
 *
 * The gatekeeper inlines a `<turn from="…" id="…" channel="…" at="…">…</turn>` tag
 * into the message text in multi-actor channels so the model — and anything
 * downstream that needs per-message provenance — can attribute "who said what".
 * This agent only *parses* that wrapper; it never authors one.
 *
 * We persist only the user turn and the assistant's final text: intra-turn tool
 * steps stay inside the single `generateText` call, so stored history is plain
 * text messages and the conversion to AI-SDK `ModelMessage`s is trivial.
 */

/** The fields recovered from a gatekeeper-rendered `<turn>` wrapper. */
export interface ParsedTurn {
  from: string;
  /** Slack user id, as rendered. */
  id: string;
  channel: string;
  /** ISO-8601 instant. */
  at: string;
  /** The raw inner body. */
  body: string;
}

const TURN_TAG_RE = /^<turn\b([^>]*)>([\s\S]*)<\/turn>$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

const ATTR_UNESCAPES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"'
};

/** Reverse the gatekeeper's attribute escaping — single pass so `&amp;` round-trips. */
function unescAttr(value: string): string {
  return value.replace(/&(amp|lt|gt|quot);/g, (_, e) => ATTR_UNESCAPES[e]);
}

/**
 * Recover the structured provenance from a gatekeeper-authored turn. Returns null
 * for any text that isn't a `<turn>` wrapper (plain messages, assistant replies),
 * so callers can treat the provenance as optional.
 */
export function parseTurn(text: string): ParsedTurn | null {
  const m = TURN_TAG_RE.exec(text);
  if (!m) return null;
  const attrs = parseAttrs(m[1]);
  if (!attrs.from || !attrs.id || !attrs.channel || !attrs.at) return null;
  return {
    from: unescAttr(attrs.from),
    id: unescAttr(attrs.id),
    channel: unescAttr(attrs.channel),
    at: unescAttr(attrs.at),
    body: m[2]
  };
}

/**
 * Deterministic Session-message ids for the task round loop.
 *
 * A round runs inside a durable Workflow step that can re-run after a crash, so
 * its Session appends must be exactly-once. `Session.appendMessage` already
 * dedupes on message id (an id that exists is not re-written), so deriving the id
 * from the task id + round makes the append idempotent for free — no
 * read-then-write race, no duplicate turns in history on replay. Pair with
 * {@link file://./session.ts appendOnce}, which reads the durable text back so a
 * retry that re-inferred still returns the *stored* reply.
 *
 * These ids share the Session id-space with random UUIDs (plain turns) and the
 * SDK's `compaction_`-prefixed summaries; the `task:` prefix cannot collide with
 * either.
 */

/** Id of the inbound user turn for a task (appended once, by round 0). */
export function taskUserMessageId(taskId: string): string {
  return `task:${taskId}:user`;
}

/**
 * Id of the acknowledgment a **delegating** round publishes — the message the
 * user sees while that round's Subtasks run. Also the anchor a later round finds
 * to reattach the round's `delegate` call to (see
 * {@link file://../round/turn.ts renderTurnMessages}), which is why it is
 * derived from the round rather than stored.
 */
export function roundAckMessageId(taskId: string, round: number): string {
  return `task:${taskId}:round:${round}:ack`;
}

/** Matches {@link roundAckMessageId}; the trailing suffix is fixed, so the greedy
 * task-id group cannot swallow it. */
const ROUND_ACK_ID = /^task:(.+):round:(\d+):ack$/;

/**
 * Recognize an acknowledgment id — **any** Task's, not just the one being
 * rendered. A Session outlives the Task that wrote it and is shared by every Task
 * from the same caller, so its history accumulates acks the current render has no
 * branches for: earlier Tasks' acks, and (in the window between a round's ack
 * append and its Subtask rows) this Task's own. Both are the agent's scaffolding
 * rather than conversation, so both must stay out of the reference catalog; the
 * `branches`-derived anchor map alone cannot see either.
 *
 * Returns the parsed Task id and round so the caller can tell whose ack it is.
 */
export function parseRoundAckMessageId(
  id: string
): { taskId: string; round: number } | null {
  const match = ROUND_ACK_ID.exec(id);
  return match ? { taskId: match[1] as string, round: Number(match[2]) } : null;
}

/** Id of the terminal reply — the round in which the agent answered the user. */
export function finalReplyMessageId(taskId: string): string {
  return `task:${taskId}:reply:final`;
}

/**
 * Id of the question a round asked. Appended together with its answer, once the
 * answer is in, so history never holds a question nobody was shown: a round that
 * decided to ask and then crashed before posting leaves nothing behind here.
 */
export function roundAskMessageId(taskId: string, round: number): string {
  return `task:${taskId}:round:${round}:ask`;
}

/** Id of the answer to {@link roundAskMessageId}, in the words the person gave. */
export function roundAnswerMessageId(taskId: string, round: number): string {
  return `task:${taskId}:round:${round}:answer`;
}

/** A Sessions-store message with a caller-chosen (deterministic) id. */
export function deterministicSessionMessage(
  id: string,
  role: "user" | "assistant",
  text: string
): SessionMessage {
  return {
    id,
    role,
    createdAt: new Date(),
    parts: [{ type: "text", text }]
  };
}

/**
 * A Sessions-store message with a fresh random id.
 *
 * The counterpart to {@link deterministicSessionMessage}, and choosing between
 * them is a real decision rather than a style one. A deterministic id makes an
 * append **idempotent**, which is what a durable-Workflow agent needs: its round
 * can re-run after a crash, and the id is what stops the retry from duplicating a
 * turn or rewriting a reply the user already received.
 *
 * A conversational agent that answers inline has no such replay to defend
 * against — every turn is a new message and there is no step to re-enter — so a
 * random id is correct and a synthesized deterministic one would be a lie about
 * what is being deduplicated.
 */
export function sessionMessage(
  role: "user" | "assistant",
  text: string
): SessionMessage {
  return deterministicSessionMessage(crypto.randomUUID(), role, text);
}

/** Concatenate the text parts of a stored session message. */
export function sessionText(m: SessionMessage): string {
  return m.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/** Convert stored history to AI-SDK model messages (user/assistant text only). */
export function toModelMessages(history: SessionMessage[]): ModelMessage[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: sessionText(m)
    }));
}
