import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import {
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  MAX_MESSAGE_TEXT_BYTES,
  type HitlRequestData,
  type HitlResponseData
} from "@dynamicagents/g2a-protocol";
import { z } from "zod";
import { dataPart, textPart } from "./parts.js";

/**
 * Asking a person something through the gatekeeper, on the wire.
 *
 * A2A carries the exchange: the Task parks in `input-required` with the question
 * on its status, and the answer arrives as a new message on the same Task. The
 * part names both sides read by are `@dynamicagents/g2a-protocol`'s. What is here
 * is core's half of it — building the question, and reading an answer back out of
 * a message that has to be treated as untrusted until it parses.
 */

/** Distributive, so the "an option, a text, or both" union survives the `Omit`. */
type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, "type" | "requestId">
  : never;

/** An answer as the gatekeeper sent it, less the envelope that routed it here. */
export type HumanAnswer = WithoutEnvelope<HitlResponseData>;

/** What a message onto a parked Task can say. */
export type HumanReply =
  | { kind: "answer"; requestId: string; answer: HumanAnswer }
  /** Nobody answered before the gatekeeper gave up on the question. */
  | { kind: "timeout"; requestId: string };

/**
 * The id a round's question goes out under, and the id its answer names.
 *
 * Derived, like every other id a round writes. The round's step can re-run, and
 * a second id for the same question would put a second question to the person.
 */
export function humanRequestId(taskId: string, round: number): string {
  return `task_${taskId}_round_${round}_ask`;
}

/** Characters a Workflow event type may not contain. */
const NOT_EVENT_TYPE = /[^A-Za-z0-9_-]/g;

/** The longest event type Workflows accepts. */
const MAX_EVENT_TYPE_LENGTH = 100;

/**
 * The Workflow event that wakes a run parked on `requestId`.
 *
 * One type per question rather than one for every answer. Workflows buffers an
 * event sent before its wait begins, and a retried answer is sent twice, so a
 * shared type would let a stale wake satisfy the wait on a later question.
 *
 * An event goes to one Task's instance, so the type only has to tell that Task's
 * questions apart. An id past the length Workflows accepts is cut to a prefix and a
 * digest of the whole, which keeps it distinct and the same on every derivation.
 */
export function humanEventType(requestId: string): string {
  const type = `hitl-${requestId.replace(NOT_EVENT_TYPE, "-")}`;
  if (type.length <= MAX_EVENT_TYPE_LENGTH) return type;
  const digest = fnv1a(requestId);
  return `${type.slice(0, MAX_EVENT_TYPE_LENGTH - digest.length - 1)}-${digest}`;
}

/** 32-bit FNV-1a as hex: short, stable, and nothing to import or await. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The `input-required` Task that asks: the question as text, for a client that
 * knows none of this, and as data, for the gatekeeper that renders it.
 *
 * An SDK `Task` rather than a `PlainTask`, because a data part cannot cross
 * Durable Object RPC typed — see {@link file://./task.ts}. It is built, stored and
 * posted from inside the object that holds the question.
 *
 * The status message id is the request id, so a retried post is the same message.
 */
export function buildInputRequiredTask(
  taskId: string,
  contextId: string,
  request: HitlRequestData
): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      message: {
        messageId: request.requestId,
        role: Role.ROLE_AGENT,
        parts: [textPart(request.prompt), dataPart(request)],
        contextId,
        taskId,
        metadata: undefined,
        extensions: [],
        referenceTaskIds: []
      },
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

const encoder = new TextEncoder();

const answerSchema = z
  .object({
    type: z.literal(HITL_RESPONSE_TYPE),
    requestId: z.string().min(1),
    optionId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    answeredBy: z.string().min(1)
  })
  .refine((d) => d.optionId !== undefined || d.text !== undefined, {
    message: "an answer carries an optionId, a text, or both"
  })
  // The same bound a turn's own text is held to, for the same reason: this text
  // is appended to the Session and read by every round after it. Measured on the
  // field rather than on the message, because this is what is kept — the text
  // part beside it is the gatekeeper's rendering of the same answer, and the
  // Worker holds the message as a whole to the same bound.
  .refine(
    (d) =>
      d.text === undefined ||
      encoder.encode(d.text).byteLength <= MAX_MESSAGE_TEXT_BYTES,
    { message: "answer text exceeds the size limit" }
  );

const timeoutSchema = z.object({
  type: z.literal(HITL_TIMEOUT_TYPE),
  requestId: z.string().min(1)
});

/**
 * The answer or the timeout a message carries, or `null` when it carries neither
 * in a shape that parses — which is how an ordinary follow-up message on a Task
 * reads, and why the Worker refuses one before it reaches a parked Task.
 */
export function readHumanReply(message: Message): HumanReply | null {
  for (const part of message.parts) {
    if (part.content?.$case !== "data") continue;
    const value: unknown = part.content.value;

    const answer = answerSchema.safeParse(value);
    if (answer.success) {
      const { type: _type, requestId, ...rest } = answer.data;
      return { kind: "answer", requestId, answer: rest as HumanAnswer };
    }

    const timeout = timeoutSchema.safeParse(value);
    if (timeout.success)
      return { kind: "timeout", requestId: timeout.data.requestId };
  }
  return null;
}

/**
 * What wakes a run parked on a question: which run, and which event.
 *
 * The run is named by the message its Task was accepted on — see
 * {@link file://./executor.ts workflowIdForMessage} — which the Durable Object
 * recorded at accept, so an answer does not have to carry it.
 */
export interface TurnWake {
  /** The gatekeeper message the Task was accepted on. */
  messageId: string;
  /** See {@link humanEventType}. */
  eventType: string;
}
