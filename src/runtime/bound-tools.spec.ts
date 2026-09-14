import { describe, it, expect, vi } from "vitest";
import { generateText, isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { mockModel } from "../testing/mock-model.js";
import { boundToolCalls } from "./bound-tools.js";

/**
 * The wrapper core puts around every plugin tool. What these pin is the split
 * `MAX_TOOL_CALL_MS` depends on: the loop stops waiting on a call whether or not
 * the tool listens, and a tool that does listen still answers for itself.
 *
 * The graces here are milliseconds so a spec can wait one out; the real one is
 * `TOOL_CALL_GRACE_MS`.
 */

/** One `execute` call, with the options the SDK would pass it. */
const call = (tools: ToolSet, name: string, abortSignal?: AbortSignal) =>
  tools[name]!.execute!(
    {},
    {
      toolCallId: "call-1",
      messages: [],
      context: undefined,
      ...(abortSignal ? { abortSignal } : {})
    }
  );

/** Work that never finishes on its own, released in `finally` by every spec. */
function hanging() {
  let release = () => {};
  const done = new Promise<string>((resolve) => {
    release = () => resolve("far too late");
  });
  return { done, release };
}

describe("boundToolCalls", () => {
  it("returns a call with no signal exactly as the tool did", () => {
    const answer = Promise.resolve("answered");
    const tools = boundToolCalls({
      look: tool({
        description: "look",
        inputSchema: z.object({}),
        execute: () => answer
      })
    });

    // No deadline and nothing to cancel from, so no wrapper promise, listener or
    // timer either.
    expect(call(tools, "look")).toBe(answer);
  });

  it("passes on the tool's own answer when it stops inside the grace", async () => {
    const controller = new AbortController();
    const tools = boundToolCalls(
      {
        run: tool({
          description: "Stops when told.",
          inputSchema: z.object({}),
          execute: (_input, { abortSignal }) =>
            new Promise<string>((resolve) => {
              abortSignal?.addEventListener(
                "abort",
                () => resolve("stopped: killed the process"),
                { once: true }
              );
            })
        })
      },
      100
    );

    const pending = call(tools, "run", controller.signal);
    controller.abort();

    // What a tool that honours its signal is owed: the model reads its account of
    // what it stopped, not core's guess at it.
    await expect(pending).resolves.toBe("stopped: killed the process");
  });

  it("abandons a call that ignores its signal once the grace runs out", async () => {
    const { done, release } = hanging();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = boundToolCalls(
      {
        deaf: tool({
          description: "Never reads its signal.",
          inputSchema: z.object({}),
          execute: () => done
        })
      },
      100
    );

    try {
      const pending = Promise.resolve(
        call(tools, "deaf", AbortSignal.timeout(1))
      );
      let settled = false;
      pending.then(
        () => (settled = true),
        () => (settled = true)
      );

      // Past the deadline and inside the grace: still waiting, because the grace
      // is the tool's to use even when it will not.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);

      await expect(pending).rejects.toThrow(
        /^deaf did not finish within its time limit\b.*may still be running/
      );
      // The only trace a tool that ignores its signal leaves.
      expect(warn).toHaveBeenCalledWith(
        "[tools] abandoned a call that did not stop at its signal",
        { tool: "deaf", reason: "time limit" }
      );
    } finally {
      warn.mockRestore();
      release();
    }
  });

  it("says a cancelled call was cancelled, not that it ran out of time", async () => {
    const { done, release } = hanging();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const tools = boundToolCalls(
      {
        deaf: tool({
          description: "Never reads its signal.",
          inputSchema: z.object({}),
          execute: () => done
        })
      },
      10
    );

    try {
      const pending = call(tools, "deaf", controller.signal);
      controller.abort();

      await expect(pending).rejects.toThrow(
        "deaf was abandoned because this call was cancelled."
      );
    } finally {
      warn.mockRestore();
      release();
    }
  });

  it("does not start a call whose signal has already fired", async () => {
    const execute = vi.fn(async () => "ran");
    const tools = boundToolCalls({
      act: tool({ description: "act", inputSchema: z.object({}), execute })
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      Promise.resolve(call(tools, "act", controller.signal))
    ).rejects.toMatchObject({ name: "AbortError" });
    // Starting it would begin work only to walk away from it.
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes a stream's values through when nothing stops it", async () => {
    const tools = boundToolCalls({
      feed: tool({
        description: "Streams.",
        inputSchema: z.object({}),
        execute: async function* () {
          yield "partial";
          yield "whole";
        }
      })
    });

    const seen: unknown[] = [];
    const stream = call(
      tools,
      "feed",
      new AbortController().signal
    ) as AsyncIterable<unknown>;
    for await (const value of stream) seen.push(value);

    expect(seen).toEqual(["partial", "whole"]);
  });

  it("abandons a stream that stops yielding once the grace runs out", async () => {
    const { done, release } = hanging();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools = boundToolCalls(
      {
        feed: tool({
          description: "Streams, then stalls.",
          inputSchema: z.object({}),
          execute: async function* () {
            yield "partial";
            yield await done;
          }
        })
      },
      30
    );

    try {
      const seen: unknown[] = [];
      const drain = async () => {
        const stream = call(
          tools,
          "feed",
          AbortSignal.timeout(1)
        ) as AsyncIterable<unknown>;
        for await (const value of stream) seen.push(value);
      };

      await expect(drain()).rejects.toThrow(
        /^feed did not finish within its time limit/
      );
      // What it had said before stalling still reached the SDK.
      expect(seen).toEqual(["partial"]);
    } finally {
      warn.mockRestore();
      release();
    }
  });

  it("does not let a stream that keeps yielding restart the grace", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let yielded = 0;
    const tools = boundToolCalls(
      {
        feed: tool({
          description: "Streams forever.",
          inputSchema: z.object({}),
          execute: async function* () {
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              yielded += 1;
              yield yielded;
            }
          }
        })
      },
      30
    );

    try {
      const drain = async () => {
        const stream = call(
          tools,
          "feed",
          AbortSignal.timeout(1)
        ) as AsyncIterable<unknown>;
        // Each value arrives well inside the grace on its own; only a grace
        // shared by the whole call can end this.
        for await (const _value of stream) void _value;
      };

      await expect(drain()).rejects.toThrow(
        /^feed did not finish within its time limit/
      );
      // Returned when abandoned, so the generator stops at its next `yield`
      // rather than running on with nobody reading it.
      const atAbandon = yielded;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(yielded).toBeLessThanOrEqual(atAbandon + 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not advance a stream once its grace has run out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let advanced = 0;
    const tools = boundToolCalls(
      {
        feed: tool({
          description: "Streams whenever asked.",
          inputSchema: z.object({}),
          execute: async function* () {
            for (;;) {
              advanced += 1;
              yield advanced;
            }
          }
        })
      },
      10
    );

    try {
      const stream = (
        call(tools, "feed", AbortSignal.timeout(1)) as AsyncIterable<unknown>
      )[Symbol.asyncIterator]();
      await stream.next();
      // Held between two steps until the grace is long gone, as a slow consumer
      // would hold it.
      await new Promise((resolve) => setTimeout(resolve, 40));
      const before = advanced;

      await expect(stream.next()).rejects.toThrow(
        /^feed did not finish within its time limit/
      );
      // Refused without asking the stream for another step, which would have
      // been work started after the bound.
      expect(advanced).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the abandonment error when the stream's own cleanup throws", async () => {
    const { done, release } = hanging();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A hand-written iterator, not a generator: nothing makes its `return` a
    // promise, so it can throw before there is one to catch.
    const stalling: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => done.then((value) => ({ value, done: false })),
        return: () => {
          throw new Error("cleanup failed");
        }
      })
    };
    const tools = boundToolCalls(
      {
        feed: tool({
          description: "Streams from a custom iterator.",
          inputSchema: z.object({}),
          execute: () => stalling
        })
      },
      10
    );

    try {
      const drain = async () => {
        const stream = call(
          tools,
          "feed",
          AbortSignal.timeout(1)
        ) as AsyncIterable<unknown>;
        for await (const _value of stream) void _value;
      };

      await expect(drain()).rejects.toThrow(
        /^feed did not finish within its time limit/
      );
    } finally {
      warn.mockRestore();
      release();
    }
  });

  it("leaves a tool with no execute untouched", () => {
    const external = tool({
      description: "Answered outside the loop.",
      inputSchema: z.object({})
    });

    expect(boundToolCalls({ external }).external).toBe(external);
  });

  it("lets the loop answer around a tool that never stops", async () => {
    const { done, release } = hanging();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await generateText({
        model: mockModel(
          { toolCall: { toolName: "deaf" } },
          { text: "answered without it" }
        ),
        messages: [{ role: "user", content: "go" }],
        tools: boundToolCalls(
          {
            deaf: tool({
              description: "Never reads its signal.",
              inputSchema: z.object({}),
              execute: () => done
            })
          },
          10
        ),
        stopWhen: isStepCount(2),
        timeout: { toolMs: 10 }
      });

      const errors = result.steps
        .flatMap((step) => step.content)
        .filter((part) => part.type === "tool-error");

      // The same tool, unwrapped, is still holding its loop in
      // `src/round/turn.spec.ts`. Wrapped, the loop gets its step back, and the model
      // reads why rather than a bare `TimeoutError`.
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as { error: unknown }).error)).toContain(
        "deaf did not finish within its time limit"
      );
      expect(result.text).toContain("answered without it");
    } finally {
      warn.mockRestore();
      release();
    }
  });
});
