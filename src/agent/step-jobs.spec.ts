import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import type { TestEnv } from "../../test/worker.js";
import { TASK_RETENTION_MS } from "../ledger.js";
import type { StepJob } from "../workflow/types.js";
import { StepJobs } from "./step-jobs.js";

/**
 * The job ledger's guarded writes, one invariant each. Every one is a race that
 * reaches the workflow as a wrong or a missing report if it regresses.
 */

const testEnv = env as unknown as TestEnv;

/** A ledger over a fresh object's SQLite. */
async function withLedger<R>(fn: (ledger: StepJobs) => R): Promise<R> {
  const stub = testEnv.TEST_AGENT.get(
    testEnv.TEST_AGENT.idFromName(`jobs:${crypto.randomUUID()}`)
  );
  return runInDurableObject(stub, (instance, state) => {
    const agent = instance as unknown as {
      sql: ConstructorParameters<typeof StepJobs>[0];
    };
    return fn(
      new StepJobs(
        (s, ...v) => agent.sql(s, ...v),
        (run) => state.storage.transactionSync(run)
      )
    );
  });
}

function job(stepJobId = "t1:main", taskId = "t1"): StepJob {
  return {
    stepJobId,
    taskId,
    contextId: "c1",
    input: "go",
    attempt: 1,
    caller: "caller",
    identity: { key: "k" },
    jku: "https://agent.test/.well-known/jwks.json",
    workflow: { name: "TEST_TASK", id: taskId },
    host: { binding: "TEST_HOST", name: "k" }
  };
}

const request: HitlRequestData = {
  type: HITL_REQUEST_TYPE,
  requestId: "t1:main:call-1",
  questions: [{ kind: "text", id: "q1", prompt: "Which one?" }]
};
const second: HitlRequestData = { ...request, requestId: "t1:main:call-2" };

function reports(ledger: StepJobs, stepJobId = "t1:main") {
  return ledger
    .numbers(stepJobId)
    .map((n) => ledger.report(stepJobId, n)!.report.kind);
}

describe("a job", () => {
  it("is recorded once, whatever starts it again", async () => {
    await withLedger((ledger) => {
      const first = ledger.accept(job());
      const again = ledger.accept({ ...job(), input: "other" });
      expect(again.job?.input).toBe(first.job?.input);
      expect(first).toEqual(
        expect.objectContaining({ state: "submitted", taskId: "t1" })
      );
    });
  });

  it("stays canceled when a cancel reached it before its start", async () => {
    await withLedger((ledger) => {
      ledger.tombstone("t1:main");
      ledger.accept(job());
      expect(ledger.row("t1:main")?.state).toBe("canceled");
      expect(ledger.row("t1:main")?.job).toBeNull();
      expect(ledger.closed("t1:main")).toBe(true);
    });
  });

  it("tells a turn for a job that has ended to stop", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      expect(ledger.markWorking("t1:main")).toEqual({
        closed: false,
        report: null
      });
      expect(ledger.row("t1:main")?.state).toBe("working");
      ledger.fail("t1:main", "cut");
      expect(ledger.markWorking("t1:main").closed).toBe(true);
      expect(ledger.closed("unknown")).toBe(true);
    });
  });
});

