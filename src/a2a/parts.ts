import { Role, type Message, type Part } from "@a2a-js/sdk";
import { MAX_MESSAGE_TEXT_BYTES } from "@dynamicagents/g2a-protocol";
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

const encoder = new TextEncoder();

/** Invalid inbound content that must not cross the A2A-to-workflow boundary. */
export class InboundPartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundPartError";
  }
}

/**
 * Why this message's text cannot be taken, or `undefined` when it can.
 *
 * The bound is `MAX_MESSAGE_TEXT_BYTES`, and it is the protocol package's rather
 * than this one's because the sending side has to know it too: a gatekeeper that
 * will send anything an agent will refuse discovers the bound by hitting it, and
 * the expensive case is a person's answer to a question that is now spent. That
 * module's doc carries the half of the agreement that is not the number — UTF-8
 * bytes, summed over every text part with no separator and trimmed, which is
 * what {@link partsText} computes.
 *
 * Separate from {@link inboundText} because the refusal has to reach the caller
 * as a JSON-RPC error and not as a throw, which the request handler would turn
 * into a failed Task. Applied by the Worker before the executor runs, beside the
 * other preflight refusals in {@link file://../worker/index.ts}.
 */
export function inboundTextError(message: Message): string | undefined {
  if (encoder.encode(textOf(message)).byteLength > MAX_MESSAGE_TEXT_BYTES) {
    return `message text exceeds ${MAX_MESSAGE_TEXT_BYTES} bytes`;
  }
  return undefined;
}

/**
 * Extract and validate the user-turn text, for a caller holding a message with
 * nowhere to put a refusal. Rejects a message with no usable text, and applies
 * {@link inboundTextError}.
 *
 * File and data parts are deliberately out of scope: only text crosses into the
 * agent runtime.
 */
export function inboundText(message: Message): string {
  const tooLong = inboundTextError(message);
  if (tooLong) {
    throw new InboundPartError(tooLong);
  }
  const text = textOf(message);
  if (!text) {
    throw new InboundPartError("message has no usable text");
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
