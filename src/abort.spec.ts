import { describe, it, expect, vi } from "vitest";
import { withAbort } from "./abort.js";

/**
 * {@link withAbort} exists for tools whose underlying API takes no signal, which
 * is most of the ones that can actually block — a container exec bounded only by
 * its own `timeoutMs`, a poll loop, an RPC with no signal on any method.
 *
 * The distinction every one of these turns on: stopping the **wait** and stopping
 * the **work** are two separate acts, and only the second releases anything.
 */
describe("withAbort", () => {
  it("returns the work untouched when nothing aborts", async () => {
    const controller = new AbortController();
    await expect(
      withAbort(controller.signal, Promise.resolve("done"))
    ).resolves.toBe("done");
  });

  it("passes a rejection through unchanged", async () => {
    const controller = new AbortController();
    const boom = new Error("the work itself failed");
    await expect(
      withAbort(controller.signal, Promise.reject(boom))
    ).rejects.toBe(boom);
  });

  it("costs nothing when there is no signal", async () => {
    const work = Promise.resolve("done");
    // The same promise, not a wrapper around it: a caller with nothing to cancel
    // from should not pay for a listener and an extra tick on every tool call.
    expect(withAbort(undefined, work)).toBe(work);
  });

  it("stops waiting on abort, rejecting with the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    // Never settles on its own: the point is that the caller stops waiting, not
    // that the work finishes.
    const pending = withAbort(controller.signal, new Promise<string>(() => {}));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("terminates the work before the rejection propagates", async () => {
    const controller = new AbortController();
    const kill = vi.fn();
    const pending = withAbort(
      controller.signal,
      new Promise<string>(() => {}),
      kill
    );

    controller.abort();
    await expect(pending).rejects.toBeDefined();

    // The assertion that matters. Without this the abort leaves a container
    // process running and a handle held — the caller has stopped waiting for
    // work that is still consuming everything it holds.
    expect(kill).toHaveBeenCalledOnce();
  });

  it("terminates without waiting when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const kill = vi.fn();

    await expect(
      withAbort(controller.signal, new Promise<string>(() => {}), kill)
    ).rejects.toBeDefined();
    // A signal that aborted before the call is the common case on a second tool
    // in the same step, and it must not start work it will not wait for.
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not let a failing cleanup mask the abort", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const pending = withAbort(
      controller.signal,
      new Promise<string>(() => {}),
      () => {
        throw new Error("kill failed");
      }
    );

    controller.abort(reason);

    // Cancellation has already been decided by the time cleanup runs; a caller
    // that hears "kill failed" instead of "cancelled" learns the wrong thing and
    // may treat a cancellation as a fault. Same rule the Task cancel path
    // follows: best-effort throughout, never fatal.
    await expect(pending).rejects.toBe(reason);
  });

  it("handles the abandoned work when it fails after the race is lost", async () => {
    const controller = new AbortController();
    let fail: ((err: Error) => void) | undefined;
    const work = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });

    const pending = withAbort(controller.signal, work);
    controller.abort();
    await expect(pending).rejects.toBeDefined();

    // The loser of the race still settles, and a rejection nobody is listening
    // to is reported by workerd as a failure of the whole request — so the
    // abandoned promise is given a handler before it can lose.
    fail?.(new Error("the work failed too, much later"));
    await expect(work.catch(() => "handled")).resolves.toBe("handled");
  });
});
