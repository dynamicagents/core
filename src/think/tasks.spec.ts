import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { buildInputRequiredTask } from "../a2a/hitl.js";
import { buildCompletedTask, buildFailedTask } from "../a2a/notify.js";
import { testTask } from "../testing/fixtures.js";
import type { TestEnv } from "../../test/worker.js";
import { A2ATasks, TASK_RETENTION_MS } from "./tasks.js";

/**
 * The ledger's guarded writes, one invariant each. Every one is a race that
 * reaches the gatekeeper as a wrong callback if it regresses.
 */

const testEnv = env as unknown as TestEnv;

/** A ledger over a fresh object's SQLite. */
async function withLedger<R>(fn: (ledger: A2ATasks) => R): Promise<R> {
  const stub = testEnv.TEST_AGENT.get(
    testEnv.TEST_AGENT.idFromName(`ledger:${crypto.randomUUID()}`)
  );
  return runInDurableObject(stub, (instance) => {
    const agent = instance as unknown as {
      sql: ConstructorParameters<typeof A2ATasks>[0];
    };
    return fn(new A2ATasks((s, ...v) => agent.sql(s, ...v)));
  });
}

const push = {
  taskId: "t1",
  contextId: "c1",
  pushUrl: "https://gatekeeper.test/cb",
  pushToken: "tok",
  jku: "https://agent.test/.well-known/jwks.json"
};
const identity = { key: "k", name: "Caller" };

function accept(ledger: A2ATasks, taskId = "t1", messageId = "m1") {
  return ledger.accept({
    messageId,
    taskId,
    contextId: "c1",
    push: { ...push, taskId },
    identity
  });
}

describe("accepting a task", () => {
  it("is idempotent on the gatekeeper's messageId, not the task id", async () => {
    await withLedger((ledger) => {
      const first = accept(ledger, "t1", "m1");
      const retry = accept(ledger, "t-other", "m1");
      expect(retry.taskId).toBe(first.taskId);
      expect(first.state).toBe("submitted");
      expect(first.push?.pushUrl).toBe(push.pushUrl);
      expect(first.identity?.key).toBe("k");
    });
  });

  it("filters a listing by context and reports the total for paging", async () => {
    await withLedger((ledger) => {
      accept(ledger, "t1", "m1");
      accept(ledger, "t2", "m2");
      const page = ledger.list({
        contextId: "c1",
        includeArtifacts: false,
        limit: 1,
        offset: 0
      });
      expect(page.tasks).toHaveLength(1);
      expect(page.totalSize).toBe(2);
    });
  });
});

describe("transitions", () => {
  it("guards the working transition and refuses it once canceled", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      expect(ledger.markWorking("t1")).toBe("ok");
      expect(ledger.row("t1")?.state).toBe("working");
      expect(ledger.cancel("t1")).not.toBeNull();
      expect(ledger.markWorking("t1")).toBe("canceled");
      expect(ledger.row("t1")?.state).toBe("canceled");
    });
  });

  it("settles once, owing the callback and the hooks in the same write", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      expect(ledger.settle(buildCompletedTask("t1", "c1", "done"))).toBe(true);
      expect(ledger.row("t1")?.deliveryKey).toBe("completed");
      expect(ledger.pendingHooks()).toEqual(["t1"]);
      expect(ledger.settle(buildFailedTask("t1", "c1", "no"))).toBe(false);
      expect(ledger.row("t1")?.state).toBe("completed");

      ledger.delivered("t1", "completed");
      ledger.hooksRan("t1");
      expect(ledger.pendingDeliveries()).toEqual([]);
      expect(ledger.pendingHooks()).toEqual([]);
    });
  });

  it("owes the hooks, and no callback, for a cancel — once", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      expect(ledger.cancel("t1")).not.toBeNull();
      expect(ledger.row("t1")?.deliveryKey).toBeNull();
      expect(ledger.pendingHooks()).toEqual(["t1"]);
      // A replay of the cancel is not a second transition.
      expect(ledger.cancel("t1")).toBeNull();
    });
  });

  it("refuses to cancel a task that already completed", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(ledger.cancel("t1")).toBeNull();
      expect(ledger.row("t1")?.state).toBe("completed");
    });
  });

  it("refuses to settle a canceled task", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.cancel("t1");
      expect(ledger.settle(buildCompletedTask("t1", "c1", "late"))).toBe(false);
      expect(ledger.row("t1")?.state).toBe("canceled");
    });
  });
});

describe("the task store's writes", () => {
  it("refuses a canceled task over one that already completed", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(
        ledger.save(testTask("t1", "c1", TaskState.TASK_STATE_CANCELED))
      ).toBe(false);
    });
  });

  it("refuses one terminal state over a different one, either way", async () => {
    await withLedger((ledger) => {
      accept(ledger, "t1", "m1");
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(ledger.save(buildFailedTask("t1", "c1", "no"))).toBe(false);

      accept(ledger, "t2", "m2");
      ledger.settle(buildFailedTask("t2", "c1", "no"));
      expect(ledger.save(buildCompletedTask("t2", "c1", "done"))).toBe(false);
    });
  });

  it("never moves a task out of a terminal state", async () => {
    // The request handler re-saves the task it loaded for a reply, and the
    // answered turn can settle it first.
    await withLedger((ledger) => {
      accept(ledger);
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(
        ledger.save(testTask("t1", "c1", TaskState.TASK_STATE_WORKING))
      ).toBe(false);
      expect(ledger.row("t1")?.state).toBe("completed");
    });
  });

  it("allows a terminal task to be re-saved in the same state", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(ledger.save(buildCompletedTask("t1", "c1", "done"))).toBe(true);
    });
  });

  it("refuses the accepted snapshot over a task that moved past it", async () => {
    // The request handler re-saves the task it published, and a fast turn is
    // already running by then.
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      expect(
        ledger.save(testTask("t1", "c1", TaskState.TASK_STATE_SUBMITTED))
      ).toBe(false);
      expect(ledger.row("t1")?.state).toBe("working");
    });
  });

  it("round-trips a task through the SDK's own JSON form", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.settle(buildCompletedTask("t1", "c1", "hello"));
      const task = ledger.get("t1");
      expect(task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(task?.status?.message?.parts?.[0]).toEqual(
        expect.objectContaining({ content: { $case: "text", value: "hello" } })
      );
    });
  });
});

