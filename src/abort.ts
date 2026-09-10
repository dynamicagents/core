/**
 * Cancellation for work whose own API has no `AbortSignal`.
 *
 * Core already stops *waiting* on a plugin tool whose call is over — see
 * {@link file://./platform.ts MAX_TOOL_CALL_MS}. Stopping the *work* is the tool's
 * job, and a tool backed by an API that takes a signal does it by passing the
 * signal straight through. This is for the other case: a container exec bounded
 * only by its own `timeoutMs`, a poll loop, an RPC with no signal on any method.
 * There the caller can stop waiting, and separately ask the remote side to stop,
 * and those are two different things.
 */

/**
 * Stop waiting on `work` when `signal` aborts, rejecting with the signal's
 * reason.
 *
 * **`work` keeps running.** Nothing here can stop a promise that is already in
 * flight; that is the whole reason this helper exists rather than a signal being
 * threaded through. `onAbort` is where the work is actually terminated — a
 * `kill("SIGTERM")` on an exec handle, a `close` on a session — and without one,
 * an abort leaves the work orphaned and still consuming whatever it holds.
 *
 * `onAbort` is awaited before the rejection propagates, so a caller can be sure
 * the terminate was *sent* and not merely scheduled. It must therefore not block
 * indefinitely, or it delays the very cancellation it is serving. Its failures
 * are logged and swallowed: cleanup that could not run must not mask the abort,
 * which is the same rule the Task cancellation path follows.
 *
 * A missing `signal` returns `work` unchanged, so a caller with nothing to cancel
 * from pays nothing.
 */
export function withAbort<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
  onAbort?: () => void | Promise<void>
): Promise<T> {
  // Not `async`, so this returns the caller's own promise rather than a wrapper
  // around it. A tool with nothing to cancel from should pay nothing — no
  // listener, no extra microtask — on every call it makes.
  return signal ? raceAbort(signal, work, onAbort) : work;
}

async function raceAbort<T>(
  signal: AbortSignal,
  work: Promise<T>,
  onAbort?: () => void | Promise<void>
): Promise<T> {
  // The abandoned promise still settles. If it rejects with nobody listening,
  // workerd reports the unhandled rejection as a failure of the whole request —
  // so the loser of the race is given a handler up front, before it can lose.
  work.catch(() => {});

  if (signal.aborted) {
    await terminate(onAbort);
    throw signal.reason;
  }

  let listener: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      // Whichever side fires first wins, latched the moment it fires rather than
      // when it settles. The abort side awaits its cleanup before rejecting, and
      // work that finishes in that gap — often *because* of the kill — would
      // otherwise resolve a call its caller has already cancelled. The latch also
      // keeps a late abort from running cleanup for work that has already won.
      let decided = false;
      listener = () => {
        if (decided) return;
        decided = true;
        // Cleanup's own failure is not allowed to become the caller's error: the
        // caller asked to stop, and that is what it hears either way.
        void terminate(onAbort).then(() => reject(signal.reason));
      };
      signal.addEventListener("abort", listener, { once: true });
      work.then(
        (value) => {
          if (decided) return;
          decided = true;
          resolve(value);
        },
        (err: unknown) => {
          if (decided) return;
          decided = true;
          reject(err);
        }
      );
    });
  } finally {
    // `once` removes it on an abort, but the ordinary path never fires and would
    // otherwise hold the callback — and with it the promise's scope — for as long
    // as the signal lives, which for a round is every tool call in it.
    if (listener) signal.removeEventListener("abort", listener);
  }
}

async function terminate(onAbort?: () => void | Promise<void>): Promise<void> {
  if (!onAbort) return;
  try {
    await onAbort();
  } catch (err) {
    console.warn("[abort] cleanup failed", { err: String(err) });
  }
}
