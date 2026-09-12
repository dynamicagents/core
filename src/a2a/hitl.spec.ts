import { describe, it, expect } from "vitest";
import { Role, TaskState, type Message } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  MAX_MESSAGE_TEXT_BYTES,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import {
  buildInputRequiredTask,
  humanEventType,
  humanRequestId,
  readHumanReply
} from "./hitl.js";

/**
 * Core's half of asking a person something: the question it posts, and what it
 * accepts back as an answer.
 *
 * The shapes are the gatekeeper's to render and to answer in, so the question
 * built here is checked against what that side reads — a data part carrying the
 * request, beside a text part saying the same thing — and the reader is fed what
 * that side sends.
 */

const question: HitlRequestData = {
  type: HITL_REQUEST_TYPE,
  requestId: "task_t1_round_2_ask",
  requestKind: "choice",
  prompt: "Which repository did you mean?",
  options: [
    { id: "option_1", label: "org/api" },
    { id: "option_2", label: "org/web" }
  ]
};

type Part = Message["parts"][number];

const text = (value: string): Part => ({
  content: { $case: "text", value },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain"
});

const data = (value: unknown): Part => ({
  content: { $case: "data", value },
  metadata: undefined,
  filename: "",
  mediaType: "application/json"
});

/** A message onto a parked Task, as the handler hands one to the executor. */
function message(...parts: Part[]): Message {
  return {
    messageId: `gk-token:r:${question.requestId}`,
    role: Role.ROLE_USER,
    parts,
    contextId: "ctx-1",
    taskId: "t1",
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

describe("the question an agent posts", () => {
  it("parks the Task with the question as text and as data", () => {
    const task = buildInputRequiredTask("t1", "ctx-1", question);

    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const parts = task.status?.message?.parts ?? [];
    // The text is what a client that knows none of this still reads; the data
    // is what the gatekeeper renders as something to pick from.
    expect(parts[0]?.content).toEqual({
      $case: "text",
      value: question.prompt
    });
    expect(parts[1]?.content).toEqual({ $case: "data", value: question });
    expect(parts[1]?.mediaType).toBe("application/json");
  });

  it("posts a retry under the same message id", () => {
    // The step that posts it retries on a non-2xx, and a fresh id per attempt
    // would reach the gatekeeper as a second question.
    const first = buildInputRequiredTask("t1", "ctx-1", question);
    const again = buildInputRequiredTask("t1", "ctx-1", question);
    expect(first.status?.message?.messageId).toBe(
      again.status?.message?.messageId
    );
  });

  it("derives a question's id from its Task and round", () => {
    expect(humanRequestId("t1", 2)).toBe(humanRequestId("t1", 2));
    expect(humanRequestId("t1", 2)).not.toBe(humanRequestId("t1", 3));
    expect(humanRequestId("t1", 2)).not.toBe(humanRequestId("t2", 2));
  });
});

describe("what wakes the run", () => {
  it("wakes each question's wait with its own event", () => {
    // A stale wake for one question must not satisfy the wait on the next.
    expect(humanEventType(humanRequestId("t1", 0))).not.toBe(
      humanEventType(humanRequestId("t1", 1))
    );
  });

  it("stays inside what Workflows accepts as an event type", () => {
    for (const id of [
      humanRequestId(crypto.randomUUID(), 12),
      humanRequestId("x.y:z/".repeat(40), 3)
    ]) {
      const type = humanEventType(id);
      expect(type).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(type.length).toBeLessThanOrEqual(100);
      expect(humanEventType(id)).toBe(type);
    }
  });

  it("keeps two long ids apart after shortening them", () => {
    const long = "a".repeat(120);
    expect(humanEventType(`${long}-one`)).not.toBe(
      humanEventType(`${long}-two`)
    );
  });
});

describe("reading a reply", () => {
  it("reads an answer picked from the options", () => {
    const reply = readHumanReply(
      message(
        text("org/web"),
        data({
          type: HITL_RESPONSE_TYPE,
          requestId: question.requestId,
          optionId: "option_2",
          answeredBy: "U123"
        })
      )
    );

    expect(reply).toEqual({
      kind: "answer",
      requestId: question.requestId,
      answer: { optionId: "option_2", answeredBy: "U123" }
    });
  });

  it("reads an answer typed out", () => {
    const reply = readHumanReply(
      message(
        data({
          type: HITL_RESPONSE_TYPE,
          requestId: question.requestId,
          text: "the one with the failing build",
          answeredBy: "U123"
        })
      )
    );

    expect(reply).toMatchObject({
      kind: "answer",
      answer: { text: "the one with the failing build" }
    });
  });

  it("reads a timeout", () => {
    const reply = readHumanReply(
      message(
        text("(No response was received within the allotted time.)"),
        data({ type: HITL_TIMEOUT_TYPE, requestId: question.requestId })
      )
    );

    expect(reply).toEqual({ kind: "timeout", requestId: question.requestId });
  });

  it("reads an ordinary follow-up as no reply at all", () => {
    // Which is what lets the Worker refuse one before it reaches a waiting Task.
    expect(readHumanReply(message(text("and one more thing")))).toBeNull();
  });

  it("refuses an answer that carries neither an option nor text", () => {
    expect(
      readHumanReply(
        message(
          data({
            type: HITL_RESPONSE_TYPE,
            requestId: question.requestId,
            answeredBy: "U123"
          })
        )
      )
    ).toBeNull();
  });

  it("refuses an answer longer than a turn may be", () => {
    // It goes into the Session and every later round reads it, so it is held
    // to the bound a turn's own text is.
    expect(
      readHumanReply(
        message(
          data({
            type: HITL_RESPONSE_TYPE,
            requestId: question.requestId,
            text: "x".repeat(MAX_MESSAGE_TEXT_BYTES + 1),
            answeredBy: "U123"
          })
        )
      )
    ).toBeNull();
  });
});
