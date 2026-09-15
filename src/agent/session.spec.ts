import { describe, it, expect, vi } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { isCompactionMessage } from "agents/sessions";
import {
  appendOnce,
  buildAgentSession,
  notifyingCompaction,
  type AgentSessionOptions
} from "./session.js";
import {
  deterministicSessionMessage,
  sessionText,
  toModelMessages
} from "./history.js";
import { FakeSession } from "../testing/fake-session.js";
import { TEST_MODELS } from "../testing/fixtures.js";
import { ConfigError, DEFAULT_CORE_CONFIG, resolveConfig } from "../config.js";
import type { SessionMessage } from "agents/sessions";
import { mockModel } from "../testing/mock-model.js";
import type { TestAgent } from "../../test/worker.js";

/**
 * The session seam the round loop depends on.
 *
 * Two properties carry real weight here, and both exist because a Workflow step
 * can re-run: appends are exactly-once by deterministic id, and what a caller
 * goes on to deliver is read back from storage rather than trusted from the
 * in-memory value it just produced. A step that crashed after appending and then
 * re-inferred a *different* reply must still deliver the original.
 */

const msg = (
  id: string,
  text: string,
  role: "user" | "assistant" = "assistant"
) => deterministicSessionMessage(id, role, text);

describe("appendOnce", () => {
  it("returns the durably stored text, not the text just handed in", async () => {
    const session = new FakeSession();
    await appendOnce(session, msg("task:t1:reply:final", "the original reply"));

    // The re-run: same deterministic id, different inference.
    const returned = await appendOnce(
      session,
      msg("task:t1:reply:final", "a DIFFERENT reply after retry")
    );

    // The append no-ops, and the caller is handed what is actually on disk — so
    // the Session and the delivered value can never disagree.
    expect(returned).toBe("the original reply");
    expect(session.messages).toHaveLength(1);
  });

  it("appends distinct ids normally", async () => {
    const session = new FakeSession();
    await appendOnce(session, msg("a", "first"));
    await appendOnce(session, msg("b", "second"));

    expect(session.messages.map((m) => sessionText(m))).toEqual([
      "first",
      "second"
    ]);
  });

  it("falls back to the message's own text rather than failing a phase", async () => {
    // Cannot happen — the message was just appended — but a missing echo must
    // not be the thing that fails a turn.
    const session = new FakeSession();
    vi.spyOn(session, "getMessage").mockResolvedValue(null);

    expect(await appendOnce(session, msg("x", "inline text"))).toBe(
      "inline text"
    );
  });
});

