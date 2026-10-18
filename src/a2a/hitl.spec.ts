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
  formRequestText,
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
  questions: [
    {
      kind: "choice",
      id: "q1",
      prompt: "Which repository did you mean?",
      options: [
        { id: "q1.o1", label: "org/api" },
        { id: "q1.o2", label: "org/web" }
      ]
    }
  ]
};

const form: HitlRequestData = {
  type: HITL_REQUEST_TYPE,
  requestId: "task_t1_round_3_ask",
  prompt: "Before I open the PR:",
  questions: [
    {
      kind: "choice",
      id: "q1",
      prompt: "How should it merge?",
      options: [
        {
          id: "q1.o1",
          label: "Squash",
          description: "One commit on main.",
          example: "feat: forms (#1)"
        },
        { id: "q1.o2", label: "Rebase" }
      ]
    },
    {
      kind: "choice",
      id: "q2",
      prompt: "Which checks must pass?",
      multiple: true,
      options: [
        { id: "q2.o1", label: "lint" },
        { id: "q2.o2", label: "test" }
      ]
    },
    { kind: "text", id: "q3", prompt: "What should the branch be called?" },
    {
      kind: "approval",
      id: "q4",
      prompt: "Approve the plan?",
      artifact: { id: "plan-1", url: "https://agents.example/a/tok" }
    }
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
      value: formRequestText(question)
    });
    expect(parts[1]?.content).toEqual({ $case: "data", value: question });
    expect(parts[1]?.mediaType).toBe("application/json");
  });

  it("posts a retry under the same message id", () => {
    // The delivery queue retries on a non-2xx, and a fresh id per attempt
    // would reach the gatekeeper as a second question.
    const first = buildInputRequiredTask("t1", "ctx-1", question);
    const again = buildInputRequiredTask("t1", "ctx-1", question);
    expect(first.status?.message?.messageId).toBe(
      again.status?.message?.messageId
    );
  });
});

describe("the questions in words", () => {
  it("asks one question without numbering it, with its options and a way out", () => {
    expect(formRequestText(question)).toBe(
      [
        "Which repository did you mean?",
        "   a) org/api",
        "   b) org/web",
        "   (or answer in your own words)"
      ].join("\n")
    );
  });

  it("numbers a form's questions and shows everything a renderer would", () => {
    const text = formRequestText(form);
    expect(
      text.startsWith("Before I open the PR:\n\n1. How should it merge?")
    ).toBe(true);
    expect(text).toContain("   a) Squash — One commit on main.");
    expect(text).toContain("      feat: forms (#1)");
    expect(text).toContain("2. Which checks must pass?");
    expect(text).toContain("(pick any, or answer in your own words)");
    expect(text).toContain("3. What should the branch be called?");
    expect(text).toContain(
      "4. Approve the plan?\n   https://agents.example/a/tok"
    );
  });
});

describe("the options in words, past the alphabet", () => {
  it("letters the first 26, and numbers the rest", () => {
    const text = formRequestText({
      type: HITL_REQUEST_TYPE,
      requestId: "r-many",
      questions: [
        {
          kind: "choice",
          id: "q1",
          prompt: "Which region?",
          options: Array.from({ length: 28 }, (_, i) => ({
            id: `q1.o${i + 1}`,
            label: `Region ${i + 1}`
          }))
        }
      ]
    });
    expect(text).toContain("   z) Region 26");
    expect(text).toContain("   27) Region 27");
    expect(text).not.toMatch(/\{\)|\|\)/);
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
          answers: { q1: { optionIds: ["q1.o2"] } },
          answeredBy: "U123"
        })
      )
    );

    expect(reply).toEqual({
      kind: "answer",
      requestId: question.requestId,
      answer: { answers: { q1: { optionIds: ["q1.o2"] } }, answeredBy: "U123" }
    });
  });

  it("reads an answer typed out", () => {
    const reply = readHumanReply(
      message(
        data({
          type: HITL_RESPONSE_TYPE,
          requestId: question.requestId,
          answers: { q1: { text: "the one with the failing build" } },
          answeredBy: "U123"
        })
      )
    );

    expect(reply).toMatchObject({
      kind: "answer",
      answer: { answers: { q1: { text: "the one with the failing build" } } }
    });
  });

  it("reads a form's answers, each keyed by its question", () => {
    const answers = {
      q1: { optionIds: ["q1.o1"], text: "and delete the branch" },
      q2: { optionIds: ["q2.o1", "q2.o2"] },
      q3: { text: "feat/forms" },
      q4: { optionIds: ["approve"] }
    };
    const reply = readHumanReply(
      message(
        data({
          type: HITL_RESPONSE_TYPE,
          requestId: form.requestId,
          answers,
          answeredBy: "U123"
        })
      )
    );
    expect(reply).toEqual({
      kind: "answer",
      requestId: form.requestId,
      answer: { answers, answeredBy: "U123" }
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
    for (const answers of [undefined, { q1: {} }, { q1: { optionIds: [] } }]) {
      expect(
        readHumanReply(
          message(
            data({
              type: HITL_RESPONSE_TYPE,
              requestId: question.requestId,
              answers,
              answeredBy: "U123"
            })
          )
        )
      ).toBeNull();
    }
  });

  it("refuses an empty or malformed pick, even beside words", () => {
    // Read as words alone, a bad pick would resume the task — and an approval's
    // bad verdict would land as a comment.
    for (const optionIds of [[], [""], "approve", null]) {
      expect(
        readHumanReply(
          message(
            data({
              type: HITL_RESPONSE_TYPE,
              requestId: question.requestId,
              answers: { q1: { optionIds, text: "ship it" } },
              answeredBy: "U123"
            })
          )
        )
      ).toBeNull();
    }
  });

  it("refuses an answer longer than a turn may be", () => {
    // It goes into the session and every later turn reads it, so it is held
    // to the bound a turn's own text is.
    expect(
      readHumanReply(
        message(
          data({
            type: HITL_RESPONSE_TYPE,
            requestId: question.requestId,
            answers: { q1: { text: "x".repeat(MAX_MESSAGE_TEXT_BYTES + 1) } },
            answeredBy: "U123"
          })
        )
      )
    ).toBeNull();
  });
});

describe("the bound on a form's answers", () => {
  it("measures every answer's text together", () => {
    // Two answers each under the bound and over it together are held to it as
    // one: they are kept as one message.
    const half = "x".repeat(MAX_MESSAGE_TEXT_BYTES / 2 + 1);
    expect(
      readHumanReply(
        message(
          data({
            type: HITL_RESPONSE_TYPE,
            requestId: form.requestId,
            answers: { q1: { text: half }, q3: { text: half } },
            answeredBy: "U123"
          })
        )
      )
    ).toBeNull();
  });
});
