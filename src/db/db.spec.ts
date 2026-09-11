import { describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { AgentDB, PLUGIN_MIGRATIONS_TABLE } from "./db.js";
import { makeDoHelpers, doStorage } from "../testing/do.js";
import { buildCompletedTask, buildFailedTask } from "../a2a/notify.js";
import { buildInputRequiredTask } from "../a2a/hitl.js";
import type { PluginStore } from "./db.js";
import type { TaskListQuery } from "./models/tasks.js";
import type { SubtaskDraft } from "../subtasks/types.js";
import type { ModelMessage } from "ai";

/**
 * The durable layer, exercised inside a real Durable Object.
 *
 * These cannot be faked: `AgentDB` runs Drizzle's `durable-sqlite` migrator
 * against `ctx.storage.sql`, and the guarded status transitions the subtask model
 * relies on are SQLite `UPDATE … WHERE status = ?` semantics. So each test gets
 * its own freshly-migrated DO — that is what `makeDoHelpers` is for, and it is
 * shipped rather than regrown because both predecessors grew one.
 */

const ns = (env as unknown as { TEST_AGENT: DurableObjectNamespace })
  .TEST_AGENT;
const { withDb, freshStub } = makeDoHelpers(ns);

/** `ListTasks` paging fields are required; these specs only vary the filters. */
const page = (over: Partial<TaskListQuery> = {}): TaskListQuery => ({
  includeArtifacts: false,
  limit: 50,
  offset: 0,
  ...over
});

const draft = (name: string, over: Partial<SubtaskDraft> = {}) =>
  ({
    type: "generic",
    prompt: `do ${name}`,
    references: [],
    params: {},
    ...over
  }) satisfies SubtaskDraft;

describe("migrations", () => {
  it("brings core's tables up in a fresh Durable Object", async () => {
    const found = await withDb("migrate", async (db) => {
      await db.ensureReady();
      // Reachable and empty is the whole claim: the migrator ran.
      return {
        task: db.tasks.get("nothing-here"),
        subtasks: db.subtasks.list("nothing-here")
      };
    });

    expect(found.task).toBeNull();
    expect(found.subtasks).toEqual([]);
  });

  it("is idempotent across the fresh AgentDB every hibernation wake-up builds", async () => {
    const stub = freshStub("rehydrate");

    const rows = await runInDurableObject(stub, async (instance) => {
      const storage = doStorage(instance);
      const first = new AgentDB(storage, { maxSubtasks: 8 });
      await first.ensureReady();
      first.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c1" });

      // What a wake-up does: construct again over the same storage.
      const second = new AgentDB(storage, { maxSubtasks: 8 });
      await second.ensureReady();
      return second.tasks.get("t1");
    });

    expect(rows?.id).toBe("t1");
  });
});

describe("tasks", () => {
  it("is idempotent on the gatekeeper's messageId, not the task id", async () => {
    // The dedupe key is stable across dispatch retries; accepting a turn twice
    // must return the same task rather than minting a second one.
    const { first, second, listed } = await withDb("dedupe", async (db) => {
      await db.ensureReady();
      const first = db.tasks.begin({
        messageId: "msg-1",
        taskId: "task-a",
        contextId: "ctx-1"
      });
      const second = db.tasks.begin({
        messageId: "msg-1",
        taskId: "task-b",
        contextId: "ctx-1"
      });
      return {
        first,
        second,
        listed: db.tasks.list(page({ contextId: "ctx-1" }))
      };
    });

    expect(second.id).toBe(first.id);
    expect(second.id).toBe("task-a");
    expect(listed.totalSize).toBe(1);
  });

  it("filters a listing by context and reports the total for paging", async () => {
    const listed = await withDb("list", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "ctx-a" });
      db.tasks.begin({ messageId: "m2", taskId: "t2", contextId: "ctx-a" });
      db.tasks.begin({ messageId: "m3", taskId: "t3", contextId: "ctx-b" });
      return {
        a: db.tasks.list(page({ contextId: "ctx-a" })),
        b: db.tasks.list(page({ contextId: "ctx-b" })),
        all: db.tasks.list(page())
      };
    });

    expect(listed.a.totalSize).toBe(2);
    expect(listed.b.totalSize).toBe(1);
    expect(listed.all.totalSize).toBe(3);
  });

  it("guards the working transition and refuses it once canceled", async () => {
    const result = await withDb("cancel", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      const beforeCancel = db.tasks.markWorking("t1");
      db.tasks.cancel("t1");
      return { beforeCancel, afterCancel: db.tasks.markWorking("t1") };
    });

    expect(result.beforeCancel).toBe("ok");
    expect(result.afterCancel).toBe("canceled");
  });

  it("refuses to cancel a task that already completed", async () => {
    // `complete` and `notify` are separate Workflow steps: a cancel landing
    // between them must not flip an already-completed row to canceled, or
    // `deliver()` posts its cached completed Task right after storage silently
    // disagreed with it.
    const result = await withDb("cancel-terminal", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      const completed = buildCompletedTask("t1", "c", "the answer");
      const saved = db.tasks.save(completed);
      const canceled = db.tasks.cancel("t1");
      return { saved, canceled, task: db.tasks.get("t1") };
    });

    expect(result.saved).toBe(true);
    expect(result.canceled).toBeNull();
    expect(result.task?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("refuses to save a canceled task over one that already completed", async () => {
    const result = await withDb("save-canceled-over-completed", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      db.tasks.save(buildCompletedTask("t1", "c", "the answer"));
      const canceledTask = { ...db.tasks.get("t1")! };
      canceledTask.status = {
        ...canceledTask.status,
        state: TaskState.TASK_STATE_CANCELED
      };
      const applied = db.tasks.save(canceledTask);
      return { applied, task: db.tasks.get("t1") };
    });

    expect(result.applied).toBe(false);
    expect(result.task?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  /**
   * The hole the cancellation guards left open. A workflow whose `notify` step
   * exhausts its retries throws *after* `complete` durably saved a completed
   * Task; an abandoned-task recovery above it then tries to write a generic
   * failure. Both rules above are about cancellation, so neither refused this —
   * a turn that succeeded would be stored, and called back, as failed because a
   * webhook was flaky.
   */
  it("refuses to save a failed task over one that already completed", async () => {
    const result = await withDb("save-failed-over-completed", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      db.tasks.save(buildCompletedTask("t1", "c", "the answer"));
      const failed = buildFailedTask("t1", "c", "generic failure copy");
      const applied = db.tasks.save(failed);
      return { applied, task: db.tasks.get("t1") };
    });

    expect(result.applied).toBe(false);
    expect(result.task?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // The answer is still there, not replaced by the failure's copy.
    expect(JSON.stringify(result.task)).toContain("the answer");
  });

  /**
   * The other direction, for the same reason — and the pair is why the rule is
   * "a *different* terminal state" rather than "any write over a terminal row".
   */
  it("refuses to save a completed task over one that already failed", async () => {
    const result = await withDb("save-completed-over-failed", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      db.tasks.save(buildFailedTask("t1", "c", "it broke"));
      const applied = db.tasks.save(
        buildCompletedTask("t1", "c", "the answer")
      );
      return { applied, task: db.tasks.get("t1") };
    });

    expect(result.applied).toBe(false);
    expect(result.task?.status.state).toBe(TaskState.TASK_STATE_FAILED);
  });

  /**
   * Must stay allowed. A Workflow replay legitimately re-runs `complete` and
   * saves what it already saved; refusing that would return `false` and suppress
   * the callback the replay exists to send.
   */
  it("allows a terminal task to be re-saved in the same state", async () => {
    const result = await withDb("resave-same-terminal", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      db.tasks.save(buildCompletedTask("t1", "c", "the answer"));
      const applied = db.tasks.save(
        buildCompletedTask("t1", "c", "the answer")
      );
      return { applied, task: db.tasks.get("t1") };
    });

    expect(result.applied).toBe(true);
    expect(result.task?.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it("round-trips a task through the SDK's own JSON form", async () => {
    // `task_json` holds `Task.toJSON` output so what is on disk is exactly what
    // goes on the wire, and both survive SDK class-shape changes.
    const task = await withDb("roundtrip", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "ctx-9" });
      return db.tasks.get("t1");
    });

    expect(task?.id).toBe("t1");
    expect(task?.contextId).toBe("ctx-9");
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  });
});

