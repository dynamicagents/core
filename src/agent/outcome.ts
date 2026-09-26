import type { UIMessage } from "ai";
import { ASK_USER_TOOL_NAME, askUserInputSchema } from "./tools.js";

/**
 * What a finished turn amounts to, read back out of the session.
 *
 * Think has no "final reply" tool: a turn ends when the model stops calling
 * tools, and what the caller gets is what the assistant said. Which messages
 * count is the part worth writing down — a recovered turn is **two or more**
 * assistant messages (the persisted partial, then the continuation), so the
 * turn is every assistant message after the user message that started it.
 */

/** A question the turn ended on, still waiting for its answer. */
export interface PendingAsk {
  toolCallId: string;
  question: string;
  options?: string[];
}

export interface TurnOutcome {
  /** Everything the assistant said this turn. */
  text: string;
  /**
   * The text after the last tool part — what settles the task. The sentences
   * before a tool call were pushed as progress when the call started.
   */
  reply: string;
  ask?: PendingAsk;
}

type Part = UIMessage["parts"][number];

/**
 * Read one task's turn: every assistant message after the last user message
 * stamped with this task id. Think persists `metadata.turnMetadata` on the
 * submitted message so a recovered turn resolves the same way.
 */
export function readTurn(messages: UIMessage[], taskId: string): TurnOutcome {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && taskIdOf(message) === taskId) {
      start = i;
      break;
    }
  }
  const parts = messages
    .slice(start + 1)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts);
  return {
    text: textOf(parts),
    reply: textOf(parts.slice(lastToolIndex(parts) + 1)),
    ask: pendingAsk(parts)
  };
}

/**
 * A sub-agent run's result, as its parent receives it: Think's own summary
 * rule — every text part, a line apart — read across the whole turn. Think
 * stops at the first assistant message with text, which after a recovery is
 * the partial, and drops the continuation that holds the answer.
 */
export function readRunSummary(messages: UIMessage[]): string {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role !== "user") start--;
  return messages
    .slice(start)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .filter((text) => text.length > 0)
    .join("\n");
}

/** The task a message was submitted for, from its `turnMetadata`. */
export function taskIdOf(message: UIMessage): string | undefined {
  const metadata = message.metadata as
    { turnMetadata?: { taskId?: unknown } } | undefined;
  const taskId = metadata?.turnMetadata?.taskId;
  return typeof taskId === "string" ? taskId : undefined;
}

/** The task of the latest user message — the turn a recovery is about. */
export function latestTaskId(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return taskIdOf(messages[i]);
  }
  return undefined;
}

function textOf(parts: Part[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("")
    .trim();
}

function lastToolIndex(parts: Part[]): number {
  let index = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type.startsWith("tool-") || parts[i].type === "dynamic-tool")
      index = i;
  }
  return index;
}

/**
 * The `ask_user` call the turn ended on. `ask_user` has no `execute`, so the
 * turn ends with the call unanswered and Think completes the submission —
 * Think's documented pattern, not a failure. A settled part was answered.
 */
function pendingAsk(parts: Part[]): PendingAsk | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type !== `tool-${ASK_USER_TOOL_NAME}`) continue;
    const call = parts[i] as {
      toolCallId?: string;
      state?: string;
      input?: unknown;
    };
    if (call.state?.startsWith("output-")) return undefined;
    // With no `execute`, nothing else holds the call to its schema: a question
    // it would refuse is not parked on.
    const input = askUserInputSchema.safeParse(call.input);
    if (!input.success) return undefined;
    return {
      toolCallId: call.toolCallId ?? "",
      question: input.data.question,
      ...(input.data.options ? { options: input.data.options } : {})
    };
  }
  return undefined;
}
