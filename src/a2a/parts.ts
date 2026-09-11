import { Role, type Message, type Part } from "@a2a-js/sdk";
import type { PlainMessage, PlainPart } from "./task.js";

/**
 * Constructors and readers for A2A v1.0 message content — the one place the
 * adapter reaches into the `@a2a-js/sdk` message shape. Everything past
 * {@link file://./executor.ts A2AExecutor} works in plain strings, so the agent
 * runtime never sees an A2A type.
 *
 * The v1.0 data model is generated from the protobuf schema, so the wire types
 * are "all fields present": a `Part` carries a `content` oneof discriminated by
 * `$case` (plus `filename`/`mediaType`) instead of v0.3's `kind`, and a
 * `Message` carries empty strings and empty arrays rather than omitted
 * optionals. Hand-writing those literals at every call site is noisy and easy to
 * get subtly wrong, so every part/message this agent emits is built here.
 */

/** Media type stamped on the text parts this agent emits. */
const TEXT_MEDIA_TYPE = "text/plain";

/** Media type stamped on the structured parts this agent emits. */
const DATA_MEDIA_TYPE = "application/json";

/**
 * A `text` part carrying `text`. Typed as the narrowed {@link PlainPart} (which
 * widens to `Part` for free) so a message built here can cross the DO RPC
 * boundary — see {@link file://./task.ts}.
 */
export function textPart(text: string): PlainPart {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: TEXT_MEDIA_TYPE
  };
}

/**
 * A `data` part carrying a structured value.
 *
 * The SDK's own `Part`, not {@link PlainPart}: that one admits only text, which
 * is what lets a Task cross Durable Object RPC typed (see
 * {@link file://./task.ts}). Whatever carries one of these is built and sent from
 * inside the object that holds it.
 */
export function dataPart(value: object): Part {
  return {
    content: { $case: "data", value },
    metadata: undefined,
    filename: "",
    mediaType: DATA_MEDIA_TYPE
  };
}

/** Concatenate the text of every `text` part, trimming surrounding whitespace. */
export function partsText(parts: Part[] | undefined): string {
  let out = "";
  for (const part of parts ?? []) {
    if (part.content?.$case === "text") out += part.content.value;
  }
  return out.trim();
}

/** The plain-text content of an inbound A2A message (what the caller said). */
export function textOf(message: Message): string {
  return partsText(message.parts);
}

/**
 * Bounds the inbound user text carried in a durable Workflow payload (UTF-8).
 * Workflow params have a platform size limit, and a caller's message is the one
 * unbounded thing that goes into them.
 */
export const MAX_INBOUND_TEXT_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/** Invalid inbound content that must not cross the A2A-to-workflow boundary. */
export class InboundPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundPartError";
  }
}

/**
 * Extract and validate the user-turn text. Rejects a message with no usable
 * text, and enforces a single UTF-8 size bound *before* the text enters a
 * workflow payload — past that point the failure is a workflow that will not
 * start, with no request left to answer on.
 *
 * File and data parts are deliberately out of scope: only text crosses into the
 * agent runtime.
 */
export function inboundText(message: Message): string {
  const text = textOf(message);
  if (!text) {
    throw new InboundPartError("message has no usable text");
  }
  if (encoder.encode(text).byteLength > MAX_INBOUND_TEXT_BYTES) {
    throw new InboundPartError("message text exceeds the size limit");
  }
  return text;
}

/**
 * An `agent`-role message carrying one text part, with the proto-required
 * fields this agent never sets filled in. `messageId` is the gatekeeper's dedupe
 * key, so callers pass a **stable** id (never a fresh random per attempt) — a
 * callback the workflow/DO re-runs must reuse the same id or the gatekeeper
 * treats the replay as a new message and double-posts.
 */
export function agentTextMessage(input: {
  messageId: string;
  text: string;
  contextId: string;
  taskId: string;
}): PlainMessage {
  return {
    messageId: input.messageId,
    role: Role.ROLE_AGENT,
    parts: [textPart(input.text)],
    contextId: input.contextId,
    taskId: input.taskId,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}