describe("subtasks", () => {
  it("enforces the durable fan-out guard the model schema also advertises", async () => {
    await withDb("fanout", async (db) => {
      await db.ensureReady();
      const tooMany = Array.from({ length: 9 }, (_, i) => draft(`k${i}`));

      expect(() => db.subtasks.createDecomposition("t1", 1, tooMany)).toThrow(
        /1\.\.8 subtasks/
      );
      expect(() => db.subtasks.createDecomposition("t1", 1, [])).toThrow(
        /1\.\.8 subtasks/
      );
    });
  });

  it("is idempotent per round, so a retried decomposition does not double-fan", async () => {
    const { first, again } = await withDb("idempotent-round", async (db) => {
      await db.ensureReady();
      const first = db.subtasks.createDecomposition("t1", 1, [
        draft("a"),
        draft("b")
      ]);
      const again = db.subtasks.createDecomposition("t1", 1, [draft("c")]);
      return { first, again };
    });

    expect(first).toHaveLength(2);
    expect(again.map((s) => s.id)).toEqual(first.map((s) => s.id));
  });

  it("continues ordinals across rounds, so a later round sorts after an earlier one", async () => {
    // Ordinal is the Task-wide position and the unique index is built on it, so
    // a second round must start above every row the first one wrote.
    const rows = await withDb("ordinals-across-rounds", async (db) => {
      await db.ensureReady();
      db.subtasks.createDecomposition("t1", 0, [draft("a"), draft("b")]);
      db.subtasks.createDecomposition("t1", 1, [draft("c")]);
      return db.subtasks.list("t1");
    });

    expect(rows.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.prompt)).toEqual(["do a", "do b", "do c"]);
  });

  it("guards each status transition so a late loser cannot overwrite a result", async () => {
    const outcome = await withDb("transitions", async (db) => {
      await db.ensureReady();
      const [row] = db.subtasks.createDecomposition("t1", 1, [draft("only")]);

      const started = db.subtasks.start(row.id, {
        recipeId: "r",
        recipeVersion: 1
      });
      const startedTwice = db.subtasks.start(row.id, {
        recipeId: "r",
        recipeVersion: 1
      });
      const completed = db.subtasks.complete(row.id, [
        { kind: "text", text: "done" }
      ]);
      // The Workflow's last-resort failSubtask arriving after the real result.
      const failedLate = db.subtasks.fail(row.id, "too late");

      return {
        started,
        startedTwice,
        completed,
        failedLate,
        final: db.subtasks.get(row.id)
      };
    });

    expect(outcome.started).toBe(true);
    expect(outcome.startedTwice).toBe(false);
    expect(outcome.completed).toBe(true);
    expect(outcome.failedLate).toBe(false);
    expect(outcome.final?.status).toBe("completed");
  });

  /**
   * `completedAt` is what says a row stopped, and every terminal write owes one.
   * `cancelPending` is the only one that cannot go through the shared
   * `transition` helper — it is keyed on the Task, not an id — so it is the only
   * one that can drift, and a canceled row without a `completedAt` reads as
   * still in flight to anything measuring duration.
   */
  it("stamps completedAt on every terminal transition, bulk cancellation included", async () => {
    const outcome = await withDb("completed-at", async (db) => {
      await db.ensureReady();
      // The fourth row is deliberately not destructured: it is never started,
      // so it is the one the bulk sweep below has to reach.
      const [done, failed, canceledRunning] = db.subtasks.createDecomposition(
        "t1",
        1,
        [
          draft("done"),
          draft("failed"),
          draft("canceled-running"),
          draft("canceled-pending")
        ]
      );
      const recipe = { recipeId: "r", recipeVersion: 1 };

      db.subtasks.start(done.id, recipe);
      db.subtasks.complete(done.id, [{ kind: "text", text: "ok" }]);

      db.subtasks.start(failed.id, recipe);
      db.subtasks.fail(failed.id, "boom");

      db.subtasks.start(canceledRunning.id, recipe);
      db.subtasks.cancelRunning(canceledRunning.id);

      const swept = db.subtasks.cancelPending("t1");

      return { swept, rows: db.subtasks.list("t1") };
    });

    expect(outcome.swept).toBe(1);
    expect(outcome.rows.map((r) => r.status)).toEqual([
      "completed",
      "failed",
      "canceled",
      "canceled"
    ]);
    for (const row of outcome.rows) {
      expect(
        row.completedAt,
        `${row.status} row is missing completedAt`
      ).toEqual(expect.any(Number));
    }
  });

  it("refuses to record a completed subtask with no usable output", async () => {
    await withDb("empty-result", async (db) => {
      await db.ensureReady();
      const [row] = db.subtasks.createDecomposition("t1", 1, [draft("only")]);
      db.subtasks.start(row.id, { recipeId: "r", recipeVersion: 1 });

      expect(() =>
        db.subtasks.complete(row.id, [{ kind: "text", text: "   " }])
      ).toThrow(/non-empty text part/);
    });
  });
});

