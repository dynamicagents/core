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
  requestKind: "choice",
  prompt: "Which one?",
  allowFreeform: true
};

function reports(ledger: StepJobs, stepJobId = "t1:main") {
  return ledger
    .numbers(stepJobId)
    .map((n) => ledger.report(stepJobId, n)!.report.state);
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
      expect(ledger.markWorking("t1:main")).toBe("ok");
      expect(ledger.row("t1:main")?.state).toBe("working");
      ledger.settle("t1:main", { state: "failed", error: "cut" });
      expect(ledger.markWorking("t1:main")).toBe("closed");
      expect(ledger.closed("unknown")).toBe(true);
    });
  });
});

describe("reports", () => {
  it("settles once, owing its report in the same write", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      expect(
        ledger.settle("t1:main", { state: "completed", reply: "done" })
      ).toBe(0);
      expect(
        ledger.settle("t1:main", { state: "failed", error: "late" })
      ).toBeNull();
      expect(reports(ledger)).toEqual(["completed"]);
      expect(ledger.unsent()).toEqual([{ stepJobId: "t1:main", n: 0 }]);
      ledger.sent("t1:main", 0);
      expect(ledger.unsent()).toEqual([]);
    });
  });

  it("numbers a question's report, then the one that settles the job", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      expect(ledger.park("t1:main", request)).toBe(0);
      expect(ledger.row("t1:main")?.request?.requestId).toBe(request.requestId);
      // A park run twice finds it parked and owes nothing twice.
      expect(ledger.park("t1:main", request)).toBeNull();

      const answer = { id: `answer:${request.requestId}`, text: "Yes" };
      expect(ledger.resume("t1:main", answer)).toBe(true);
      expect(ledger.resume("t1:main", answer)).toBe(false);
      expect(ledger.pendingAnswers()).toEqual(["t1:main"]);
      ledger.answered("t1:main", "answer:another");
      expect(ledger.row("t1:main")?.answer).toEqual(answer);
      ledger.answered("t1:main", answer.id);
      expect(ledger.pendingAnswers()).toEqual([]);

      expect(
        ledger.settle("t1:main", { state: "completed", reply: "done" })
      ).toBe(1);
      expect(reports(ledger)).toEqual(["input-required", "completed"]);
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
      ledger.park("t1:main", request);
      expect(ledger.unsent()).toEqual([{ stepJobId: "t1:main", n: 0 }]);
      ledger.sent("t1:main", 0);

      ledger.resume("t1:main", { id: "answer:a", text: "Yes" });
      ledger.settle("t1:main", { state: "failed", error: "cut" });
      expect(ledger.unsent()).toEqual([]);
      expect(ledger.unstopped()).toEqual(["t1:main"]);
      expect(ledger.unsentOf("t1:main")).toEqual([1]);

      ledger.closeWork("d");
      expect(ledger.unstopped()).toEqual([]);
      expect(ledger.unsent()).toEqual([{ stepJobId: "t1:main", n: 1 }]);
    });
  });

  it("owes nothing once canceled, and drops what was not yet sent", async () => {
    await withLedger((ledger) => {
      ledger.accept(job());
      ledger.markWorking("t1:main");
      ledger.park("t1:main", request);
      expect(ledger.cancel("t1:main")).toBe(true);
      expect(ledger.cancel("t1:main")).toBe(false);
      expect(ledger.unsent()).toEqual([]);
      expect(ledger.row("t1:main")?.request).toBeNull();
      expect(
        ledger.settle("t1:main", { state: "completed", reply: "late" })
      ).toBeNull();
    });
  });
});

describe("the jobs of a task", () => {
  it("lists those still open", async () => {
    await withLedger((ledger) => {
      ledger.accept(job("t1:plan"));
      ledger.accept(job("t1:code"));
      ledger.accept(job("t2:main", "t2"));
      ledger.settle("t1:plan", { state: "completed", reply: "plan" });
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

describe("retention", () => {
  it("sweeps settled jobs past the window, with what they owned, and never an open one", async () => {
    await withLedger((ledger) => {
      ledger.accept(job("t1:main"));
      ledger.settle("t1:main", { state: "completed", reply: "done" });
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
      expect(ledger.work("d")).toBeNull();
      expect(ledger.row("t2:main")).not.toBeNull();
    });
  });
});
