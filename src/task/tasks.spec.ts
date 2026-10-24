import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { buildAskingTask, buildWaitingTask } from "../a2a/hitl.js";
import {
  buildCompletedTask,
  buildFailedTask,
  buildWorkingTask
} from "../a2a/notify.js";
import { testTask } from "../testing/fixtures.js";
import type { TestEnv } from "../../test/worker.js";
import { TASK_RETENTION_MS } from "../ledger.js";
import { A2ATasks, STATE_KEY, questionKey } from "./tasks.js";

/**
 * The host's ledger's guarded writes, one invariant each. Every one is a race
 * that reaches the gatekeeper as a wrong callback if it regresses.
 */

const testEnv = env as unknown as TestEnv;

/** A ledger over a fresh object's SQLite. */
async function withLedger<R>(fn: (ledger: A2ATasks) => R): Promise<R> {
  const stub = testEnv.TEST_HOST.get(
    testEnv.TEST_HOST.idFromName(`ledger:${crypto.randomUUID()}`)
  );
  return runInDurableObject(stub, (instance, state) => {
    const agent = instance as unknown as {
      sql: ConstructorParameters<typeof A2ATasks>[0];
    };
    return fn(
      new A2ATasks(
        (s, ...v) => agent.sql(s, ...v),
        (run) => state.storage.transactionSync(run)
      )
    );
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

  it("binds a started task once, and sweeps up only one never bound", async () => {
    await withLedger((ledger) => {
      accept(ledger, "t1", "m1");
      accept(ledger, "t2", "m2");
      ledger.bind("t2");
      ledger.markWorking("t2");
      expect(ledger.unbound()).toEqual(["t1"]);
      expect(ledger.openBound()).toEqual(["t2"]);
      expect(ledger.row("t2")?.bound).toBe(true);
    });
  });

  it("settles once, owing the callback and the hooks in the same write", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      expect(ledger.settle(buildCompletedTask("t1", "c1", "done"))).toBe(true);
      expect(ledger.row("t1")?.deliveryKey).toBe("completed");
      expect(ledger.pendingHooks()).toEqual(["t1"]);
      // The workflow finished it: nothing is left running to stop.
      expect(ledger.row("t1")?.stopPending).toBe(false);
      expect(ledger.settle(buildFailedTask("t1", "c1", "no"))).toBe(false);
      expect(ledger.row("t1")?.state).toBe("completed");

      ledger.delivered("t1", "completed", ledger.owed("t1", "completed")!);
      ledger.hooksRan("t1");
      expect(ledger.pendingDeliveries()).toEqual([]);
      expect(ledger.pendingHooks()).toEqual([]);
    });
  });

  it("owes the stop and the hooks, and no callback, for a cancel — once", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      expect(ledger.cancel("t1")).not.toBeNull();
      expect(ledger.row("t1")?.deliveryKey).toBeNull();
      expect(ledger.row("t1")?.stopPending).toBe(true);
      expect(ledger.pendingStops()).toEqual(["t1"]);
      expect(ledger.pendingHooks()).toEqual(["t1"]);
      ledger.stopped("t1");
      expect(ledger.row("t1")?.stopPending).toBe(false);
      expect(ledger.pendingStops()).toEqual([]);
      // A replay of the cancel is not a second transition.
      expect(ledger.cancel("t1")).toBeNull();
    });
  });

  it("owes the stop with a settle the host makes while the run still goes", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      const failed = buildFailedTask("t1", "c1", "expired");
      expect(ledger.settle(failed, { stop: true })).toBe(true);
      expect(ledger.row("t1")).toEqual(
        expect.objectContaining({ stopPending: true, hooksPending: true })
      );
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

  it("refuses working and input-required over each other", async () => {
    // The request handler re-saves the task it loaded for a reply, and its
    // workflow can move it either way before the handler saves.
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      ledger.setState(
        "t1",
        "input-required",
        buildWaitingTask("t1", "c1", "w1")
      );
      expect(
        ledger.save(testTask("t1", "c1", TaskState.TASK_STATE_WORKING))
      ).toBe(false);
      expect(ledger.row("t1")?.state).toBe("input-required");

      ledger.setState("t1", "working", buildWorkingTask("t1", "c1", "", "w2"));
      expect(
        ledger.save(testTask("t1", "c1", TaskState.TASK_STATE_INPUT_REQUIRED))
      ).toBe(false);
      expect(ledger.row("t1")?.state).toBe("working");
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

describe("the requests a task asks", () => {
  const request: HitlRequestData = {
    type: HITL_REQUEST_TYPE,
    requestId: "t1:call-1",
    questions: [{ kind: "text", id: "q1", prompt: "Which one?" }]
  };
  const second: HitlRequestData = { ...request, requestId: "t1:call-2" };
  const asking = (r: HitlRequestData) => buildAskingTask("t1", "c1", r);

  it("holds any number open, each owing its own callback, once", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      expect(ledger.ask("t1", "job", request, asking(request))).toBe("parked");
      expect(ledger.ask("t1", "job", second, asking(second))).toBe("parked");
      // A park step run again owes nothing twice.
      expect(ledger.ask("t1", "job", request, asking(request))).toBe("parked");
      expect(ledger.openRequests("t1").map((r) => r.requestId)).toEqual([
        request.requestId,
        second.requestId
      ]);
      expect(ledger.pendingDeliveries()).toEqual([
        { taskId: "t1", key: questionKey(request.requestId) },
        { taskId: "t1", key: questionKey(second.requestId) }
      ]);
      // Asking stops nothing: the task is still working.
      expect(ledger.row("t1")?.state).toBe("working");
      expect(ledger.request("t1", second.requestId)?.stepJobId).toBe("job");
    });
  });

  it("closes a request on its answer once, and drops its callback if it has not gone", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      ledger.ask("t1", "job", request, asking(request));
      ledger.ask("t1", "job", second, asking(second));
      const key = questionKey(second.requestId);
      ledger.delivered("t1", key, ledger.owed("t1", key)!);

      expect(ledger.closeRequest("t1", request.requestId, "answered")).toBe(
        true
      );
      expect(ledger.closeRequest("t1", request.requestId, "answered")).toBe(
        false
      );
      expect(ledger.owed("t1", questionKey(request.requestId))).toBeNull();
      expect(ledger.closeRequest("t1", second.requestId, "expired")).toBe(true);
      expect(ledger.request("t1", second.requestId)?.state).toBe("expired");
      expect(ledger.openRequests("t1")).toEqual([]);
    });
  });

  it("asks nothing of a task that has ended", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.cancel("t1");
      expect(ledger.ask("t1", "job", request, asking(request))).toBe("closed");
      expect(ledger.openRequests("t1")).toEqual([]);
    });
  });

  it("drops every callback an open task owes when it settles, or is canceled", async () => {
    await withLedger((ledger) => {
      accept(ledger, "t1", "m1");
      ledger.markWorking("t1");
      ledger.ask("t1", "job", request, asking(request));
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(ledger.pendingDeliveries()).toEqual([
        { taskId: "t1", key: "completed" }
      ]);

      accept(ledger, "t2", "m2");
      ledger.markWorking("t2");
      ledger.setState(
        "t2",
        "input-required",
        buildWaitingTask("t2", "c1", "w")
      );
      ledger.cancel("t2");
      expect(ledger.owed("t2", STATE_KEY)).toBeNull();
    });
  });
});