/**
 * What each round saw, kept for the rounds after it.
 *
 * The read is where the round window is applied, and the write is an upsert
 * because `turn:<round>` is a durable step that can re-run. Both are properties
 * of SQLite semantics rather than of the model layer, so they are exercised in a
 * real Durable Object like everything else here.
 */
describe("round observations", () => {
  const said = (text: string): ModelMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "obs_r0_0",
          toolName: "sb_ls",
          input: {}
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "obs_r0_0",
          toolName: "sb_ls",
          output: { type: "text", value: text }
        }
      ]
    }
  ];

  const firstOutput = (round: { messages: ModelMessage[] }): string => {
    const message = round.messages[1];
    if (message.role !== "tool") return "";
    const part = message.content[0];
    return part.type === "tool-result" && part.output.type === "text"
      ? part.output.value
      : "";
  };

  it("round-trips a round's exchanges", async () => {
    const found = await withDb("obs-roundtrip", (db) => {
      db.observations.put("t1", 0, said("reused the existing checkout"));
      return db.observations.list("t1");
    });

    expect(found).toHaveLength(1);
    expect(found[0].round).toBe(0);
    expect(firstOutput(found[0])).toBe("reused the existing checkout");
  });

  /**
   * The round is a durable step, so it can re-run after a crash, re-infer, and
   * produce a different but equally valid account of the same round. The row is
   * that round's current account — not a log of every attempt at it, which would
   * show a later round the same round twice.
   */
  it("replaces a round's row rather than appending a second", async () => {
    const found = await withDb("obs-upsert", (db) => {
      db.observations.put("t1", 0, said("first attempt"));
      db.observations.put("t1", 0, said("the retry"));
      return db.observations.list("t1");
    });

    expect(found).toHaveLength(1);
    expect(firstOutput(found[0])).toBe("the retry");
  });

  it("reads back only the window's rounds, oldest first", async () => {
    const found = await withDb("obs-window", (db) => {
      for (const round of [0, 1, 2, 3]) {
        db.observations.put("t1", round, said(`round ${round}`));
      }
      return db.observations.recent("t1", 4, 2);
    });

    expect(found.map((r) => r.round)).toEqual([2, 3]);
  });

  /** The round asking is not one of the rounds it reads. */
  it("never reads the round doing the asking, or any after it", async () => {
    const found = await withDb("obs-before", (db) => {
      for (const round of [0, 1, 2]) {
        db.observations.put("t1", round, said(`round ${round}`));
      }
      return db.observations.recent("t1", 1, 99);
    });

    expect(found.map((r) => r.round)).toEqual([0]);
  });

  /** Zero is the opt-out, and it costs no query at all. */
  it("reads nothing at a window of zero", async () => {
    const found = await withDb("obs-zero", (db) => {
      db.observations.put("t1", 0, said("something"));
      return db.observations.recent("t1", 1, 0);
    });

    expect(found).toEqual([]);
  });

  it("keeps one task's rounds out of another's", async () => {
    const found = await withDb("obs-scope", (db) => {
      db.observations.put("t1", 0, said("mine"));
      db.observations.put("t2", 0, said("theirs"));
      return db.observations.recent("t1", 1, 4);
    });

    expect(found).toHaveLength(1);
    expect(firstOutput(found[0])).toBe("mine");
  });
});

