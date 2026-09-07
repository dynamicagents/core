/**
 * Bounding a rolling conversation, in the two ways it is worth bounding.
 *
 * Extracted from the subagent runner rather than written for a second caller: a
 * round loop that carries its own work-tool exchanges across the Workflow
 * boundary needs exactly these rules, and re-deriving them would mean two
 * implementations of "which tool results are still worth their tokens" drifting
 * apart. Nothing here touches a model, a session or a Durable Object — pure
 * functions over `ModelMessage[]`, which is why they can live in `/agent` and be
 * shared by `/subagent` and `/round` without either subpath reaching into the
 * other.
 */
import type { ModelMessage, ToolResultPart } from "ai";

/**
 * Trim the conversation to the most recent `window` turns (plus the seed message),
 * cutting at an assistant boundary so no tool-result message is left orphaned.
 * Older turns fall out of context — the recipe's soul directs the model to persist
 * anything durable to its workspace, which the window never touches.
 */
export function windowMessages(
  messages: ModelMessage[],
  window: number
): ModelMessage[] {
  if (messages.length <= 1) return messages;
  const assistantIdx: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") assistantIdx.push(i);
  }
  if (assistantIdx.length <= window) return messages;
  const start = assistantIdx[assistantIdx.length - window];
  return [messages[0], ...messages.slice(start)];
}

/** What replaces a tool result that has aged out of the detail window. */
export const ELIDED_TOOL_OUTPUT =
  "[output from an earlier turn, trimmed to save context]";

/**
 * Below this many serialized characters a result is not worth stubbing — the
 * stub would be most of what it replaced.
 */
const MIN_ELIDABLE_OUTPUT = 200;

/** Serialized size of a tool result's output, for the "worth stubbing" test. */
function outputSize(output: ToolResultPart["output"]): number {
  if (output.type === "text" || output.type === "error-text")
    return output.value.length;
  if (output.type === "execution-denied") return (output.reason ?? "").length;
  try {
    return JSON.stringify(output.value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Shrink the window without shortening it: stub out the *payloads* of tool
 * results the model has moved past, leaving every message, every tool call — and
 * therefore every note the model wrote itself — exactly where it was.
 *
 * This is the other half of {@link windowMessages}, and it exists because the two
 * things a rolling window holds have opposite value curves. A recipe's own
 * reasoning and its tool-call *inputs* stay useful for as long as the run does; a
 * tool *result* is a snapshot of a world that has since moved, and it is also
 * where nearly all the tokens are. Dropping whole turns to bound context throws
 * both away together, which is why a short window makes a model re-derive what it
 * already knew.
 *
 * A result's output survives if any of:
 *
 * 1. it is within the last `keepRecent` assistant messages — the same unit
 *    `windowMessages` counts in, so the two knobs are commensurable;
 * 2. **it is the newest result for its tool**, at any age. Tools may hold state
 *    about what they have already shown this chunk and answer a repeat with
 *    "unchanged since you last looked" — a real optimization that becomes a lie
 *    the moment the render it points at is gone. Keeping the newest per tool is
 *    what makes "your latest view" a thing the model can still see, and it is why
 *    `keepRecent` can be small;
 * 3. it reports a failure or a denial — short, diagnostic, and losing *why* a
 *    call failed costs a retry to rediscover for no saving;
 * 4. it is already small enough that stubbing it saves nothing.
 *
 * Idempotent: a stubbed part is small, so a later pass leaves it alone.
 *
 * `keepRecent` is normalized rather than trusted — see the note on `keep` below.
 * Zero is a legal, meaningful value: no turn is recent, so rule 1 protects
 * nothing and rules 2-4 carry the whole of what survives.
 */
export function elideToolOutputs(
  messages: ModelMessage[],
  keepRecent: number
): ModelMessage[] {
  /**
   * Rule 1's width, normalized to a non-negative integer.
   *
   * Not defensive habit: `keepRecent` is a config value reaching a function whose
   * arithmetic indexes an array with it, and every out-of-contract value used to
   * land on the *same* wrong branch. `assistantIdx[len - 0]` is `undefined`, as is
   * any negative or `NaN` index, and `i >= undefined` is false for every `i` — so
   * `cutoff` silently meant "no turn is recent" instead of throwing or clamping.
   * That happens to be right for 0 and wrong for everything else, which is the
   * worst way for a guard to fail: correct until the day someone passes -1.
   *
   * So 0 now says it explicitly (see `cutoff`), and nothing else can reach it by
   * accident. `NaN` is the one value with no reading at all, and it takes the
   * conservative floor — still bounded by rules 2-4, which keep the newest result
   * per tool, every failure, and everything already small. Both infinities keep
   * the reading they plainly have: an unboundedly wide window keeps everything, a
   * negative one keeps nothing.
   */
  const keep = Number.isNaN(keepRecent)
    ? 0
    : Math.max(0, Math.trunc(keepRecent));

  // Where the detail window starts, counted in assistant messages so it lines up
  // with `historyWindow`. Everything before it is a candidate for elision, so
  // `messages.length` is the honest spelling of an empty window and 0 the honest
  // spelling of a window covering everything (fewer assistant messages than the
  // window ⇒ keep all).
  const assistantIdx: number[] = [];
  for (const [i, m] of messages.entries()) {
    if (m.role === "assistant") assistantIdx.push(i);
  }
  const cutoff =
    keep === 0
      ? messages.length
      : assistantIdx.length <= keep
        ? 0
        : assistantIdx[assistantIdx.length - keep];
  if (cutoff === 0) return messages;

  // The newest result per tool, so rule 2 can be a lookup rather than a scan.
  const newestPerTool = new Map<string, number>();
  for (const [i, message] of messages.entries()) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") newestPerTool.set(part.toolName, i);
    }
  }

  let changed = false;
  const out = messages.map((message, i) => {
    if (message.role !== "tool" || i >= cutoff) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      if (newestPerTool.get(part.toolName) === i) return part;
      if (
        part.output.type === "error-text" ||
        part.output.type === "error-json" ||
        part.output.type === "execution-denied"
      )
        return part;
      if (outputSize(part.output) < MIN_ELIDABLE_OUTPUT) return part;
      messageChanged = true;
      return {
        ...part,
        output: { type: "text" as const, value: ELIDED_TOOL_OUTPUT }
      };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}
