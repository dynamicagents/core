import type { LanguageModel, ToolSet } from "ai";
import { generateText } from "ai";
import { AgentContextProvider, ContextBlocks } from "agents/context";
import {
  createCompactFunction,
  type CompactionFunction,
  type Session,
  type SessionMessage
} from "agents/sessions";
import { sessionText } from "./history.js";

/**
 * The one continuous {@link Session} an agent Durable Object owns: soul + memory
 * + compaction, one Session per DO.
 *
 * The SDK splits this across two modules — `agents/sessions` stores messages and
 * `agents/context` renders the prompt blocks — and {@link SessionLike} is where
 * they are put back together. That keeps the split out of every loop and plugin
 * reading a session, and it keeps the SDK's experimental surface in one file.
 *
 * Compaction is the one **lossy** thing this module does, so it is also the one
 * thing it announces: `onMessagesDisplaced` hands over the raw messages a
 * summary is about to replace. Core neither stores them nor knows who wants
 * them — a host wires the seam to whatever does.
 */

/**
 * The SQLite-backed host the `memory` block is stored through — satisfied by the
 * Agents SDK `Agent` (`this.sql`).
 */
export interface SessionHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/**
 * What the agent loop drives: the session's messages and its context blocks, as
 * one object — lets tests inject a fake.
 */
export interface SessionLike {
  /**
   * Append a message, optionally onto a named parent: `undefined` attaches to
   * the current leaf, `null` starts a root, an id branches from that message.
   * Core itself never branches — this is here because a consumer may.
   */
  appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<unknown> | unknown;
  getHistory(): Promise<SessionMessage[]>;
  /**
   * Read one message by id, or null. Reads the **raw stored row**, so it is
   * unaffected by compaction overlays — a message folded into a summary is still
   * readable here. That is what makes {@link appendOnce}'s read-back a reliable
   * recovery path for a round whose Workflow step re-ran.
   */
  getMessage(id: string): Promise<SessionMessage | null>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
  /** Compaction overlays so far — non-empty ⇒ history has been displaced. */
  getCompactions(): Promise<unknown[]>;
}

/**
 * Append a message with a deterministic id exactly once, and return the text that
 * is **durably stored** under that id.
 *
 * `Session.appendMessage` is already idempotent by id: appending an id that
 * exists writes nothing. The read-back is what matters for a re-run step — if it
 * crashed after appending and the retry re-inferred a *different* reply, the
 * append no-ops and this returns the original, durable text. The Session and the
 * value the caller goes on to deliver therefore never disagree.
 *
 * Falls back to the message's own text if the read-back returns null (it cannot,
 * having just been appended) rather than failing a round over a missing echo.
 */
export async function appendOnce(
  session: SessionLike,
  message: SessionMessage
): Promise<string> {
  await session.appendMessage(message);
  const stored = await session.getMessage(message.id);
  return stored ? sessionText(stored) : sessionText(message);
}

export interface AgentSessionOptions {
  /** Read-only identity block injected into the system prompt every turn. */
  soul: () => string | Promise<string>;
  /** Description of the writable SQLite `"memory"` scratchpad the model self-edits. */
  memoryDescription: string;
  /** Soft cap (tokens) for the `"memory"` block. */
  memoryMaxTokens: number;
  /** History token threshold that triggers compaction. */
  compactAfterTokens: number;
  /**
   * Tokens of recent history compaction keeps verbatim. Coupled to
   * {@link compactAfterTokens} — see `SessionConfig.compactTailTokens` for the
   * invariant that binds them, which `resolveConfig` enforces.
   */
  compactTailTokens: number;
  /**
   * Output-token ceiling for the summarizer call. An unbounded summary is not
   * the risk; a silently truncated one is — it becomes this caller's memory of
   * everything that scrolled out, with no way to tell it was cut short.
   */
  maxOutputTokens: number;
  /**
   * Hand over the raw messages each compaction displaces, before a summary
   * replaces them. Best-effort: a throw here must never abort compaction.
   *
   * The seam, not a policy — pass `runtime.onMessagesDisplaced` to reach every
   * installed plugin declaring the hook, or any function of your own.
   */
  onMessagesDisplaced?: (messages: SessionMessage[]) => Promise<void>;
}

/**
 * Wrap a compaction function so the raw messages it folds into a summary are
 * also handed to `onMessagesDisplaced` before they stop being readable as
 * history. The displaced range is `fromMessageId..toMessageId` of the result,
 * sliced from the `history` the compaction saw.
 *
 * A listener's failure is swallowed — compaction must still shorten history
 * when whatever is listening is briefly unavailable. The alternative is
 * unbounded context because a side concern is down.
 */
export function notifyingCompaction(
  base: CompactionFunction,
  onMessagesDisplaced?: (messages: SessionMessage[]) => Promise<void>
): CompactionFunction {
  if (!onMessagesDisplaced) return base;
  return async (history) => {
    const result = await base(history);
    if (result) {
      const from = history.findIndex((m) => m.id === result.fromMessageId);
      const to = history.findIndex((m) => m.id === result.toMessageId);
      if (from !== -1 && to !== -1) {
        try {
          await onMessagesDisplaced(history.slice(from, to + 1));
        } catch (err) {
          console.error("[session] displacement listener failed", err);
        }
      }
    }
    return result;
  };
}

/**
 * Build the one continuous session an agent Durable Object owns: a read-only
 * `"soul"` identity block + a writable `"memory"` scratchpad, with history
 * compaction summarized by the same model. All of a caller's turns (any channel
 * or thread) accumulate into this single conversation.
 *
 * `session` is a handle from a `Sessions` capability the host has already
 * installed on its lifecycle — see {@link file://../host/agent.ts DynamicAgent}.
 *
 * The block labels are storage keys, not names: `memory` is the row label in
 * `cf_agents_context_blocks` that every existing caller's scratchpad is stored
 * under, so renaming it strands all of them.
 */
export function buildAgentSession(
  agent: SessionHost,
  session: Session,
  model: LanguageModel,
  opts: AgentSessionOptions
): SessionLike {
  session
    .onCompaction(
      notifyingCompaction(
        createCompactFunction({
          // The one boundary worth owning. The protected head and the tail
          // floor are the SDK's: the head is the conversation's opening and is
          // cheap, and the floor is a safety net rather than a budget.
          keepRecentTokens: opts.compactTailTokens,
          // Bounded like every other call — see `maxOutputTokens`.
          summarize: (prompt) =>
            generateText({
              model,
              prompt,
              maxOutputTokens: opts.maxOutputTokens
            }).then((r) => r.text)
        }),
        opts.onMessagesDisplaced
      )
    )
    .compactAfter(opts.compactAfterTokens);

  const context = new ContextBlocks([
    { label: "soul", provider: { get: async () => opts.soul() } },
    {
      label: "memory",
      description: opts.memoryDescription,
      maxTokens: opts.memoryMaxTokens,
      provider: new AgentContextProvider(agent, "memory")
    }
  ]);

  return {
    // `parentId` is passed only when the caller named one: the SDK reads an
    // explicit `null` as "start a root", which is not what omitting it means.
    appendMessage: (message, parentId) =>
      parentId === undefined
        ? session.appendMessage(message)
        : session.appendMessage(message, { parentId }),
    getHistory: () => session.getHistory(),
    getMessage: (id) => session.getMessage(id),
    getCompactions: () => session.getCompactions(),
    refreshSystemPrompt: () => context.refreshSystemPrompt(),
    tools: () => context.tools()
  };
}