describe("plugin stores", () => {
  const makeStore = (version: number, calls: number[]): PluginStore => ({
    plugin: "demo",
    version,
    ensureTables(sql, from) {
      calls.push(from);
      sql.exec(
        "CREATE TABLE IF NOT EXISTS demo_rows (id INTEGER PRIMARY KEY, note TEXT)"
      );
      if (from < 2)
        sql.exec("CREATE INDEX IF NOT EXISTS demo_note ON demo_rows (note)");
    }
  });

  it("runs a store's DDL and records its version outside core's journal", async () => {
    const calls: number[] = [];
    const version = await withDbStores(
      "store-v1",
      [makeStore(1, calls)],
      (sql) =>
        sql
          .exec<{ version: number }>(
            `SELECT version FROM ${PLUGIN_MIGRATIONS_TABLE} WHERE plugin = 'demo'`
          )
          .toArray()[0]?.version
    );

    // `from` is 0 on the first ever run, which is what lets an upgrade branch.
    expect(calls).toEqual([0]);
    expect(version).toBe(1);
  });

  it("refuses a downgrade rather than silently running older DDL", async () => {
    const stub = freshStub("downgrade");

    await expect(
      runInDurableObject(stub, async (instance) => {
        const storage = doStorage(instance);
        const up = new AgentDB(storage, {
          maxSubtasks: 8,
          stores: [makeStore(2, [])]
        });
        await up.ensureReady();

        const down = new AgentDB(storage, {
          maxSubtasks: 8,
          stores: [makeStore(1, [])]
        });
        await down.ensureReady();
      })
    ).rejects.toThrow(/downgrade is not supported/);
  });

  it("refuses two plugins claiming one storage namespace", async () => {
    const stub = freshStub("dup-store");

    await expect(
      runInDurableObject(stub, async (instance) => {
        const db = new AgentDB(doStorage(instance), {
          maxSubtasks: 8,
          stores: [makeStore(1, []), makeStore(1, [])]
        });
        await db.ensureReady();
      })
    ).rejects.toThrow(/duplicate PluginStore 'demo'/);
  });

  it("refuses a non-integer or zero version", async () => {
    const stub = freshStub("bad-version");

    await expect(
      runInDurableObject(stub, async (instance) => {
        const db = new AgentDB(doStorage(instance), {
          maxSubtasks: 8,
          stores: [{ plugin: "x", version: 0, ensureTables: () => {} }]
        });
        await db.ensureReady();
      })
    ).rejects.toThrow(/must be an integer >= 1/);
  });
});

