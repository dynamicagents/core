import { describe, expect, it, vi } from "vitest";
import { ChunkAttempts, SupersededAttemptError } from "./chunk-attempts.js";

/**
 * A retry arriving while the attempt it replaces is still running.
 *
 * The chunk here is a promise the spec settles by hand, standing in for a facet
 * that yields when interrupted — which is what makes the ordering observable.
 */
function chunk() {
  let finish!: (value: string) => void;
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

describe("a chunk retried while an earlier attempt still runs it", () => {
  it("runs at once when nothing else is running", async () => {
    const interrupt = vi.fn(async () => {});
    const attempts = new ChunkAttempts({ interrupt });
    expect(await attempts.run(1, async () => "ran")).toBe("ran");
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("asks the running one to yield, and starts only once it has", async () => {
    const quiet = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const first = chunk();
      const order: string[] = [];
      const attempts = new ChunkAttempts({
        interrupt: async () => {
          order.push("interrupt");
          // A facet yields by ending its chunk early, which is this.
          first.finish("yielded");
        }
      });

      const abandoned = attempts.run(1, () => first.done);
      const retry = attempts.run(1, async () => {
        order.push("retry");
        return "resumed";
      });

      expect(await abandoned).toBe("yielded");
      expect(await retry).toBe("resumed");
      expect(order).toEqual(["interrupt", "retry"]);
    } finally {
      quiet.mockRestore();
    }
  });

  it("keeps separate Subtasks apart", async () => {
    const interrupt = vi.fn(async () => {});
    const attempts = new ChunkAttempts({ interrupt });
    const other = chunk();
    const running = attempts.run(1, () => other.done);
    expect(await attempts.run(2, async () => "ran")).toBe("ran");
    expect(interrupt).not.toHaveBeenCalled();
    other.finish("done");
    await running;
  });

  it("never runs an attempt that was replaced while it waited", async () => {
    const quiet = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const first = chunk();
      let interrupts = 0;
      const attempts = new ChunkAttempts({
        interrupt: async () => {
          interrupts += 1;
        }
      });
      const ran: string[] = [];

      const abandoned = attempts.run(1, () => first.done);
      const waiting = attempts.run(1, async () => {
        ran.push("second");
        return "second";
      });
      const latest = attempts.run(1, async () => {
        ran.push("third");
        return "third";
      });
      // Let both newer attempts deliver their interrupt before the first one
      // yields, which is the ordering that would run two chunks at once.
      await new Promise((resolve) => setTimeout(resolve, 0));
      first.finish("yielded");

      await expect(waiting).rejects.toBeInstanceOf(SupersededAttemptError);
      expect(await latest).toBe("third");
      expect(await abandoned).toBe("yielded");
      expect(ran).toEqual(["third"]);
      expect(interrupts).toBe(2);
    } finally {
      quiet.mockRestore();
    }
  });

  it("still waits for a chunk it could not reach", async () => {
    // Running beside it is the fault; being unable to ask it to hurry is not a
    // reason to do that.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = chunk();
      const order: string[] = [];
      const attempts = new ChunkAttempts({
        interrupt: async () => {
          throw new Error("facet unreachable");
        }
      });
      const abandoned = attempts.run(1, () => first.done);
      const retry = attempts.run(1, async () => {
        order.push("retry");
        return "resumed";
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).toEqual([]);
      first.finish("finished on its own");
      expect(await retry).toBe("resumed");
      await abandoned;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
