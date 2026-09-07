/**
 * What a round saw, carried to the round after it.
 *
 * ## The defect this exists for
 *
 * A round is one `generateText` call. Work-tool calls and their results live
 * inside it and end with it: what reaches the Session is the round's *ending* —
 * the `delegate` call and the acknowledgment the user read. So the next round
 * inherits the model's claim and none of the evidence behind it.
 *
 * On 2026-09-05 that ran thirteen times. Every round cloned the repository,
 * confirmed the checkout, delegated, and watched the branch fail; every round
 * began again knowing none of it. Two things followed, and both are the
 * architecture rather than the model:
 *
 * - the same `git@github.com:…` URL was refused in **every** round, because a
 *   refusal is a work-tool result and was dropped with the rest — roughly 26 of a
 *   60-turn budget spent re-learning one lesson;
 * - by round five the context held five of the agent's own assertions that the
 *   repository was ready and zero records of how it had checked. History was
 *   exactly the claims and none of the observations, which is a loop that
 *   reinforces itself by construction.
 *
 * ## The shape of the fix
 *
 * The same one {@link file://./turn.ts delegationPair} already uses, for the same
 * reason: **both halves are real**. That round's model genuinely emitted these
 * calls and the tools genuinely returned these results. All that separates them
 * from the next round is a Workflow boundary, so they are persisted as rows and
 * reconstructed into the call-and-result pairs they were — not summarized, and
 * not written into the Session, which stays text-only.
 *
 * What is *not* carried is as deliberate. The ending is dropped whole: the
 * acknowledgment and its `delegate` call are already durable and already
 * reconstructed, and carrying them twice would show the model two of every
 * delegation. Reasoning parts are dropped because they are provider-shaped, large,
 * and about how the model got to a call rather than what came back from it.
 */
import type { ModelMessage, ToolResultPart } from "ai";
import { elideToolOutputs } from "../agent/window.js";

/** One round's carried exchanges, as the durable row holds them. */
export interface RoundObservations {
  /** The round that made these calls. */
  round: number;
  /** Its work-tool exchanges, already paired, bounded and re-identified. */
  messages: ModelMessage[];
}

/**
 * The most a single tool result may carry into a later round.
 *
 * Two problems, one bound. A build log or a directory listing is genuinely large
 * and only its head is diagnostic; and a tool that answers with media — a
 * screenshot, a PDF page — serializes to base64 that would blow both the row and
 * the context for a payload no later round can act on anyway. Truncating on
 * serialized size catches both without needing to know which tools exist.
 */
const MAX_OBSERVATION_OUTPUT_CHARS = 4_000;

/**
 * The most one round's exchanges may carry in total.
 *
 * The multiplication is the point, and it is the same one
 * {@link file://../subtasks/delegate.ts MAX_OUTPUT_CHARS} was written for: a
 * round's messages hold every carried round, so this is paid once per round in
 * the window and not once per task. Overflow drops the **oldest** pairs, because
 * a round's later calls are the ones its ending was reasoning from.
 */
const MAX_OBSERVATION_CHARS = 12_000;

/** Appended to a text result the cap shortened. Mechanical, not instructional. */
const TRUNCATION_MARKER =
  "\n[…truncated — the rest did not fit past the round that produced it]";

/** What replaces a result the cap could not usefully shorten. */
const DROPPED_TOOL_OUTPUT =
  "[result too large to carry past the round that produced it]";

/** Serialized size of a tool result's output, for the caps above. */
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
 * Bring one result's output under {@link MAX_OBSERVATION_OUTPUT_CHARS}.
 *
 * **A text result is shortened, never replaced**, and the difference matters
 * most exactly where it is easiest to get wrong. A failure's reason is the single
 * most valuable thing a round can hand the next one — losing it costs a retry to
 * rediscover, which is the cost this whole file exists to remove — and a failure
 * is text. So its head survives, marked, however long the tail was. The same is
 * true of a build log or a listing: the first lines are the diagnostic ones.
 *
 * Anything else is replaced outright. A prefix of JSON does not parse, and a
 * prefix of the base64 a screenshot serializes to is not a smaller picture —
 * it is the same nothing at a lower price, and pretending otherwise would put an
 * unreadable fragment where a plain statement of absence belongs.
 */
function bound(output: ToolResultPart["output"]): ToolResultPart["output"] {
  if (outputSize(output) <= MAX_OBSERVATION_OUTPUT_CHARS) return output;
  // Each kind keeps its own kind. A provider and a model both read `error-text`
  // and `execution-denied` differently from `text`, and a result that was
  // shortened is still the thing it was — a failure, or a refusal.
  if (output.type === "execution-denied")
    return { type: "execution-denied", reason: shorten(output.reason ?? "") };
  if (output.type === "error-text")
    return { type: "error-text", value: shorten(output.value) };
  if (output.type === "text")
    return { type: "text", value: shorten(output.value) };
  return { type: "text", value: DROPPED_TOOL_OUTPUT };
}

/**
 * The head of a text payload, marked so the model knows the rest was there.
 *
 * The marker is charged against the cap rather than appended past it. A bound
 * every shortened result overshoots by the length of its own marker is not a
 * bound — and this one is multiplied by every result in every carried round,
 * which is the arithmetic {@link MAX_OBSERVATION_CHARS} exists to keep honest.
 */