/** Run `fn` against the raw SQL handle of a DO whose AgentDB carries `stores`. */
async function withDbStores<T>(
  label: string,
  stores: readonly PluginStore[],
  fn: (sql: SqlStorage) => T
): Promise<T> {
  return runInDurableObject(freshStub(label), async (instance) => {
    const storage = doStorage(instance);
    const db = new AgentDB(storage, { maxSubtasks: 8, stores });
    await db.ensureReady();
    return fn(storage.sql);
  });
}

describe("a task parked on a question", () => {
  const question: HitlRequestData = {
    type: HITL_REQUEST_TYPE,
    requestId: "task_t1_round_0_ask",
    requestKind: "choice",
    prompt: "Which one?",
    allowFreeform: true
  };

  it("parks a working task, and resumes it once", async () => {
    const result = await withDb("park-resume", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      db.tasks.markWorking("t1");
      const parked = db.tasks.park(buildInputRequiredTask("t1", "c", question));
      const waiting = db.tasks.get("t1")?.status.state;
      const resumed = db.tasks.resume("t1");
      const again = db.tasks.resume("t1");
      return { parked, waiting, resumed, again, now: db.tasks.get("t1") };
    });

    expect(result.parked).toBe(true);
    expect(result.waiting).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(result.resumed?.status.state).toBe(TaskState.TASK_STATE_WORKING);
    // A retried answer finds it resumed already, and resumes nothing.
    expect(result.again).toBeNull();
    // The question leaves with the state; it was already shown.
    expect(result.now?.status.message).toBeUndefined();
  });

  it("parks only a task that is working", async () => {
    const result = await withDb("park-guard", async (db) => {
      await db.ensureReady();
      const park = (taskId: string) =>
        db.tasks.park(buildInputRequiredTask(taskId, "c", question));
      db.tasks.begin({ messageId: "m1", taskId: "submitted", contextId: "c" });
      db.tasks.begin({ messageId: "m2", taskId: "canceled", contextId: "c" });
      db.tasks.cancel("canceled");
      db.tasks.begin({ messageId: "m3", taskId: "done", contextId: "c" });
      db.tasks.save(buildCompletedTask("done", "c", "the answer"));
      return {
        submitted: park("submitted"),
        canceled: park("canceled"),
        done: park("done"),
        unknown: park("nobody")
      };
    });

    // Nobody is left to take an answer on a finished task, and a submitted one
    // has run no round that could have asked.
    expect(result).toEqual({
      submitted: false,
      canceled: false,
      done: false,
      unknown: false
    });
  });

  it("lets a cancel reach a task waiting on its question", async () => {
    const result = await withDb("park-cancel", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c" });
      db.tasks.markWorking("t1");
      db.tasks.park(buildInputRequiredTask("t1", "c", question));
      return {
        canceled: db.tasks.cancel("t1"),
        working: db.tasks.markWorking("t1")
      };
    });

    // A waiting task is still running, as far as its person is concerned, and
    // stopping it is what a cancel is for.
    expect(result.canceled?.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(result.working).toBe("canceled");
  });

  it("names the message a task was accepted on", async () => {
    const result = await withDb("message-id-of", async (db) => {
      await db.ensureReady();
      db.tasks.begin({ messageId: "m-original", taskId: "t1", contextId: "c" });
      return {
        known: db.tasks.messageIdOf("t1"),
        unknown: db.tasks.messageIdOf("nobody")
      };
    });

    expect(result).toEqual({ known: "m-original", unknown: null });
  });
});

