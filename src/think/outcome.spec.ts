import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { latestTaskId, readTurn } from "./outcome.js";

const user = (id: string, taskId: string, text = "go"): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  metadata: { turnMetadata: { taskId, contextId: "c" } }
});

const assistant = (id: string, parts: UIMessage["parts"]): UIMessage => ({
  id,
  role: "assistant",
  parts
});

const text = (t: string) => ({ type: "text" as const, text: t });

const toolPart = (
  name: string,
  state: string,
  input: unknown = {}
): UIMessage["parts"][number] =>
  ({
    type: `tool-${name}`,
    toolCallId: `call-${name}`,
    state,
    input,
    ...(state === "output-available" ? { output: "ok" } : {})
  }) as UIMessage["parts"][number];

describe("reading a turn", () => {
  it("reads every assistant message after the task's message — a recovered turn is several", () => {
    const outcome = readTurn(
      [
        user("u1", "t1"),
        assistant("a1", [text("Looking. ")]),
        assistant("a2", [text("Found it.")])
      ],
      "t1"
    );
    expect(outcome.reply).toBe("Looking. Found it.");
  });

  it("answers with what was said after the last tool, not the narration before it", () => {
    const outcome = readTurn(
      [
        user("u1", "t1"),
        assistant("a1", [
          text("Let me check."),
          toolPart("lookup", "output-available"),
          text("It is 4.")
        ])
      ],
      "t1"
    );
    expect(outcome.reply).toBe("It is 4.");
    expect(outcome.text).toBe("Let me check.It is 4.");
  });

  it("starts at the task's own latest message, not an earlier task's", () => {
    const outcome = readTurn(
      [
        user("u1", "t1"),
        assistant("a1", [text("first answer")]),
        user("u2", "t2"),
        assistant("a2", [text("second answer")])
      ],
      "t2"
    );
    expect(outcome.reply).toBe("second answer");
  });

  it("finds the question a turn ended on", () => {
    const outcome = readTurn(
      [
        user("u1", "t1"),
        assistant("a1", [
          toolPart("ask_user", "input-available", {
            question: "Which?",
            options: ["A", "B"]
          })
        ])
      ],
      "t1"
    );
    expect(outcome.ask).toEqual({
      toolCallId: "call-ask_user",
      question: "Which?",
      options: ["A", "B"]
    });
  });

  it("does not take an answered question for a pending one", () => {
    const outcome = readTurn(
      [
        user("u1", "t1"),
        assistant("a1", [
          toolPart("ask_user", "output-available", { question: "Which?" })
        ])
      ],
      "t1"
    );
    expect(outcome.ask).toBeUndefined();
  });

  it("names the task a recovery is about from the latest user message", () => {
    expect(latestTaskId([user("u1", "t1"), assistant("a1", [])])).toBe("t1");
    expect(latestTaskId([])).toBeUndefined();
  });
});