function shorten(text: string): string {
  return (
    text.slice(0, MAX_OBSERVATION_OUTPUT_CHARS - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

/** Rough serialized size of a whole message, for {@link MAX_OBSERVATION_CHARS}. */
function messageSize(message: ModelMessage): number {
  try {
    return JSON.stringify(message).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Take the round's work-tool exchanges out of what the model actually produced.
 *
 * Four passes, in this order, because each depends on the one before:
 *
 * 1. **Pair up.** Only calls that came back are kept, in both directions. A
 *    provider rejects an assistant `tool_use` with no matching `tool_result`, and
 *    a `tool_result` naming a call that is not there — so a round cut off
 *    mid-step, which is exactly the round most worth carrying, would otherwise
 *    produce a history the next round cannot even send.
 * 2. **Drop the ending.** Any assistant message reaching for a control tool goes
 *    whole: that message *is* the acknowledgment, and it is reconstructed from
 *    the Session by `delegationPair`.
 * 3. **Re-identify.** Provider ids are not replayable — the incident's own
 *    transcript carries `functions.repo_clone:13`, and Anthropic rejects any
 *    `tool_use.id` outside `^[a-zA-Z0-9_-]+$`. Rewritten deterministically so a
 *    re-run of the same round produces the same row.
 * 4. **Bound.** Per result, then per round. See the two caps above.
 */
export function captureObservations(
  captured: readonly ModelMessage[],
  opts: {
    /** The round these came from — part of every rewritten tool-call id. */
    round: number;
    /** The tools whose calls *end* a round, and are therefore not work. */
    controlNames: readonly string[];
  }
): ModelMessage[] {
  // 1. Which calls came back at all.
  const answered = new Set<string>();
  for (const message of captured) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }

  // 1 + 2. Keep the exchanges; drop the ending, the narration that ends with it,
  // and anything unpaired in either direction.
  const paired: ModelMessage[] = [];
  const carried = new Set<string>();
  for (const message of captured) {
    if (message.role === "assistant") {
      // A string body is narration with no call in it — nothing observed.
      if (typeof message.content === "string") continue;
      const ends = message.content.some(
        (part) =>
          part.type === "tool-call" && opts.controlNames.includes(part.toolName)
      );
      if (ends) continue;
      const content = message.content.filter(
        (part) =>
          part.type === "text" ||
          (part.type === "tool-call" && answered.has(part.toolCallId))
      );
      // Text with no surviving call is the model talking about work it did not
      // get to do. The observations are what came back, not what was intended.
      if (!content.some((part) => part.type === "tool-call")) continue;
      for (const part of content) {
        if (part.type === "tool-call") carried.add(part.toolCallId);
      }
      paired.push({ role: "assistant", content });
      continue;
    }
    if (message.role !== "tool") continue;
    const content = message.content.filter(
      (part) => part.type === "tool-result" && carried.has(part.toolCallId)
    );
    if (content.length === 0) continue;
    paired.push({ role: "tool", content });
  }

  // 3 + 4a. One id space per round, and a ceiling on any single result.
  const ids = new Map<string, string>();
  const identify = (original: string): string => {
    const existing = ids.get(original);
    if (existing) return existing;
    const assigned = `obs_r${opts.round}_${ids.size}`;
    ids.set(original, assigned);
    return assigned;
  };

  const bounded = paired.map((message): ModelMessage => {
    if (message.role === "assistant" && typeof message.content !== "string") {
      return {
        role: "assistant",
        content: message.content.map((part) =>
          part.type === "tool-call"
            ? { ...part, toolCallId: identify(part.toolCallId) }
            : part
        )
      };
    }
    if (message.role !== "tool") return message;
    return {
      role: "tool",
      content: message.content.map((part) =>
        part.type === "tool-result"
          ? {
              ...part,
              toolCallId: identify(part.toolCallId),
              output: bound(part.output)
            }
          : part
      )
    };
  });

  return trimToBudget(bounded, MAX_OBSERVATION_CHARS);
}

/**
 * Drop whole exchanges off the front until the round fits its budget.
 *
 * Cuts at an assistant boundary, for the reason
 * {@link file://../agent/window.ts windowMessages} does: a cut that lands on a
 * `tool` message orphans its result from the call it answers, which is the one
 * shape a provider refuses outright.
 */
function trimToBudget(
  messages: ModelMessage[],
  budget: number
): ModelMessage[] {
  const sizes = messages.map(messageSize);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) return messages;

  let spent = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (spent + sizes[i] > budget) break;
    spent += sizes[i];
    start = i;
  }
  // Never begin on a result whose call was just dropped.
  while (start < messages.length && messages[start].role === "tool") start += 1;
  return messages.slice(start);
}

/**
 * Bound the carried rounds against each other, and hand each round back its own.
 *
 * The elision runs over **every carried round at once**, which is the whole
 * reason it is done here rather than at capture. Its second rule keeps the newest
 * result per tool at any age — so a `repo_clone` run in three consecutive rounds
 * keeps its latest answer in full and stubs the two identical ones behind it,
 * which is precisely the shape this incident produced. A per-round elision could
 * not see across rounds and would keep all three.
 *
 * `elideToolOutputs` rewrites payloads and never adds or removes a message, so
 * the rounds are split back apart on the lengths they went in with.
 */
export function renderObservations(
  rounds: readonly RoundObservations[],
  toolOutputWindow: number
): Map<number, ModelMessage[]> {
  const rendered = new Map<number, ModelMessage[]>();
  if (rounds.length === 0) return rendered;

  const ordered = [...rounds].sort((a, b) => a.round - b.round);
  const elided = elideToolOutputs(
    ordered.flatMap((r) => r.messages),
    toolOutputWindow
  );

  let at = 0;
  for (const round of ordered) {
    rendered.set(round.round, elided.slice(at, at + round.messages.length));
    at += round.messages.length;
  }
  return rendered;
}
