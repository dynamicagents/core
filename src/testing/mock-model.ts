import { MockLanguageModelV3 } from "ai/test";
// From `ai`, not `@ai-sdk/provider`. `ai` re-exports the class and is a declared
// peer; reaching for the provider package directly makes this module — which is
// on the published `/testing` subpath every consumer loads — depend on a package
// core does not declare and only resolves today by hoisting.
import { APICallError } from "ai";

/**
 * Test doubles for the LLM. Lets the tool-loop / executor specs run the real
 * `generateText` machinery (tool execution, multi-step, fallback) against a
 * scripted model with no network or `AI` binding.
 */

/** Zeroed usage block satisfying the LanguageModelV3 result shape. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

export interface MockStep {
  /**
   * Assistant text for this step. On its own → finishReason "stop", which for the
   * main-agent round is a *failed* attempt: prose is not an ending there, so use
   * {@link finalReply} to script an answer. Alongside `toolCall` → the
   * intermediate content emitted before a tool call.
   */
  text?: string;
  /** Emit a tool call (finishReason "tool-calls"); may accompany `text`. */
  toolCall?: { toolName: string; input?: unknown };
  /**
   * Emit several tool calls in **one** step, which a real model does whenever it
   * decides two things at once. That is the only way to script the cases the round
   * has to arbitrate: two different endings in one step (precedence decides), or
   * the same ending twice (the tool's own `parse` decides).
   */
  toolCalls?: { toolName: string; input?: unknown }[];
}

/**
 * A step where the main agent answers the user — the `final_reply` control call.
 *
 * Scripting a bare `{ text }` instead reproduces the bug this tool exists to catch
 * (a model narrating rather than acting) and fails the attempt, which is what the
 * error-path specs use it for.
 */
export function finalReply(
  text: string,
  opts: { text?: string } = {}
): MockStep {
  return {
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    toolCall: { toolName: "final_reply", input: { text } }
  };
}

function stepResult(step: MockStep) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  > = [];
  // Keep the empty-string text part so a `{ text: "" }` step still yields "".
  if (step.text !== undefined) content.push({ type: "text", text: step.text });
  const calls = [
    ...(step.toolCall ? [step.toolCall] : []),
    ...(step.toolCalls ?? [])
  ];
  for (const call of calls) {
    content.push({
      type: "tool-call",
      toolCallId: crypto.randomUUID(),
      toolName: call.toolName,
      input: JSON.stringify(call.input ?? {})
    });
  }
  const unified =
    calls.length > 0 ? ("tool-calls" as const) : ("stop" as const);
  return {
    content,
    finishReason: { unified, raw: undefined },
    usage: USAGE,
    warnings: []
  };
}

/**
 * A mock model that returns each step in sequence — one per `generateText` call.
 * Uses the function form (with our own counter) rather than the array form, whose
 * call-count indexing is off by one in this SDK version. Extra calls repeat the
 * last step.
 */
export function mockModel(...steps: MockStep[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => stepResult(steps[Math.min(i++, steps.length - 1)])
  });
}

/**
 * A model whose every call throws, and a count of how many times it was asked.
 *
 * The count is the point. Several of the attempt ladder's rules are about a call
 * that must *not* happen — a fallback slot left unspent, a repair not attempted
 * — and those are invisible to an assertion on the returned outcome alone, which
 * can be right for the wrong reason.
 */
export function throwingModel(error: unknown): {
  model: MockLanguageModelV3;
  calls: () => number;
} {
  let calls = 0;
  return {
    model: new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        throw error;
      }
    }),
    calls: () => calls
  };
}

/** {@link mockModel}, plus the same call count {@link throwingModel} reports. */
export function countingModel(...steps: MockStep[]): {
  model: MockLanguageModelV3;
  calls: () => number;
} {
  let calls = 0;
  let i = 0;
  return {
    model: new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return stepResult(steps[Math.min(i++, steps.length - 1)]);
      }
    }),
    calls: () => calls
  };
}

/** What one call was asked with: the tools it was offered and what it was told. */
export interface ModelCall {
  tools: string[];
  system: string;
}

/**
 * {@link mockModel}, plus what each call was actually asked with.
 *
 * Both halves are decisions the *round* makes and the model merely reacts to, so
 * both are invisible to any assertion on the outcome: a round that withheld its
 * work tools and one that left them on end in whatever the script says, and a
 * round handed the wrong note still answers. Yet each is the entire content of a
 * rule — that a round which has to answer is handed nothing but the answer, that
 * neither is an attempt down to its last step, and that a forced round is told
 * the true reason it was forced rather than a plausible one.
 *
 * One entry per call, so a spec can tell the primary's view from the fallback's.
 */
export function inspectingModel(...steps: MockStep[]): {
  model: MockLanguageModelV3;
  asked: () => ModelCall[];
} {
  const asked: ModelCall[] = [];
  let i = 0;
  return {
    model: new MockLanguageModelV3({
      doGenerate: async (options) => {
        asked.push({
          tools: (options.tools ?? []).map((t) => t.name),
          system: options.prompt
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n")
        });
        return stepResult(steps[Math.min(i++, steps.length - 1)]);
      }
    }),
    asked: () => asked
  };
}

/**
 * A model that fails the first `failures` calls with a retryable `APICallError`,
 * then behaves like {@link mockModel}.
 *
 * Exists for the one behaviour a scripted-outcome assertion cannot see: whether
 * a rate limit was *waited out on the same model* or fell straight through to
 * the fallback. Only the call count distinguishes them — both produce a
 * successful round.
 *
 * `retry-after: 0` is deliberate. The AI SDK honours the header and its own
 * backoff opens at two seconds, which would spend real seconds asserting
 * something that has nothing to do with duration. Zero exercises the identical
 * path — header parsed, preferred over the exponential delay, waited — for free.
 */
export function rateLimitedModel(
  failures: number,
  ...steps: MockStep[]
): { model: MockLanguageModelV3; calls: () => number } {
  let calls = 0;
  let i = 0;
  return {
    model: new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls <= failures) {
          throw new APICallError({
            message: "429 Wholesale Rate limited",
            url: "mock:chat:test",
            requestBodyValues: {},
            statusCode: 429,
            responseHeaders: { "retry-after": "0" }
          });
        }
        return stepResult(steps[Math.min(i++, steps.length - 1)]);
      }
    }),
    calls: () => calls
  };
}
