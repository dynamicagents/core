import type { Tool, ToolSet } from "ai";
import { withAbort } from "../abort.js";
import { TOOL_CALL_GRACE_MS } from "../platform.js";

/**
 * Every tool in `tools`, made to stop holding its loop once its call is over.
 *
 * The AI SDK aborts the signal it hands `execute` — at the call's deadline, or
 * when the loop is cancelled — and then awaits the tool regardless. A tool that
 * never reads that signal holds its round or chunk for as long as its work takes,
 * which is exactly what {@link file://../platform.ts MAX_TOOL_CALL_MS} rules out.
 * Applied where core assembles plugin tools, so no plugin has to thread a signal
 * through every helper to be bounded.
 *
 * Stopping the wait is all this does; the work goes on. A tool whose work must not
 * outlive its call reads its signal and stops that work, and the grace is its
 * window to do so: an answer that arrives inside it is the one the model reads, so
 * the tool can say what it stopped. Past it, the model reads {@link abandoned}.
 *
 * A streaming tool is held to the same bound. The SDK waits on each step of a
 * stream as it would on a promise, so every step is raced against one grace for
 * the whole call — a stream that keeps yielding after its signal fired cannot
 * restart the clock with each value.
 */
export function boundToolCalls(
  tools: ToolSet,
  graceMs = TOOL_CALL_GRACE_MS
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, original]) => {
      const execute = original.execute;
      // A provider-executed tool, or one whose result arrives from outside the
      // loop: nothing here waits on it.
      if (!execute) return [name, original];
      const bounded: Tool = {
        ...original,
        execute: (input, options) =>
          boundCall(name, graceMs, options.abortSignal, () =>
            execute(input, options)
          )
      };
      return [name, bounded];
    })
  );
}

function boundCall(
  name: string,
  graceMs: number,
  signal: AbortSignal | undefined,
  run: () => unknown
): unknown {
  // A loop with no deadline and nothing to cancel from — a host's own
  // `generateText`, or a spec calling `execute` directly.
  if (!signal) return run();
  // Not started. A call cancelled before it began has nothing to stop, and
  // starting it would begin work only to walk away from it.
  if (signal.aborted) return Promise.reject(signal.reason);
  const result = run();
  const late = lateSignal(name, graceMs, signal);
  if (isAsyncIterable(result)) return boundStream(late, result);
  return withAbort(late.signal, Promise.resolve(result)).finally(late.dispose);
}

/**
 * A signal that aborts `graceMs` after `signal` does, carrying the error the model
 * reads. `dispose` stops listening once the call has settled.
 */
function lateSignal(
  name: string,
  graceMs: number,
  signal: AbortSignal
): { signal: AbortSignal; dispose: () => void } {
  const late = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    timer = setTimeout(() => {
      const timedOut =
        (signal.reason as { name?: string } | undefined)?.name ===
        "TimeoutError";
      // The one place a tool that ignores its signal shows up: whatever it was
      // doing goes on with nobody waiting for it.
      console.warn("[tools] abandoned a call that did not stop at its signal", {
        tool: name,
        reason: timedOut ? "time limit" : "cancelled"
      });
      late.abort(abandoned(name, timedOut));
    }, graceMs);
  };
  // Checked as well as listened for: an abort that landed while the tool was
  // starting has already fired its event, and it does not fire twice.
  if (signal.aborted) expire();
  else signal.addEventListener("abort", expire, { once: true });
  return {
    signal: late.signal,
    dispose: () => {
      signal.removeEventListener("abort", expire);
      clearTimeout(timer);
    }
  };
}

/**
 * The tool's stream, with every step raced against `late`.
 *
 * An abandoned stream has its iterator returned as well, so a generator that is
 * slow rather than stuck stops at its next `yield` instead of running on.
 */
async function* boundStream(
  late: { signal: AbortSignal; dispose: () => void },
  stream: AsyncIterable<unknown>
): AsyncGenerator<unknown> {
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      // Before advancing, and not only while waiting: a consumer can hold this
      // generator at its `yield` past the grace, and asking the stream for its
      // next step then would restart its work after the bound.
      late.signal.throwIfAborted();
      const step = await withAbort(
        late.signal,
        Promise.resolve(iterator.next())
      );
      if (step.done) {
        finished = true;
        return;
      }
      yield step.value;
    }
  } finally {
    late.dispose();
    // Not awaited: returning an iterator that is mid-step waits for that step,
    // and waiting on it is what this exists to stop doing. Called from inside a
    // promise, so a `return` that throws outright is as best-effort as one that
    // rejects, and neither replaces the error that ended the stream.
    if (!finished)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => {});
  }
}

/**
 * What the model reads in place of a call abandoned at its deadline.
 *
 * True of any tool, because this cannot know which one it speaks for: not that
 * the work stopped, only that nothing is waiting for it and that whatever it did
 * may already have happened. Worded so the next move is to look rather than to
 * call again, since a call that outran its limit once will again. It names no
 * figure, because the deadline is whatever the loop set and this never sees it.
 *
 * A cancelled call gets a bare statement: the loop that made it is ending, so no
 * model reads it.
 */
function abandoned(name: string, timedOut: boolean): Error {
  return new Error(
    timedOut
      ? `${name} did not finish within its time limit, so this call was abandoned. It may still be running, and anything it did may already have taken effect — check before repeating it.`
      : `${name} was abandoned because this call was cancelled.`
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}
