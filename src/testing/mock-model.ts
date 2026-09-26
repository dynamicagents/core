import { MockLanguageModelV3 } from "ai/test";
// From `ai`, not `@ai-sdk/provider`: `ai` is a declared peer, and reaching for
// the provider package directly would make this published subpath depend on a
// package core does not declare.
import { simulateReadableStream } from "ai";

/**
 * Test doubles for the LLM, so a Think turn runs its real loop — tool
 * execution, multi-step, recovery — against a scripted model with no network
 * and no `AI` binding.
 *
 * **`doStream`, not only `doGenerate`.** Think calls `streamText`; a model with
 * only `doGenerate` is never asked anything and the turn fails on a missing
 * implementation. `doGenerate` is kept for `generateText` callers such as
 * compaction.
 */

/** The provider-level prompt, read off the mock rather than imported. */
export type ModelPrompt = Parameters<
  MockLanguageModelV3["doStream"]
>[0]["prompt"];
type StreamResult = Awaited<ReturnType<MockLanguageModelV3["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** Zeroed usage, satisfying the result shape without pretending to measure. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

/** One model step. */
export interface MockStep {
  /** Assistant text. Alongside tool calls, it is what the model says first. */
  text?: string;
  /** Tool calls in this step (finish reason `tool-calls`). */
  calls?: { toolName: string; input?: unknown }[];
  /** Fail the step with a stream error instead — the failed-turn path. */
  error?: string;
}

/** A step that answers. */
export function reply(text: string): MockStep {
  return { text };
}

/** A step that calls one tool, optionally saying something first. */
export function call(
  toolName: string,
  input: unknown = {},
  text?: string
): MockStep {
  return {
    ...(text !== undefined ? { text } : {}),
    calls: [{ toolName, input }]
  };
}

/** A step that asks the person something, through core's `ask_user`. */
export function askUser(question: string, options?: string[]): MockStep {
  return call("ask_user", { question, ...(options ? { options } : {}) });
}

/** What a scripted rule is shown of the call it answers. */
export interface ModelTurnView {
  /** The last user message's text — what the turn is about. */
  lastUserText: string;
  /** Whether a tool has answered since that message. */
  answered: boolean;
  prompt: ModelPrompt;
}

/**
 * A model that answers each call from a rule over what it was asked, rather
 * than from a queue.
 *
 * A queue is the wrong shape once a task spans turns: a follow-up turn, a
 * recovered one and a sub-agent's run all consume steps, and which call comes
 * next depends on scheduling the spec does not control. A rule keyed on the
 * last user message answers the same thing however the calls interleave. Emit a
 * tool call when `!answered` and plain text after, and the turn converges.
 */
export function scriptedModel(
  rule: (view: ModelTurnView) => MockStep
): MockLanguageModelV3 {
  let n = 0;
  const step = (prompt: ModelPrompt) =>
    rule({
      lastUserText: lastUserText(prompt),
      answered: hasToolResult(prompt),
      prompt
    });
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => streamOf(step(prompt), n++),
    doGenerate: async ({ prompt }) => generateOf(step(prompt), n++)
  });
}

/**
 * A model that returns each step in sequence, one per call; extra calls repeat
 * the last step.
 */
export function mockModel(...steps: MockStep[]): MockLanguageModelV3 {
  let i = 0;
  const next = () => steps[Math.min(i++, steps.length - 1)] ?? {};
  return new MockLanguageModelV3({
    doStream: async () => streamOf(next(), i),
    doGenerate: async () => generateOf(next(), i)
  });
}

/** A model whose every call throws, and a count of how often it was asked. */
export function throwingModel(error: unknown): {
  model: MockLanguageModelV3;
  calls: () => number;
} {
  let calls = 0;
  const fail = async (): Promise<never> => {
    calls += 1;
    throw error;
  };
  return {
    model: new MockLanguageModelV3({ doStream: fail, doGenerate: fail }),
    calls: () => calls
  };
}

/** What one call was asked with: the tools offered and the system prompt. */
export interface ModelCall {
  tools: string[];
  system: string;
  messages: ModelPrompt;
}

/** {@link mockModel}, plus what each call was actually asked with. */
export function inspectingModel(...steps: MockStep[]): {
  model: MockLanguageModelV3;
  asked: () => ModelCall[];
} {
  const asked: ModelCall[] = [];
  let i = 0;
  const record = (options: {
    prompt: ModelPrompt;
    tools?: { name: string }[];
  }) => {
    asked.push({
      tools: (options.tools ?? []).map((t) => t.name),
      system: options.prompt
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n"),
      messages: options.prompt.filter((m) => m.role !== "system")
    });
    return steps[Math.min(i++, steps.length - 1)] ?? {};
  };
  return {
    model: new MockLanguageModelV3({
      doStream: async (options) => streamOf(record(options), i),
      doGenerate: async (options) => generateOf(record(options), i)
    }),
    asked: () => asked
  };
}

// --- encoding ----------------------------------------------------------------

function streamOf(step: MockStep, n: number): StreamResult {
  return {
    stream: simulateReadableStream<StreamPart>({
      chunks: chunksOf(step, n),
      initialDelayInMs: 0,
      chunkDelayInMs: 0
    })
  };
}

function chunksOf(step: MockStep, n: number): StreamPart[] {
  const chunks: StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (step.error !== undefined) {
    chunks.push({ type: "error", error: new Error(step.error) });
    chunks.push({
      type: "finish",
      usage: USAGE,
      finishReason: { unified: "error", raw: undefined }
    });
    return chunks;
  }
  if (step.text) {
    const id = `t${n}`;
    chunks.push({ type: "text-start", id });
    chunks.push({ type: "text-delta", id, delta: step.text });
    chunks.push({ type: "text-end", id });
  }
  const calls = step.calls ?? [];
  calls.forEach((c, index) => {
    const id = `c${n}-${index}-${crypto.randomUUID().slice(0, 8)}`;
    const input = JSON.stringify(c.input ?? {});
    chunks.push({ type: "tool-input-start", id, toolName: c.toolName });
    chunks.push({ type: "tool-input-delta", id, delta: input });
    chunks.push({ type: "tool-input-end", id });
    chunks.push({
      type: "tool-call",
      toolCallId: id,
      toolName: c.toolName,
      input
    });
  });
  chunks.push({
    type: "finish",
    usage: USAGE,
    finishReason: {
      unified: calls.length > 0 ? "tool-calls" : "stop",
      raw: undefined
    }
  });
  return chunks;
}

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3["doGenerate"]>>;

function generateOf(step: MockStep, n: number): GenerateResult {
  if (step.error !== undefined) throw new Error(step.error);
  const content: GenerateResult["content"] = [];
  if (step.text !== undefined) content.push({ type: "text", text: step.text });
  (step.calls ?? []).forEach((c, index) =>
    content.push({
      type: "tool-call",
      toolCallId: `g${n}-${index}`,
      toolName: c.toolName,
      input: JSON.stringify(c.input ?? {})
    })
  );
  return {
    content,
    finishReason: {
      unified: step.calls?.length ? "tool-calls" : "stop",
      raw: undefined
    },
    usage: USAGE,
    warnings: []
  };
}

function lastUserText(prompt: ModelPrompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const message = prompt[i];
    if (message.role !== "user") continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("")
      .trim();
  }
  return "";
}

function hasToolResult(prompt: ModelPrompt): boolean {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const role = prompt[i].role;
    if (role === "user") return false;
    if (role === "tool") return true;
  }
  return false;
}