describe("a task's state while it runs", () => {
  it("moves between working and input-required, owing one state callback", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      ledger.markWorking("t1");
      expect(
        ledger.setState(
          "t1",
          "input-required",
          buildWaitingTask("t1", "c1", "w1")
        )
      ).toBe(true);
      // A step run again finds it there already.
      expect(
        ledger.setState(
          "t1",
          "input-required",
          buildWaitingTask("t1", "c1", "w2")
        )
      ).toBe(false);
      expect(
        ledger.setState("t1", "working", buildWorkingTask("t1", "c1", "", "w3"))
      ).toBe(true);
      // One slot, and the latest state is what it posts.
      expect(ledger.pendingDeliveries()).toEqual([
        { taskId: "t1", key: STATE_KEY }
      ]);
      expect(ledger.owed("t1", STATE_KEY)?.status?.state).toBe(
        TaskState.TASK_STATE_WORKING
      );
      // A state that replaces the one posting is still owed once it lands.
      const posted = ledger.owed("t1", STATE_KEY)!;
      ledger.setState(
        "t1",
        "input-required",
        buildWaitingTask("t1", "c1", "w4")
      );
      expect(ledger.delivered("t1", STATE_KEY, posted)).toBe(false);
      expect(ledger.owed("t1", STATE_KEY)?.status?.state).toBe(
        TaskState.TASK_STATE_INPUT_REQUIRED
      );
      expect(
        ledger.delivered("t1", STATE_KEY, ledger.owed("t1", STATE_KEY)!)
      ).toBe(true);
      expect(ledger.owed("t1", STATE_KEY)).toBeNull();
    });
  });

  it("moves only a task that runs", async () => {
    await withLedger((ledger) => {
      accept(ledger);
      expect(
        ledger.setState(
          "t1",
          "input-required",
          buildWaitingTask("t1", "c1", "w")
        )
      ).toBe(false);
      ledger.markWorking("t1");
      ledger.settle(buildCompletedTask("t1", "c1", "done"));
      expect(
        ledger.setState("t1", "working", buildWorkingTask("t1", "c1", "", "w"))
      ).toBe(false);
      expect(ledger.row("t1")?.state).toBe("completed");
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
