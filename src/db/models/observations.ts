import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { roundObservations } from "../schema.js";
import type { DB } from "../db.js";
import type { RoundObservations } from "../../round/observations.js";

type ObservationRow = typeof roundObservations.$inferSelect;

/**
 * Query methods for the `round_observations` table — what each round saw, kept
 * for the rounds after it.
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as
 * `db.observations.*`.
 *
 * ## On not parsing the stored JSON
 *
 * `subtasks` validates its JSON columns with zod, because those hold the
 * decomposition contract: a `SubtaskReference` is a shape this package defines
 * and other code depends on, and a malformed one should fail at the read.
 * `ModelMessage` is not that. It is the AI SDK's own discriminated union over
 * every content part the SDK supports, it grows with the SDK, and a schema for it
 * here would be a second, always-stale copy — one that would reject a row the
 * SDK itself is perfectly happy with the day a new part type ships.
 *
 * So the row is read back as what it is: messages this package wrote, in the
 * shape it wrote them, to hand straight back to the SDK. What guards the read is
 * that the writer is `captureObservations` and nothing else — the rows are never
 * user input, and a round that finds an unreadable one loses context rather than
 * correctness.
 */
export function makeObservations(db: DB) {
  const rowTo = (row: ObservationRow): RoundObservations => ({
    round: row.round,
    messages: JSON.parse(row.messagesJson) as ModelMessage[]
  });

  return {
    /**
     * Record what one round saw, replacing whatever that round recorded before.
     *
     * An upsert because the write is inside a durable step: `turn:<round>` can
     * re-run after a crash, re-infer, and produce a *different* set of calls that
     * is just as valid an account of the same round. The row is that round's
     * current account, not an append-only log of every attempt at it.
     */
    put(taskId: string, round: number, messages: ModelMessage[]): void {
      const messagesJson = JSON.stringify(messages);
      db.insert(roundObservations)
        .values({ taskId, round, messagesJson, createdAt: Date.now() })
        .onConflictDoUpdate({
          target: [roundObservations.taskId, roundObservations.round],
          set: { messagesJson }
        })
        .run();
    },

    /**
     * The most recent `window` rounds of a Task that recorded anything, oldest
     * first.
     *
     * Narrowed here rather than at the render, because this is the only side that
     * can narrow it *cheaply*: the rows the window excludes are never read, never
     * parsed, and never cross the RPC boundary. A window of zero reads nothing at
     * all, which is how an agent opts out entirely.
     */
    recent(
      taskId: string,
      before: number,
      window: number
    ): RoundObservations[] {
      if (window <= 0) return [];
      return db
        .select()
        .from(roundObservations)
        .where(
          and(
            eq(roundObservations.taskId, taskId),
            lt(roundObservations.round, before),
            gte(roundObservations.round, before - window)
          )
        )
        .orderBy(roundObservations.round)
        .all()
        .map(rowTo);
    },

    /** Every round of a Task that recorded anything, newest first. For specs. */
    list(taskId: string): RoundObservations[] {
      return db
        .select()
        .from(roundObservations)
        .where(eq(roundObservations.taskId, taskId))
        .orderBy(desc(roundObservations.round))
        .all()
        .map(rowTo);
    },

    /** Age rows out on the same 30-day clock as the rest of a Task's state. */
    cleanup(): void {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      db.delete(roundObservations)
        .where(lt(roundObservations.createdAt, cutoff))
        .run();
    }
  };
}