describe("a task parked on a question", () => {
  const request: HitlRequestData = {
    type: HITL_REQUEST_TYPE,
    requestId: "t1:call-1",
    requestKind: "choice",
    prompt: "Which one?",
    allowFreeform: true
  };

  it("parks a working task, and resumes it once", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      const parked = buildInputRequiredTask("t1", "c1", request);
      expect(ledger.park(parked, request)).toBe(true);
      expect(ledger.row("t1")?.request?.requestId).toBe(request.requestId);
      expect(ledger.row("t1")?.deliveryKey).toBe(
        `input-required:${request.requestId}`
      );
      expect(ledger.resume("t1")).not.toBeNull();
      expect(ledger.resume("t1")).toBeNull();
      expect(ledger.row("t1")?.request).toBeNull();
    });
  });

  it("never lets an earlier question's delivery stand in for a later one", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      ledger.park(buildInputRequiredTask("t1", "c1", request), request);
      const first = ledger.row("t1")!.deliveryKey!;
      ledger.resume("t1");
      const second = { ...request, requestId: "t1:call-2" };
      ledger.park(buildInputRequiredTask("t1", "c1", second), second);

      // The first question's late acknowledgement clears nothing.
      ledger.delivered("t1", first);
      expect(ledger.row("t1")?.deliveryKey).toBe("input-required:t1:call-2");
    });
  });

  it("parks only a task that is working", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      const parked = buildInputRequiredTask("t1", "c1", request);
      expect(ledger.park(parked, request)).toBe(false);
      ledger.cancel("t1");
      expect(ledger.park(parked, request)).toBe(false);
    });
  });

  it("lets a cancel reach a task waiting on its question", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      ledger.park(buildInputRequiredTask("t1", "c1", request), request);
      expect(ledger.cancel("t1")).not.toBeNull();
      expect(ledger.row("t1")?.request).toBeNull();
    });
  });
});

describe("work", () => {
  it("holds a task open only for detached runs and waits", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.addWork({ workId: "a", taskId: "t1", kind: "awaited", name: "C" });
      expect(ledger.openWork("t1")).toBe(0);
      ledger.addWork({
        workId: "d",
        taskId: "t1",
        kind: "detached",
        name: "C"
      });
      ledger.addWork({
        workId: "w",
        taskId: "t1",
        kind: "wait",
        name: "check_back"
      });
      expect(ledger.openWork("t1")).toBe(2);
      expect(ledger.openWorkRows("t1")).toHaveLength(3);
    });
  });

  it("closes a row once, so a redelivered finish follows up once", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        taskId: "t1",
        kind: "detached",
        name: "C"
      });
      expect(ledger.closeWork("d")).toBe(true);
      expect(ledger.closeWork("d")).toBe(false);
      expect(ledger.openWork("t1")).toBe(0);
    });
  });

  it("records a work row once, whatever writes it again", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        taskId: "t1",
        kind: "detached",
        name: "C"
      });
      ledger.closeWork("d");
      ledger.addWork({
        workId: "d",
        taskId: "t1",
        kind: "detached",
        name: "C"
      });
      expect(ledger.work("d")?.open).toBe(false);
    });
  });

  it("claims a run's settle once, and keeps what prepare returned for it", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        taskId: "t1",
        kind: "detached",
        name: "C",
        runtime: { lease: "x" }
      });
      expect(ledger.work("d")?.runtime).toEqual({ lease: "x" });
      expect(ledger.claimSettle("d")).toBe(true);
      expect(ledger.claimSettle("d")).toBe(false);
    });
  });

  it("closes a row and owes its follow-up in one write, and keeps owing it until sent", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        taskId: "t1",
        kind: "detached",
        name: "C"
      });
      const followUp = { id: "finish:d", text: "done" };
      expect(ledger.beginFollowUp("d", followUp)).toBe(true);
      expect(ledger.openWork("t1")).toBe(0);
      // A redelivery neither reopens nor re-records it.
      expect(ledger.beginFollowUp("d", { id: "x", text: "y" })).toBe(false);
      expect(ledger.followUp("d")).toEqual(followUp);
      expect(ledger.pendingFollowUps()).toEqual(["d"]);

      ledger.endFollowUp("d");
      expect(ledger.followUp("d")).toBeNull();
      expect(ledger.pendingFollowUps()).toEqual([]);
    });
  });

  it("maps a run back to its task", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        taskId: "t9",
        kind: "detached",
        name: "C"
      });
      expect(ledger.work("d")?.taskId).toBe("t9");
      expect(ledger.work("nope")).toBeNull();
    });
  });
});

describe("retention", () => {
  it("sweeps settled tasks past the window, and never an open one", async () => {
    await withLedger((ledger) => {
      accept(ledger, "t1", "m1");
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      accept(ledger, "t2", "m2");
      ledger.sweep(Date.now() + TASK_RETENTION_MS);
      expect(ledger.row("t1")).toBeNull();
      expect(ledger.row("t2")).not.toBeNull();
    });
  });
});
