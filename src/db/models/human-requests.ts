import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { HitlRequestData } from "@dynamicagents/g2a-protocol";
import type { HumanAnswer } from "../../a2a/hitl.js";
import { humanRequests } from "../schema.js";
import type { DB } from "../db.js";

/**
 * Query methods for the `human_requests` table — the questions a Task's rounds
 * asked the person it is for, and what became of each one.
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as
 * `db.humanRequests.*`. Every way out of `awaiting` is one guarded
 * `UPDATE … WHERE status = 'awaiting'`, so an answer, an expiry and a cancel
 * racing for the same question cannot all apply: the first write stands, and the
 * others read what it left.
 */

export type HumanRequestStatus =
  "awaiting" | "answered" | "unanswered" | "canceled";

export interface HumanRequest {
  requestId: string;
  taskId: string;
  round: number;
  /** Exactly what the person is shown. */
  request: HitlRequestData;
  status: HumanRequestStatus;
  answer: HumanAnswer | null;
  /** When the question was posted; `null` until it has been. */
  parkedAt: number | null;
  /** When an answer or an expiry closed it. */
  closedAt: number | null;
}

/**
 * What recording an answer did.
 *
 * - `answered` — this message answered the question.
 * - `repeated` — this same message had answered it already: a retry.
 * - `closed` — something else closed it first: another answer, an expiry, or
 *   the Task being canceled.
 * - `unknown` — there is no such question.
 */
export type AnswerVerdict = "answered" | "repeated" | "closed" | "unknown";

type HumanRequestRow = typeof humanRequests.$inferSelect;

export function makeHumanRequests(db: DB) {
  const rowTo = (row: HumanRequestRow): HumanRequest => ({
    requestId: row.requestId,
    taskId: row.taskId,
    round: row.round,
    request: JSON.parse(row.requestJson) as HitlRequestData,
    status: row.status as HumanRequestStatus,
    answer: row.answerJson ? (JSON.parse(row.answerJson) as HumanAnswer) : null,
    parkedAt: row.parkedAt,
    closedAt: row.closedAt
  });

  const readRow = (requestId: string): HumanRequestRow | undefined =>
    db
      .select()
      .from(humanRequests)
      .where(eq(humanRequests.requestId, requestId))
      .get();

  const get = (requestId: string): HumanRequest | null => {
    const row = readRow(requestId);
    return row ? rowTo(row) : null;
  };

  /** Guarded `awaiting → status`, stamping when it closed. */
  const close = (
    where: ReturnType<typeof eq>,
    status: HumanRequestStatus,
    at: number
  ): number =>
    db
      .update(humanRequests)
      .set({ status, closedAt: at })
      .where(and(where, eq(humanRequests.status, "awaiting")))
      .returning({ id: humanRequests.requestId })
      .all().length;

  return {
    /**
     * Record the question a round decided to ask, and return what is stored.
     *
     * Idempotent on the request id, and the **first** question stands. A round's
     * step can re-run after a crash and re-infer a question worded differently;
     * the first may already be in front of the person, and they must not be
     * answering a question the agent has since replaced.
     */
    open(input: {
      requestId: string;
      taskId: string;
      round: number;
      request: HitlRequestData;
    }): HumanRequest {
      db.insert(humanRequests)
        .values({
          requestId: input.requestId,
          taskId: input.taskId,
          round: input.round,
          requestJson: JSON.stringify(input.request),
          status: "awaiting",
          createdAt: Date.now()
        })
        .onConflictDoNothing()
        .run();
      return get(input.requestId) as HumanRequest;
    },

    get,

    /** The question a round asked, if it asked one. */
    forRound(taskId: string, round: number): HumanRequest | null {
      const row = db
        .select()
        .from(humanRequests)
        .where(
          and(eq(humanRequests.taskId, taskId), eq(humanRequests.round, round))
        )
        .get();
      return row ? rowTo(row) : null;
    },

    /** The last question a Task asked, whatever became of it. */
    latest(taskId: string): HumanRequest | null {
      const row = db
        .select()
        .from(humanRequests)
        .where(eq(humanRequests.taskId, taskId))
        .orderBy(desc(humanRequests.round))
        .limit(1)
        .get();
      return row ? rowTo(row) : null;
    },

    /**
     * Stamp the moment the question was posted, and return the stamp that
     * stands. The first one does: a retried post is the same question, and its
     * wait began the first time.
     */
    markParked(requestId: string, at: number): number | null {
      db.update(humanRequests)
        .set({ parkedAt: at })
        .where(
          and(
            eq(humanRequests.requestId, requestId),
            isNull(humanRequests.parkedAt)
          )
        )
        .run();
      return readRow(requestId)?.parkedAt ?? null;
    },

    /** Record an answer, once. See {@link AnswerVerdict} for what comes back. */
    answer(
      requestId: string,
      input: { answer: HumanAnswer; messageId: string; at: number }
    ): AnswerVerdict {
      const updated = db
        .update(humanRequests)
        .set({
          status: "answered",
          answerJson: JSON.stringify(input.answer),
          answerMessageId: input.messageId,
          closedAt: input.at
        })
        .where(
          and(
            eq(humanRequests.requestId, requestId),
            eq(humanRequests.status, "awaiting")
          )
        )
        .returning({ id: humanRequests.requestId })
        .all();
      if (updated.length > 0) return "answered";
      const row = readRow(requestId);
      if (!row) return "unknown";
      return row.answerMessageId === input.messageId ? "repeated" : "closed";
    },

    /** Close a question nobody answered in time. `false` if already closed. */
    expire(requestId: string, at: number): boolean {
      return (
        close(eq(humanRequests.requestId, requestId), "unanswered", at) > 0
      );
    },

    /** Close every open question of a canceled Task, returning how many. */
    cancelForTask(taskId: string, at: number): number {
      return close(eq(humanRequests.taskId, taskId), "canceled", at);
    },

    /** Age rows out on the same 30-day clock as the rest of a Task's state. */
    cleanup(): void {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      db.delete(humanRequests).where(lt(humanRequests.createdAt, cutoff)).run();
    }
  };
}