describe("reports", () => {
  it("fails once, owing its report in the same write", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      expect(ledger.fail("t1:main", "cut")).toBe(0);
      expect(ledger.fail("t1:main", "late")).toBeNull();
      expect(reports(ledger)).toEqual(["failed"]);
      expect(ledger.unsent()).toEqual([{ stepJobId: "t1:main", n: 0 }]);
      ledger.sent("t1:main", 0);
      expect(ledger.unsent()).toEqual([]);
    });
  });

  it("goes idle with what it would end on, and finishes only on its workflow's word", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      expect(ledger.idle("t1:main", "done")).toBe(0);
      // Only a working job goes idle.
      expect(ledger.idle("t1:main", "again")).toBeNull();
      expect(ledger.report("t1:main", 0)?.report).toEqual({
        kind: "idle",
        open: [],
        reply: "done"
      });
      // Anything that wakes it is a report of its own.
      expect(ledger.markWorking("t1:main")).toEqual({
        closed: false,
        report: 1
      });
      expect(ledger.complete("t1:main")).toEqual({ done: false });
      expect(ledger.idle("t1:main", "done now")).toBe(2);
      expect(ledger.complete("t1:main")).toEqual({
        done: true,
        reply: "done now"
      });
      expect(ledger.row("t1:main")?.state).toBe("completed");
      expect(reports(ledger)).toEqual(["idle", "working", "idle"]);
    });
  });

  it("asks as often as it needs, and holds the job open until each request closes", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      expect(ledger.ask("t1:main", request)).toBe(0);
      // A settlement run again finds the request recorded and owes nothing twice.
      expect(ledger.ask("t1:main", request)).toBeNull();
      expect(ledger.ask("t1:main", second)).toBe(1);
      expect(ledger.idle("t1:main", "")).toBe(2);
      expect(ledger.report("t1:main", 2)?.report).toEqual({
        kind: "idle",
        open: [request.requestId, second.requestId],
        reply: ""
      });
      expect(ledger.complete("t1:main")).toEqual({ done: false });

      expect(
        ledger.closeRequest("t1:main", request.requestId, "answered")?.requestId
      ).toBe(request.requestId);
      // An answer relayed again finds it closed.
      expect(
        ledger.closeRequest("t1:main", request.requestId, "answered")
      ).toBeNull();
      expect(ledger.request("t1:main", request.requestId)?.state).toBe(
        "answered"
      );
      ledger.markWorking("t1:main");
      ledger.closeRequest("t1:main", second.requestId, "expired");
      expect(ledger.openRequests("t1:main")).toEqual([]);
      ledger.idle("t1:main", "done");
      expect(ledger.complete("t1:main")).toEqual({ done: true, reply: "done" });
      expect(reports(ledger)).toEqual([
        "asked",
        "asked",
        "idle",
        "working",
        "idle"
      ]);
    });
  });

  it("finishes no job with work still open", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      ledger.idle("t1:main", "started it");
      expect(ledger.complete("t1:main")).toEqual({ done: false });
    });
  });

  it("holds a closed job's reports back while its work is open", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      // An open job's question goes out whatever runs beside it.
      ledger.ask("t1:main", request);
      expect(ledger.unsent()).toEqual([{ stepJobId: "t1:main", n: 0 }]);
      ledger.sent("t1:main", 0);

      ledger.fail("t1:main", "cut");
      expect(ledger.unsent()).toEqual([]);
      expect(ledger.unstopped()).toEqual(["t1:main"]);
      expect(ledger.unsentOf("t1:main")).toEqual([1]);
      expect(ledger.resendable("t1:main")).toEqual([0]);

      ledger.closeWork("d");
      expect(ledger.unstopped()).toEqual([]);
      expect(ledger.unsent()).toEqual([{ stepJobId: "t1:main", n: 1 }]);
      expect(ledger.resendable("t1:main")).toEqual([0, 1]);
    });
  });

  it("owes nothing once canceled, and drops what was not yet sent", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      ledger.ask("t1:main", request);
      expect(ledger.cancel("t1:main")).toBe(true);
      expect(ledger.cancel("t1:main")).toBe(false);
      expect(ledger.unsent()).toEqual([]);
      expect(ledger.fail("t1:main", "late")).toBeNull();
      expect(ledger.ask("t1:main", second)).toBeNull();
    });
  });
});

describe("the jobs of a task", () => {
  it("lists those still open", async () => {
    await withLedger((ledger) => {
      ledger.accept(job("t1:plan"));
      ledger.accept(job("t1:code"));
      ledger.accept(job("t2:main", "t2"));
      ledger.markWorking("t1:plan");
      ledger.idle("t1:plan", "plan");
      ledger.complete("t1:plan");
      expect(ledger.openJobsOf("t1")).toEqual(["t1:code"]);
      expect(
        ledger
          .openJobs()
          .map((j) => j.stepJobId)
          .sort()
      ).toEqual(["t1:code", "t2:main"]);
    });
  });

  it("keys two posts of one job apart", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      expect(ledger.nextPushKey("t1:main", "step")).toBe("step:1");
      expect(ledger.nextPushKey("t1:main", "turn")).toBe("turn:2");
    });
  });
});

