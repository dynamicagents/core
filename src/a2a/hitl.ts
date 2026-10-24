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
 * A2A carries the exchange: a question rides a status update of the Task, and
 * the answer arrives as a new message on the same Task. Any number may be open,
 * each matched by its request id, and the Task goes `input-required` only once
 * the agent is idle with nothing but them to wait on. The part names both sides
 * read by are `@dynamicagents/g2a-protocol`'s. What is here is core's half of
 * it: building the question, and reading an answer back out of a message that
 * has to be treated as untrusted until it parses.
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
 * The `working` Task that asks: the questions as text, for a client that knows
 * none of this, and as data, for the gatekeeper that renders them. `working`,
 * because asking stops nothing else the task is doing; {@link buildWaitingTask}
 * says when all it does is wait.
 *
 * An SDK `Task` rather than a `PlainTask`, because a data part cannot cross
 * Durable Object RPC typed — see {@link file://./task.ts}. It is built, stored and
 * posted from inside the object that holds the question.
 *
 * The status message id is the request id, so a retried post is the same message.
 */
export function buildAskingTask(
  taskId: string,
  contextId: string,
  request: HitlRequestData
): Task {
  return statusTask(taskId, contextId, TaskState.TASK_STATE_WORKING, {
    messageId: request.requestId,
    parts: [textPart(formRequestText(request)), dataPart(request)]
  });
}

/**
 * The `input-required` Task of an agent idle with only open questions left to
 * wait on. It asks nothing new: each question went out as it was asked.
 * `messageId` is unique to this change of state, so the gatekeeper takes it
 * once, and once only.
 */
export function buildWaitingTask(
  taskId: string,
  contextId: string,
  messageId: string
): Task {
  return statusTask(taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, {
    messageId,
    parts: []
  });
}

function statusTask(
  taskId: string,
  contextId: string,
  state: TaskState,
  message: Pick<Message, "messageId" | "parts">
): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state,
      message: {
        ...message,
        role: Role.ROLE_AGENT,
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
 * in a shape that parses: how an ordinary message on a Task reads, which the
 * Worker joins to the Task rather than takes as an answer.
 */
/** Whether a message carries a part that claims to be an answer, parsed or not. */
export function hasHumanReplyPart(message: Message): boolean {
  return message.parts.some((part) => {
    if (part.content?.$case !== "data") return false;
    const type = (part.content.value as { type?: unknown } | null)?.type;
    return type === HITL_RESPONSE_TYPE || type === HITL_TIMEOUT_TYPE;
  });
}

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
