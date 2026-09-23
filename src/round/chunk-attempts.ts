import type { SubtaskId } from "../subtasks/types.js";

/** Thrown to an attempt that was itself replaced while it waited its turn. */
export class SupersededAttemptError extends Error {
  constructor(id: SubtaskId) {
    super(`subtask ${id}: a newer attempt of this chunk took over`);
    this.name = "SupersededAttemptError";
  }
}

/**
 * The chunk each Subtask is running on this instance, so a retry takes over from
 * an attempt the Workflow gave up on instead of running beside it.
 *
 * **A step attempt can fail while the call it made keeps running.** The engine
 * records `WorkflowInternalError` against the attempt and schedules the retry,
 * and nothing cancels the RPC the attempt was waiting on. Two chunks of one
 * Subtask at once is never correct: both resume from one checkpoint and write it
 * in turn, and a facet whose chunk holds something exclusive — a session's event
 * stream admits one subscriber — refuses the retry outright, every retry, until
 * the step has none left and a healthy run is failed.
 *
 * So the newest attempt wins. It asks the facet to yield the chunk in flight,
 * waits for that call to unwind, and runs from wherever it checkpointed. An
 * attempt replaced while it was still waiting never runs at all.
 *
 * In memory, because what it tracks is a call on this isolate: an attempt that
 * outlived its isolate died with it and holds nothing.
 *
 * **The wait has no bound of its own.** The step's timeout is the ceiling, and a
 * predecessor still unwinding is normally finishing work the retry needs — a
 * session's last filesystem sync is read to the end before a chunk returns.
 */
export class ChunkAttempts {
  readonly #latest = new Map<SubtaskId, Promise<unknown>>();

  constructor(
    private readonly deps: {
      /** Ask the Subtask's facet to yield the chunk it is running. */
      interrupt: (id: SubtaskId) => Promise<void>;
    }
  ) {}

  async run<T>(id: SubtaskId, work: () => Promise<T>): Promise<T> {
    const previous = this.#latest.get(id);
    // Nothing to wait for starts now: deferring it would let a call arriving in
    // the same tick replace an attempt that was never waiting.
    const attempt: Promise<T> = previous
      ? this.#after(id, previous).then(() => {
          if (this.#latest.get(id) !== attempt) {
            throw new SupersededAttemptError(id);
          }
          return work();
        })
      : work();
    this.#latest.set(id, attempt);
    try {
      return await attempt;
    } finally {
      if (this.#latest.get(id) === attempt) this.#latest.delete(id);
    }
  }

  /** Interrupt the attempt before this one, and outwait it. */
  async #after(id: SubtaskId, previous: Promise<unknown>): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.deps.interrupt(id);
    } catch (err) {
      // Still waited on below: an attempt that could not be told to yield ends
      // its chunk on its own clock, and running beside it is the fault this
      // exists to prevent.
      console.warn("[agent] could not ask a superseded chunk to yield", {
        subtaskId: id,
        err: String(err)
      });
    }
    // Its outcome is its own caller's. The Workflow has stopped listening, so
    // all that matters here is that it is over.
    await previous.catch(() => {});
    // The line an operator looks for when a chunk was retried: that the retry
    // found its predecessor still running, and what taking over cost.
    console.info("[agent] a retry took over from a chunk still running", {
      subtaskId: id,
      ms: Date.now() - startedAt
    });
  }
}