describe("work", () => {
  it("holds a job open only for detached runs and waits", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "a",
        stepJobId: "t1:main",
        kind: "awaited",
        name: "C"
      });
      expect(ledger.openWork("t1:main")).toBe(0);
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      ledger.addWork({
        workId: "w",
        stepJobId: "t1:main",
        kind: "wait",
        name: "check_back"
      });
      expect(ledger.openWork("t1:main")).toBe(2);
      expect(ledger.openWorkRows("t1:main")).toHaveLength(3);
    });
  });

  it("closes a row once, so a redelivered finish follows up once", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      expect(ledger.closeWork("d")).toBe(true);
      expect(ledger.closeWork("d")).toBe(false);
      expect(ledger.openWork("t1:main")).toBe(0);
    });
  });

  it("records a work row once, whatever writes it again", async () => {
    await withLedger((ledger) => {
      const row = {
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached" as const,
        name: "C"
      };
      ledger.addWork(row);
      ledger.closeWork("d");
      ledger.addWork(row);
      expect(ledger.work("d")?.open).toBe(false);
    });
  });

  it("claims a run's settle once, and keeps what prepare returned for it", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C",
        runtime: { lease: "x" }
      });
      expect(ledger.work("d")?.runtime).toEqual({ lease: "x" });
      expect(ledger.claimSettle("d")).toBe(true);
      expect(ledger.claimSettle("d")).toBe(false);
    });
  });

  it("closes a row and owes its follow-up in one write, holding the job until that turn has run", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      const followUp = { id: "finish:d", text: "done" };
      expect(ledger.beginFollowUp("d", followUp)).toBe(true);
      expect(ledger.openWork("t1:main")).toBe(1);
      // A redelivery neither reopens nor re-records it.
      expect(ledger.beginFollowUp("d", { id: "x", text: "y" })).toBe(false);
      expect(ledger.followUp("d")).toEqual(followUp);
      expect(ledger.pendingFollowUps()).toEqual(["d"]);

      ledger.endFollowUp("d");
      expect(ledger.followUp("d")).toBeNull();
      expect(ledger.pendingFollowUps()).toEqual([]);
      expect(ledger.openWork("t1:main")).toBe(0);
    });
  });

  it("attaches a schedule only to a wait that is still open", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "w",
        stepJobId: "t1:main",
        kind: "wait",
        name: "cb"
      });
      expect(ledger.setWorkSchedule("w", "s1")).toBe(true);
      ledger.closeWork("w");
      expect(ledger.setWorkSchedule("w", "s2")).toBe(false);
      expect(ledger.work("w")?.scheduleId).toBe("s1");
    });
  });

  it("maps a run back to its job", async () => {
    await withLedger((ledger) => {
      ledger.addWork({
        workId: "d",
        stepJobId: "t9:main",
        kind: "detached",
        name: "C"
      });
      expect(ledger.work("d")?.stepJobId).toBe("t9:main");
      expect(ledger.work("nope")).toBeNull();
    });
  });
});

describe("the end of a task", () => {
  it("owes its settle hook until none of its jobs has work open", async () => {
    await withLedger((ledger) => {
      ledger.accept(job("t1:main"));
      ledger.accept(job("t2:main", "t2"));
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      ledger.cancel("t1:main");
      ledger.oweTaskHook("t1", 4);
      ledger.oweTaskHook("t1", 5);
      ledger.oweTaskHook("t2", 4);
      // Another task's open work holds nothing of this one's.
      expect(ledger.dueTaskHooks()).toEqual([{ taskId: "t2", state: 4 }]);

      ledger.closeWork("d");
      expect(ledger.dueTaskHooks()).toEqual([
        { taskId: "t1", state: 4 },
        { taskId: "t2", state: 4 }
      ]);
      ledger.taskHookRan("t1");
      expect(ledger.dueTaskHooks()).toEqual([{ taskId: "t2", state: 4 }]);
    });
  });
});

describe("retention", () => {
  it("sweeps settled jobs past the window, with what they owned, and never an open one", async () => {
    await withLedger((ledger) => {
      ledger.accept(job("t1:main"));
      ledger.ask("t1:main", request);
      ledger.fail("t1:main", "cut");
      ledger.addWork({
        workId: "d",
        stepJobId: "t1:main",
        kind: "detached",
        name: "C"
      });
      ledger.accept(job("t2:main", "t2"));
      ledger.sweep(Date.now() + TASK_RETENTION_MS);
      expect(ledger.row("t1:main")).toBeNull();
      expect(ledger.numbers("t1:main")).toEqual([]);
      expect(ledger.request("t1:main", request.requestId)).toBeNull();
      expect(ledger.work("d")).toBeNull();
      expect(ledger.row("t2:main")).not.toBeNull();
    });
  });
});