describe("the questions a task asks", () => {
  const asked = (requestId: string, prompt = "Which one?") =>
    ({
      type: HITL_REQUEST_TYPE,
      requestId,
      requestKind: "choice",
      prompt,
      allowFreeform: true
    }) satisfies HitlRequestData;

  it("keeps the first question a round asked", async () => {
    // A round can re-run after a crash and word its question differently, and
    // the first one may already be in front of the person.
    const result = await withDb("hr-open", async (db) => {
      await db.ensureReady();
      const open = (prompt: string) =>
        db.humanRequests.open({
          requestId: "q0",
          taskId: "t1",
          round: 0,
          request: asked("q0", prompt)
        });
      open("Which repository?");
      const again = open("Which repo do you mean?");
      return { again, forRound: db.humanRequests.forRound("t1", 0) };
    });

    expect(result.again.request.prompt).toBe("Which repository?");
    expect(result.again.status).toBe("awaiting");
    expect(result.forRound?.requestId).toBe("q0");
  });

  it("records an answer once, and knows its retry for the same message", async () => {
    const verdicts = await withDb("hr-answer", async (db) => {
      await db.ensureReady();
      db.humanRequests.open({
        requestId: "q0",
        taskId: "t1",
        round: 0,
        request: asked("q0")
      });
      const answer = (messageId: string) =>
        db.humanRequests.answer("q0", {
          answer: { optionId: "option_1", answeredBy: "U1" },
          messageId,
          at: 5_000
        });
      return {
        first: answer("gk:r:q0"),
        retry: answer("gk:r:q0"),
        another: answer("someone-else"),
        unknown: db.humanRequests.answer("nope", {
          answer: { text: "x", answeredBy: "U1" },
          messageId: "m",
          at: 1
        }),
        stored: db.humanRequests.get("q0")
      };
    });

    expect(verdicts.first).toBe("answered");
    expect(verdicts.retry).toBe("repeated");
    expect(verdicts.another).toBe("closed");
    expect(verdicts.unknown).toBe("unknown");
    expect(verdicts.stored).toMatchObject({
      status: "answered",
      answer: { optionId: "option_1", answeredBy: "U1" },
      closedAt: 5_000
    });
  });

  it("keeps whichever of an answer and an expiry landed first", async () => {
    const result = await withDb("hr-race", async (db) => {
      await db.ensureReady();
      for (const [requestId, round] of [
        ["answered-first", 0],
        ["expired-first", 1]
      ] as const) {
        db.humanRequests.open({
          requestId,
          taskId: "t1",
          round,
          request: asked(requestId)
        });
      }
      const reply = { answer: { text: "yes", answeredBy: "U1" }, at: 2 };

      db.humanRequests.answer("answered-first", { ...reply, messageId: "a" });
      const lateExpiry = db.humanRequests.expire("answered-first", 3);

      db.humanRequests.expire("expired-first", 2);
      const lateAnswer = db.humanRequests.answer("expired-first", {
        ...reply,
        messageId: "b"
      });

      return {
        lateExpiry,
        lateAnswer,
        answered: db.humanRequests.get("answered-first")?.status,
        expired: db.humanRequests.get("expired-first")?.status
      };
    });

    expect(result).toEqual({
      lateExpiry: false,
      lateAnswer: "closed",
      answered: "answered",
      expired: "unanswered"
    });
  });

  it("keeps the first moment a question was posted", async () => {
    // The step that posts it retries, and the wait began the first time.
    const stamps = await withDb("hr-parked", async (db) => {
      await db.ensureReady();
      db.humanRequests.open({
        requestId: "q0",
        taskId: "t1",
        round: 0,
        request: asked("q0")
      });
      return [
        db.humanRequests.markParked("q0", 100),
        db.humanRequests.markParked("q0", 200)
      ];
    });

    expect(stamps).toEqual([100, 100]);
  });

  it("closes a canceled task's open questions, and no one else's", async () => {
    const result = await withDb("hr-cancel", async (db) => {
      await db.ensureReady();
      const open = (requestId: string, taskId: string, round: number) =>
        db.humanRequests.open({
          requestId,
          taskId,
          round,
          request: asked(requestId)
        });
      open("t1-r0", "t1", 0);
      db.humanRequests.answer("t1-r0", {
        answer: { text: "yes", answeredBy: "U1" },
        messageId: "a",
        at: 1
      });
      open("t1-r1", "t1", 1);
      open("t2-r0", "t2", 0);

      return {
        closed: db.humanRequests.cancelForTask("t1", 9),
        latest: db.humanRequests.latest("t1")?.status,
        earlier: db.humanRequests.get("t1-r0")?.status,
        other: db.humanRequests.get("t2-r0")?.status
      };
    });

    expect(result).toEqual({
      closed: 1,
      latest: "canceled",
      earlier: "answered",
      other: "awaiting"
    });
  });
});
