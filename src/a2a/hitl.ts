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
 *
 * **Every gatekeeper takes part.** Putting a question in front of a person, and
 * sending back their answer or a timeout, is the gatekeeper's side of the
 * contract, not an option an agent checks for. So any turn may ask.
 */

/** An answer as the gatekeeper sent it, less the envelope that routed it here. */
export type HumanAnswer = Omit<HitlResponseData, "type" | "requestId">;

/** What a message onto a parked Task can say. */
export type HumanReply =
  | { kind: "answer"; requestId: string; answer: HumanAnswer }
  /** Nobody answered before the gatekeeper gave up on the question. */
  | { kind: "timeout"; requestId: string };

/**
 * The questions in words: each in turn, with every option, its description and
 * example, and any link to look at — everything a gatekeeper that renders none
 * of the data still has to show.
 */
export function formRequestText(request: HitlRequestData): string {
  const numbered = request.questions.length > 1;
  const blocks = request.questions.map((q, i) => {
    const lines = [numbered ? `${i + 1}. ${q.prompt}` : q.prompt];
    if (q.kind === "choice") {
      q.options.forEach((o, j) => {
        // a) to z), then numbers: `step.ask` bounds no question's options.
        const mark = j < 26 ? String.fromCharCode(97 + j) : String(j + 1);
        lines.push(
          o.description
            ? `   ${mark}) ${o.label} — ${o.description}`
            : `   ${mark}) ${o.label}`
        );
        if (o.example) lines.push(indent(o.example, "      "));
      });
      lines.push(
        q.multiple ? "   (pick any, or write another)" : "   (or write another)"
      );
    }
    if (q.kind === "approval") {
      lines.push(`   ${q.artifact.url}`, "   (approve, reject, or comment)");
    }
    return lines.join("\n");
  });
  return [request.prompt, ...blocks].filter(Boolean).join("\n\n");
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line) => by + line)
    .join("\n");
}

/**
 * The `input-required` Task that asks: the questions as text, for a client that
 * knows none of this, and as data, for the gatekeeper that renders them.
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
        parts: [textPart(formRequestText(request)), dataPart(request)],
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

/** One question's answer: picked options, typed words, or both — never neither. */
const optionId = z.string().min(1);

const questionAnswerSchema = z.union([
  z.object({
    // A tuple of at least one, as the protocol types it.
    optionIds: z.tuple([optionId], optionId),
    text: z.string().min(1).optional()
  }),
  // `optionIds` refused outright rather than stripped: stripped, an empty or
  // malformed pick beside words would read as words alone, and a bad
  // approval as a comment.
  z.object({ optionIds: z.undefined().optional(), text: z.string().min(1) })
]);

const answerSchema = z
  .object({
    type: z.literal(HITL_RESPONSE_TYPE),
    requestId: z.string().min(1),
    answeredBy: z.string().min(1),
    answers: z.record(z.string().min(1), questionAnswerSchema)
  })
  // The same bound a turn's own text is held to, for the same reason: this text
  // is appended to the session and read by every turn after it. Measured on the
  // fields rather than on the message, because these are what is kept — the
  // text part beside them is the gatekeeper's rendering of the same answers,
  // and the Worker holds the message as a whole to the same bound.
  .refine(
    (d) =>
      Object.values(d.answers).reduce(
        (bytes, a) => bytes + (a.text ? encoder.encode(a.text).byteLength : 0),
        0
      ) <= MAX_MESSAGE_TEXT_BYTES,
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
      return { kind: "answer", requestId, answer: rest };
    }

    const timeout = timeoutSchema.safeParse(value);
    if (timeout.success)
      return { kind: "timeout", requestId: timeout.data.requestId };
  }
  return null;
}