describe("notifyingCompaction", () => {
  const history = [msg("m1", "one"), msg("m2", "two"), msg("m3", "three")];
  const result = { fromMessageId: "m1", toMessageId: "m2" };

  it("hands the displaced range to the listener", async () => {
    const displaced: SessionMessage[][] = [];
    const wrapped = notifyingCompaction(
      (async () => result) as never,
      async (messages) => {
        displaced.push(messages);
      }
    );

    await wrapped(history as never);

    // Inclusive of both ends: m1..m2 is what the summary replaced.
    expect(displaced[0].map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("returns the base function untouched when nothing is listening", () => {
    const base = (async () => result) as never;
    expect(notifyingCompaction(base, undefined)).toBe(base);
  });

  it("still compacts when the listener throws", async () => {
    // Compaction must shorten history even when whatever is listening is
    // briefly unavailable — the alternative is unbounded context because a
    // side concern is down.
    const wrapped = notifyingCompaction(
      (async () => result) as never,
      async () => {
        throw new Error("listener unavailable");
      }
    );

    await expect(wrapped(history as never)).resolves.toEqual(result);
  });

  it("skips the notification when the displaced range is not in the history it saw", async () => {
    const onMessagesDisplaced = vi.fn();
    const wrapped = notifyingCompaction(
      (async () => ({ fromMessageId: "ghost", toMessageId: "m2" })) as never,
      onMessagesDisplaced
    );

    await wrapped(history as never);
    expect(onMessagesDisplaced).not.toHaveBeenCalled();
  });
});

describe("buildAgentSession on a real Durable Object", () => {
  /**
   * The SDK's message store and prompt blocks, assembled by core. A fake cannot
   * stand in here: what these pin is where the rows land and what the SDK does
   * with them, and every deployed caller's history and memory are those rows.
   */
  const ns = (
    env as unknown as { TEST_AGENT: DurableObjectNamespace<TestAgent> }
  ).TEST_AGENT;
  const inAgent = <R>(fn: (agent: TestAgent) => Promise<R>) =>
    runInDurableObject(
      ns.get(ns.idFromName(`session:${crypto.randomUUID()}`)),
      fn
    );

  const options = (
    over: Partial<AgentSessionOptions> = {}
  ): AgentSessionOptions => ({
    soul: () => "SOUL",
    memoryDescription: "facts worth keeping",
    memoryMaxTokens: 500,
    compactAfterTokens: 100_000,
    compactTailTokens: 20_000,
    maxOutputTokens: 256,
    ...over
  });

  const build = (agent: TestAgent, over?: Partial<AgentSessionOptions>) =>
    buildAgentSession(
      agent,
      agent.sessions.session(),
      mockModel({ text: "a summary" }),
      options(over)
    );

  it("keeps the first stored text when a re-run appends the same id", async () => {
    await inAgent(async (agent) => {
      const session = build(agent);
      await appendOnce(session, msg("task:t1:reply:final", "the original"));

      expect(
        await appendOnce(session, msg("task:t1:reply:final", "a retry's reply"))
      ).toBe("the original");
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        "task:t1:reply:final"
      ]);
    });
  });

  it("reads and writes memory under the row every deployed caller already has", async () => {
    await inAgent(async (agent) => {
      // The row an existing caller's scratchpad is stored under, written
      // directly. Renaming the block would strand it.
      agent.sql`CREATE TABLE IF NOT EXISTS cf_agents_context_blocks (
        label TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`;
      agent.sql`INSERT INTO cf_agents_context_blocks (label, content)
        VALUES ('memory', 'the user prefers tabs')`;

      const session = build(agent);
      // Pinned whole, not by substring. What the model reads is the prompt's
      // exact bytes: the block order, the rules, the usage line. A change to any
      // of it changes every prompt this package sends and invalidates the
      // provider's prefix cache, so it must not pass unnoticed.
      const rule = "\u2550".repeat(46);
      expect(await session.refreshSystemPrompt()).toBe(
        `${rule}\nSOUL [readonly]\n${rule}\nSOUL\n\n` +
          `${rule}\nMEMORY (facts worth keeping) [1% \u2014 6/500 tokens] [writable]\n${rule}\n` +
          "the user prefers tabs"
      );

      const tools = await session.tools();
      expect(Object.keys(tools)).toEqual(["set_context"]);
      // No `search_context`: a soul block is read-only and memory is a plain
      // writable block, so this is the whole tool surface a session contributes.
      expect(tools.set_context!.description).toBe(
        'Write to a context block. Available blocks:\n- "memory" (writable): ' +
          "facts worth keeping\n\nWrites are durable and persist across sessions."
      );
      await tools.set_context!.execute!(
        { label: "memory", content: "the user prefers spaces" },
        { toolCallId: "c1", messages: [], context: undefined }
      );
      const [row] = agent.sql<{ content: string }>`
        SELECT content FROM cf_agents_context_blocks WHERE label = 'memory'`;
      expect(row?.content).toBe("the user prefers spaces");
    });
  });

  it("appends onto a named parent, so a caller can still branch", async () => {
    await inAgent(async (agent) => {
      const session = build(agent);
      await session.appendMessage(msg("root", "the question", "user"));
      await session.appendMessage(msg("first", "one answer"));
      await session.appendMessage(msg("second", "another answer"), "root");

      // The second answer hangs off the question rather than off the first
      // answer, so the active path is the branch it created.
      expect((await session.getHistory()).map((m) => m.id)).toEqual([
        "root",
        "second"
      ]);
    });
  });

  it("compacts past the threshold and hands over what it folded", async () => {
    await inAgent(async (agent) => {
      const displaced: string[] = [];
      const session = build(agent, {
        compactAfterTokens: 50,
        compactTailTokens: 10,
        onMessagesDisplaced: async (messages) => {
          displaced.push(...messages.map((m) => m.id));
        }
      });

      const ids = Array.from({ length: 8 }, (_, i) => `m${i}`);
      for (const id of ids) {
        await session.appendMessage(msg(id, `${id} `.repeat(60)));
      }

      expect((await session.getCompactions()).length).toBeGreaterThan(0);
      expect((await session.getHistory()).some(isCompactionMessage)).toBe(true);
      expect(displaced.length).toBeGreaterThan(0);
      expect(displaced.every((id) => ids.includes(id))).toBe(true);
      // The raw rows outlive the overlay, which is what `appendOnce` reads back.
      expect(await session.getMessage(displaced[0]!)).not.toBeNull();
    });
  });
});

describe("history conversion", () => {
  it("keeps only user and assistant turns for the model", () => {
    const withSystem = [
      msg("u", "hello", "user"),
      msg("a", "hi", "assistant"),
      { ...msg("s", "system note"), role: "system" } as SessionMessage
    ];

    expect(toModelMessages(withSystem)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ]);
  });

  it("concatenates multi-part text and ignores non-text parts", () => {
    const multi = {
      ...msg("m", ""),
      parts: [
        { type: "text", text: "one " },
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "two" }
      ]
    } as SessionMessage;

    expect(sessionText(multi)).toBe("one two");
  });
});

describe("the compaction headroom invariant", () => {
  it("holds for the shipped defaults", () => {
    const { compactAfterTokens, compactTailTokens } =
      DEFAULT_CORE_CONFIG.session;
    expect(compactAfterTokens - compactTailTokens).toBeGreaterThanOrEqual(
      10_000
    );
  });

  it("refuses a config where the floor would eat the gap", () => {
    // Below this, compaction fires on nearly every append and each firing spends
    // a summarizer call on a near-empty middle. It is a config error, not a
    // tuning preference.
    expect(() =>
      resolveConfig({
        model: TEST_MODELS,
        session: { compactAfterTokens: 12_000 }
      })
    ).toThrow(ConfigError);

    expect(() =>
      resolveConfig({
        model: TEST_MODELS,
        session: { compactAfterTokens: 12_000 }
      })
    ).toThrow(/>= 10000/);
  });

  it("accepts a lower threshold when the tail comes down with it", () => {
    const config = resolveConfig({
      model: TEST_MODELS,
      session: { compactAfterTokens: 12_000, compactTailTokens: 1_000 }
    });

    expect(config.session.compactAfterTokens).toBe(12_000);
    expect(config.session.compactTailTokens).toBe(1_000);
  });

  it("refuses non-positive budgets", () => {
    expect(() => resolveConfig({ model: TEST_MODELS, maxSubtasks: 0 })).toThrow(
      ConfigError
    );
    expect(() =>
      resolveConfig({ model: TEST_MODELS, mainAgentLimits: { maxTurns: -1 } })
    ).toThrow(/maxTurns/);
  });
});
