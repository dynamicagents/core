import { describe, it, expect, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import type { GatekeeperIdentity } from "@dynamicagents/g2a-protocol";
import { resolveConfig } from "../config.js";
import { TEST_MODELS } from "../testing/fixtures.js";
import { runHandleTask, type HandleTaskDeps } from "./workflow.js";
import type { RoundPolicy } from "./policy.js";
import type { FinalRoundReason } from "./policy.js";
import type { RoundMode } from "./turn.js";

/**
 * The durable orchestration: cancellation ordering, replay determinism, and the
 * save-before-notify rule.
 *
 * ## Why a fake `step`
 *
 * Every fact here is about *which steps run, in what order, on what verdict* —
 * and none of it is observable from the outside. A canceled task that still
 * posts a `completed` callback looks identical to a healthy one until the
 * gatekeeper shows a reply for work the user abandoned.
 *
 * The `cached` option is what a Workflow replay actually does: serve an
 * already-durable step's recorded result without re-running its body. That is
 * how these drive a full task with no model behind `turn:0` — and it is also the
 * property being tested in the determinism specs, since a step whose input
 * depends on unrecorded state reconstructs differently on replay.
 *
 * This is the file whose absence let the whole loop move into a published
 * package uncovered; `turn.spec.ts` explains how that happened.
 */

const IDENTITY: GatekeeperIdentity = {
  key: "remote:1:test",
  name: "Test",
  kind: "remote",
  workspaceId: 1
};

const policy: RoundPolicy = {
  roundContract: () => "\n\ncontract",
  finalRoundNote: () => "\n\nnote",
  copy: {
    taskFailed: "TASK FAILED COPY",
    recoveredReply: "recovered",
    partialNote: "partial"
  }
};

interface FakeStepOptions {
  /** Step results served without running the body — a Workflow replay. */
  cached?: Record<string, unknown>;
  /**
   * Extra attempts a throwing body gets, like the platform's own step retries.
   * Zero (the default) keeps every other spec's single-shot behaviour.
   */
  retries?: number;
}

function fakeStep(options: FakeStepOptions = {}) {
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      ran.push(name);
      if (Object.hasOwn(options.cached ?? {}, name))
        return options.cached![name];
      let last: unknown;
      for (let attempt = 0; attempt <= (options.retries ?? 0); attempt++) {
        try {
          return await body();
        } catch (err) {
          last = err;
        }
      }
      throw last;
    }
  } as unknown as WorkflowStep;
  return { step, ran };
}

interface FakeAgentOptions {
  markWorking?: "ok" | "canceled";
  /** Whether the guarded terminal write applies. `false` ⇒ a cancel won. */
  saveTask?: boolean;
}

function fakeAgent(options: FakeAgentOptions = {}) {
  const calls: string[] = [];
  const stub = {
    async markWorking() {
      calls.push("markWorking");
      return options.markWorking ?? "ok";
    },
    async runTaskTurn() {
      calls.push("runTaskTurn");
      return { status: "replied", reply: "the answer", turns: 1 };
    },
    async saveTask() {
      calls.push("saveTask");
      return options.saveTask ?? true;
    },
    async sweepTaskChildren() {
      calls.push("sweepTaskChildren");
    },
    async cancelPendingSubtasks() {
      calls.push("cancelPendingSubtasks");
      return 0;
    },
    // A round that failed nothing: the progress guard has nothing to count, which
    // is what every spec outside `no progress across rounds` wants.
    async roundFailures() {
      calls.push("roundFailures");
      return [];
    }
  };
  return { stub, calls };
}

/**
 * A `fakeAgent` whose guarded terminal write also records what it persisted —
 * the only way to read the words a failure actually delivered, since `notify`
 * posts what `saveTask` accepted.
 */
function savingAgent() {
  const saved: unknown[] = [];
  const { stub } = fakeAgent();
  const spy = {
    ...stub,
    async saveTask(task: unknown) {
      saved.push(task);
      return true;
    }
  };
  return { saved, spy };
}

function params() {
  return {
    taskId: "task-1",
    text: "do the thing",
    identity: IDENTITY,
    contextId: "ctx-1",
    // Unreachable on purpose: a spec that posts here has already failed the
    // assertion it cares about.
    pushUrl: "https://gatekeeper.invalid/push",
    pushToken: "push-token",
    jku: "https://agent.invalid/.well-known/jwks.json"
  };
}

function deps(stub: unknown): HandleTaskDeps {
  return {
    resolveAgent: () => stub as never,
    config: resolveConfig({ model: TEST_MODELS }),
    policy,
    signingKey: "unused-in-these-specs"
  };
}

describe("a task canceled before the workflow starts", () => {
  it("never runs a turn and never calls back", async () => {
    const { stub, calls } = fakeAgent({ markWorking: "canceled" });
    const { step, ran } = fakeStep();

    await runHandleTask(params(), step, deps(stub));

    // `markWorking` reports the cancellation itself, so the pipeline stops on
    // its verdict rather than on a separate probe. Discarding that verdict
    // bills a model call and posts a callback for a task the caller abandoned —
    // the exact bug that made the second copy of this loop diverge.
    expect(ran).toEqual(["working"]);
    expect(calls).toEqual(["markWorking"]);
    expect(calls).not.toContain("runTaskTurn");
  });
});

describe("a task canceled while the model is working", () => {
  it("keys the callback on the guarded write, not on a probe", async () => {
    // `saveTask` refuses: a `tasks/cancel` landed after the turn produced a
    // reply. The terminal write is the only authority — it does its read and
    // its write in one synchronous pass inside the DO, so nothing can slip
    // between them the way a `getTask` probe allows.
    const { stub } = fakeAgent({ saveTask: false });
    const { step, ran } = fakeStep({
      cached: { "turn:0": { status: "replied", reply: "the answer", turns: 1 } }
    });

    await runHandleTask(params(), step, deps(stub));

    expect(ran).toContain("complete");
    expect(ran).not.toContain("notify");
    // …and the sweep is skipped too: it belongs to a task that terminated, and
    // this one did not.
    expect(ran).not.toContain("sweep");
  });

  /**
   * And the record says so. A reply the guarded write refused is a reply nobody
   * received, so calling the run `replied` would describe an outcome the user
   * never saw — the same class of defect as a failed task recording itself as a
   * clean `complete`.
   */
  it("reports the cancellation, not the reply nobody got", async () => {
    const { stub } = fakeAgent({ saveTask: false });
    const { step } = fakeStep({
      cached: { "turn:0": { status: "replied", reply: "the answer", turns: 1 } }
    });

    await expect(runHandleTask(params(), step, deps(stub))).resolves.toEqual({
      outcome: "canceled",
      rounds: 1,
      turns: 1
    });
  });

  it("reports the cancellation over a failure nobody got either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = fakeAgent({ saveTask: false });
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "exhausted",
          error: "model exploded",
          turns: 1
        }
      }
    });

    await expect(
      runHandleTask(params(), step, deps(stub))
    ).resolves.toMatchObject({ outcome: "canceled" });
  });
});

describe("the ordinary path", () => {
  it("saves the terminal task before it notifies, and sweeps between", async () => {
    const { stub, calls } = fakeAgent({ saveTask: true });
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(stub));

    // Order is the assertion, not merely presence. A notify that ran before the
    // guarded save would post a reply the DO might then refuse to record.
    expect(ran.indexOf("complete")).toBeLessThan(ran.indexOf("sweep"));
    expect(ran.indexOf("sweep")).toBeLessThan(ran.indexOf("notify"));
    expect(calls).toContain("saveTask");
  });

  it("still notifies when the sweep fails after its retries are exhausted", async () => {
    // The terminal Task is already durably saved by the time sweep runs, so a
    // stuck or unreachable cleanup RPC must not strand the gatekeeper without its
    // result — logged and skipped, not fatal to `notify`.
    const { stub } = fakeAgent();
    const spy = {
      ...stub,
      async sweepTaskChildren() {
        throw new Error("facet unreachable");
      }
    };
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(spy));

    expect(ran).toContain("sweep");
    expect(ran).toContain("notify");
  });

  it("reads the clock inside a step, so a replay sees the original instant", async () => {
    // `started` exists to be cached. A workflow that retried overnight and
    // re-read `Date.now()` would restart its own deadline and never observe the
    // budget it had long since blown.
    const { stub } = fakeAgent();
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "x", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(stub));
    expect(ran).toContain("started");
    expect(ran.indexOf("started")).toBeLessThan(ran.indexOf("turn:0"));
  });
});

/**
 * The budget's last turn, which is reserved rather than spent.
 *
 * A round ends **only** on a control call, and the tool loop halts on the step
 * count just as readily — so a round handed a single turn ends only if the model
 * happens to reach for an ending first, and produces no decision if it reaches
 * for a work tool. That is not a budget being enforced, it is a round that cannot
 * succeed, and it failed a production task on the 60th call of a 60-turn budget:
 * `mode` was `open` because 59 < 60, the model called `repo_clone`, and both
 * slots died with `round produced no decision`.
 *
 * `mode` is the loop's own decision and the RPC is the only place it is visible,
 * which is why these specs read it off a recording agent rather than off the
 * outcome.
 */
describe("the last turn of the budget", () => {
  /** Records what each round was allowed to do, then answers. */
  function modeRecordingAgent() {
    const modes: RoundMode[] = [];
    const { stub } = fakeAgent();
    return {
      modes,
      stub: {
        ...stub,
        async runTaskTurn(input: { mode: RoundMode }) {
          modes.push(input.mode);
          return { status: "replied", reply: "the answer", turns: 1 };
        },
        // Round 0's cached verdict carries the spend; nothing is left to execute,
        // so the loop reaches the round these specs are about.
        async scanSubtasks() {
          return { canceled: false, ids: [] };
        }
      }
    };
  }

  const spentOn = (turns: number) =>
    fakeStep({
      cached: {
        "turn:0": { status: "delegated", turns },
        notify: undefined
      }
    });

  const budgetOf = (stub: unknown, maxTurns: number): HandleTaskDeps => ({
    ...deps(stub),
    config: resolveConfig({ model: TEST_MODELS, mainAgentLimits: { maxTurns } })
  });

  it("opens no round that cannot end", async () => {
    // Two turns of three are gone, so round 1 could spend exactly one step. It is
    // handed the answer instead of a budget it cannot use.
    const { modes, stub } = modeRecordingAgent();
    const { step } = spentOn(2);

    await runHandleTask(params(), step, budgetOf(stub, 3));

    expect(modes).toEqual(["final"]);
  });

  it("still opens a round with two turns to spend", async () => {
    // The other side of the boundary, and why this is not "stop a round early":
    // two turns is a lookup and an ending, which is an ordinary working round.
    const { modes, stub } = modeRecordingAgent();
    const { step } = spentOn(1);

    await runHandleTask(params(), step, budgetOf(stub, 3));

    expect(modes).toEqual(["open"]);
  });

  it("reserves the last turn at the incident's own arithmetic", async () => {
    // 59 turns spent of `maxTurns: 60` — the exact state round 13 entered, and
    // the one the old `turnsUsed >= maxTurns` test called `open`.
    const { modes, stub } = modeRecordingAgent();
    const { step } = spentOn(59);

    await runHandleTask(params(), step, budgetOf(stub, 60));

    expect(modes).toEqual(["final"]);
  });
});

describe("a Durable Object replaced under a running workflow", () => {
  /**
   * The incident these specs exist for.
   *
   * A deploy landed three minutes before a turn. The agent DO was collected 43
   * seconds into `executeSubtaskChunk`, and the five retries that followed each
   * failed in under 10ms across 160 seconds of backoff — then `fail:<id>`, the
   * handler that exists to salvage exactly this, failed six more times the same
   * way. The Subtask never reached a terminal row, `deliver` was never reached,
   * and the gatekeeper received no callback at all.
   *
   * Every one of those failures was a call on a stub the runtime had already
   * severed. A broken stub does not reconnect; it rejects with the reason it
   * broke, forever. So a run that resolves once and closes over the result has
   * retries that cannot retry — they re-enter the body and re-call a corpse.
   *
   * The delegated cases below matter most: `execute:<id>` and `fail:<id>` are
   * where this actually bit, they are the two deepest step bodies, and a stub
   * hoisted into `runBranch` alone would reproduce the whole incident while
   * every shallower spec still passed.
   */

  /**
   * Evict the agent DO *during* a named call, the way the runtime does.
   *
   * The eviction is a moment in time, not a property of a call site, so this
   * models both halves of it. The stub live at that moment is broken **for
   * good** — every later call on that same object rejects, which is what makes
   * a hoisted stub unrecoverable. Every stub resolved *afterwards* is healthy,
   * which is what makes resolving per step body the fix.
   */
  function evictOn(
    live: Record<string, (...a: never[]) => unknown>,
    on: string
  ) {
    let evicted = false;
    // Calls that hit a severed stub. The count is the point of these specs, not
    // bookkeeping: it is the only place a rejection is observable, since a
    // severed call never reaches the fake agent's own log.
    let rejected = 0;
    const severed = (): never => {
      rejected += 1;
      throw new Error("Durable Object reset because its code was updated.");
    };
    const resolveAgent = () => {
      if (evicted) return live as never;
      let broken = false;
      return Object.fromEntries(
        Object.keys(live).map((key) => [
          key,
          async (...args: never[]) => {
            if (broken) severed();
            if (key === on) {
              broken = true;
              evicted = true;
              severed();
            }
            return live[key](...args);
          }
        ])
      ) as never;
    };
    return { resolveAgent, rejections: () => rejected };
  }

  /** An agent that delegates one Subtask on round 0 and answers on round 1. */
  function delegatingAgent(options: { chunk?: () => unknown } = {}): {
    stub: Record<string, (...a: never[]) => unknown>;
    calls: string[];
  } {
    const calls: string[] = [];
    let round = 0;
    let done = false;
    const stub = {
      async markWorking() {
        calls.push("markWorking");
        return "ok";
      },
      async runTaskTurn() {
        calls.push("runTaskTurn");
        return round++ === 0
          ? { status: "delegated", turns: 1 }
          : { status: "replied", reply: "the answer", turns: 1 };
      },
      async scanSubtasks() {
        calls.push("scanSubtasks");
        // A completed row owes nothing, so it drops out of the scan — the same
        // filter the real `scanSubtasks` applies.
        return { canceled: false, ids: done ? [] : [8] };
      },
      async executeSubtaskChunk() {
        calls.push("executeSubtaskChunk");
        if (options.chunk) return options.chunk();
        done = true;
        return { done: true, status: "completed", progress: [] };
      },
      async failSubtask() {
        calls.push("failSubtask");
        done = true;
      },
      async cancelPendingSubtasks() {
        calls.push("cancelPendingSubtasks");
        return 0;
      },
      async saveTask() {
        calls.push("saveTask");
        return true;
      },
      async sweepTaskChildren() {
        calls.push("sweepTaskChildren");
      },
      async roundFailures() {
        calls.push("roundFailures");
        return [];
      }
    };
    return { stub, calls };
  }

  /** Round 1 answers from cache, so no spec here needs a model. */
  const delegatedRun = () => ({
    retries: 5,
    cached: {
      "turn:1": {
        status: "replied" as const,
        reply: "the answer",
        turns: 1
      },
      notify: undefined
    }
  });

  it("recovers the chunk that the eviction interrupted", async () => {
    // The production failure, exactly: the DO is collected mid
    // `executeSubtaskChunk`. The step's retry must reach a live object, run the
    // chunk, and let the branch finish — no `fail:<id>` at all.
    const { stub, calls } = delegatingAgent();
    const { step, ran } = fakeStep(delegatedRun());
    const evicted = evictOn(stub, "executeSubtaskChunk");

    await runHandleTask(params(), step, {
      ...deps(stub),
      resolveAgent: evicted.resolveAgent
    });

    // The eviction landed on the chunk, and the retry then ran it for real.
    expect(evicted.rejections()).toBe(1);
    expect(calls.filter((c) => c === "executeSubtaskChunk")).toHaveLength(1);
    expect(ran).not.toContain("fail:8");
    expect(ran).toContain("notify");
  });

  it("recovers the salvage step the eviction would otherwise take with it", async () => {
    // The second, worse half. The chunk fails deterministically, so `fail:<id>`
    // runs — and the eviction lands on *that*. This is the step whose only job
    // is to leave a terminal row behind, so a dead stub here is how a Subtask
    // ends up permanently non-terminal and the gatekeeper hears nothing.
    const { stub, calls } = delegatingAgent({
      chunk: () => {
        throw new Error("recipe exploded");
      }
    });
    const { step, ran } = fakeStep(delegatedRun());
    const evicted = evictOn(stub, "failSubtask");

    await runHandleTask(params(), step, {
      ...deps(stub),
      resolveAgent: evicted.resolveAgent
    });

    // The salvage was severed once and then actually recorded — the row reaches
    // a terminal status, which is the only reason the run gets to deliver.
    expect(evicted.rejections()).toBe(1);
    expect(calls.filter((c) => c === "failSubtask")).toHaveLength(1);
    expect(ran).toContain("fail:8");
    expect(ran).toContain("notify");
  });

  it("recovers a pre-work step too", async () => {
    // The shallowest case, kept for the boundary: `working` is the first body
    // to resolve, so it is the one that catches an eviction that happened
    // before the run started rather than during it.
    const { stub, calls } = fakeAgent();
    const { step, ran } = fakeStep({
      retries: 5,
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    const evicted = evictOn(stub, "markWorking");

    await runHandleTask(params(), step, {
      ...deps(stub),
      resolveAgent: evicted.resolveAgent
    });

    expect(evicted.rejections()).toBe(1);
    expect(calls.filter((c) => c === "markWorking")).toHaveLength(1);
    expect(ran).toContain("notify");
  });

  it("resolves per step body, not once per run", async () => {
    // The property itself, stated directly, across a delegated run so every
    // step body that touches the DO is counted — including the two inside
    // `runBranch`. A hoisted stub resolves once no matter how many steps run,
    // and that count is the whole difference between a retry that can recover
    // and one that cannot.
    const { stub } = delegatingAgent();
    let resolved = 0;
    const { step } = fakeStep(delegatedRun());

    await runHandleTask(params(), step, {
      ...deps(stub),
      resolveAgent: () => {
        resolved += 1;
        return stub as never;
      }
    });

    // working, turn:0, scan:0, execute:8, failures:0, complete, sweep.
    // `turn:1` and `notify` are served from cache; `started` and the two
    // `deadline:<round>` steps never touch the DO.
    expect(resolved).toBe(7);
  });
});

/**
 * The third bound on a Task, and the only one that measures progress.
 *
 * `maxTurns` and `maxWallMs` bound what a Task may *spend*, and a Task spending
 * it all on the same failing delegation is inside both of them the whole way. The
 * run this exists for delegated one subtask thirteen times over twelve minutes,
 * each branch failing with a byte-identical sentence, each round telling the user
 * work was underway — against a three-hour wall clock it never approached. What
 * ends it is not a smaller budget but a different question: did the last round
 * achieve anything the one before it did not.
 *
 * The stop is deliberately the *existing* forced-answer path, so the user gets
 * the model's own account of what went wrong rather than the failure copy.
 */
describe("a task that stops getting anywhere", () => {
  /**
   * An agent that delegates on every `open` round and answers when the loop makes
   * it, recording what each round was allowed to do and why.
   *
   * `failures` scripts what each round's branches came back with — the loop's
   * only window onto progress, and the whole input to the guard.
   */
  function stallingAgent(failures: (round: number) => string[]) {
    const rounds: { mode: RoundMode; finalReason?: FinalRoundReason }[] = [];
    const saved: unknown[] = [];
    let subtaskId = 0;
    const stub = {
      async markWorking() {
        return "ok";
      },
      async runTaskTurn(input: {
        mode: RoundMode;
        finalReason?: FinalRoundReason;
      }) {
        rounds.push({ mode: input.mode, finalReason: input.finalReason });
        return input.mode === "final"
          ? {
              status: "replied",
              reply: "I could not get this to run",
              turns: 1
            }
          : { status: "delegated", reply: "on it", turns: 1 };
      },
      async scanSubtasks() {
        // A fresh id per round, as SQLite would assign: `execute:<id>` is a
        // durable step name and two rounds must not share one.
        subtaskId += 1;
        return { canceled: false, ids: [subtaskId] };
      },
      async executeSubtaskChunk() {
        return { done: true, status: "failed", progress: [] };
      },
      async roundFailures(_taskId: string, round: number) {
        return failures(round);
      },
      async saveTask(task: unknown) {
        saved.push(task);
        return true;
      },
      async sweepTaskChildren() {},
      async cancelPendingSubtasks() {
        return 0;
      },
      async failSubtask() {}
    };
    return { rounds, saved, stub };
  }

  const WALL = ["general: there is no checkout in this workspace yet"];

  const budgetOf = (stub: unknown, maxTurns: number): HandleTaskDeps => ({
    ...deps(stub),
    config: resolveConfig({ model: TEST_MODELS, mainAgentLimits: { maxTurns } })
  });

  it("stops delegating once three rounds have failed identically", async () => {
    const { rounds, saved, stub } = stallingAgent(() => WALL);
    const { step } = fakeStep({ cached: { notify: undefined } });

    await runHandleTask(params(), step, deps(stub));

    // Three strikes, then the answer — with 16 turns of budget still unspent,
    // which is exactly the point: nothing here ran out.
    expect(rounds.map((r) => r.mode)).toEqual([
      "open",
      "open",
      "open",
      "final"
    ]);
    expect(rounds.at(-1)?.finalReason).toBe("no-progress");
    // And the user reads the model's own account, not the failure copy. A guard
    // that stopped the loop by failing the Task would have fixed the loop and
    // kept the part the user actually saw.
    expect(JSON.stringify(saved[0])).toContain("I could not get this to run");
    expect(JSON.stringify(saved[0])).not.toContain(policy.copy.taskFailed);
  });

  it("keeps delegating while the failures differ", async () => {
    // The half that keeps this a progress measure rather than a failure count: a
    // model reacting to a *new* error is a model still working the problem, and
    // stopping it would be the guard doing harm. Every round here fails; none
    // fails the same way, so what ends the Task is the budget, four rounds later
    // than the guard would have.
    const { rounds, stub } = stallingAgent((round) => [
      `general: attempt ${round} hit something new`
    ]);
    const { step } = fakeStep({ cached: { notify: undefined } });

    await runHandleTask(params(), step, budgetOf(stub, 8));

    expect(rounds.filter((r) => r.mode === "open")).toHaveLength(7);
    expect(rounds.at(-1)).toEqual({ mode: "final", finalReason: "budget" });
  });

  it("does not read two different failure lists as the same one", async () => {
    // A branch's failure is a facet's own sentence, newlines and all. Joined on
    // one, a single branch that failed with two lines is indistinguishable from
    // two branches that failed with one each — so a Task alternating between
    // those two shapes would be stopped as a repeat of itself, having reported
    // something different every round. The lists here are never equal; only
    // their concatenation is.
    const { rounds, stub } = stallingAgent((round) =>
      round % 2 === 0
        ? ["general: boom\ngeneral: bang"]
        : ["general: boom", "general: bang"]
    );
    const { step } = fakeStep({ cached: { notify: undefined } });

    await runHandleTask(params(), step, budgetOf(stub, 8));

    expect(rounds.filter((r) => r.mode === "open")).toHaveLength(7);
    expect(rounds.at(-1)).toEqual({ mode: "final", finalReason: "budget" });
  });

  it("resets the count on a round that completed something", async () => {
    // `roundFailures` is empty for any round that completed anything, so this is
    // the same wall interrupted by one productive round. Without the reset the
    // Task would stop on round 3 having just made progress.
    const { rounds, stub } = stallingAgent((round) =>
      round === 1 ? [] : WALL
    );
    const { step } = fakeStep({ cached: { notify: undefined } });

    await runHandleTask(params(), step, deps(stub));

    expect(rounds.map((r) => r.mode)).toEqual([
      "open",
      "open",
      "open",
      "open",
      "open",
      "final"
    ]);
    expect(rounds.at(-1)?.finalReason).toBe("no-progress");
  });

  it("counts from the durable step returns, not from a fresh read", async () => {
    // `mode` is a step input, so every value feeding it has to survive a replay.
    // The agent here reports no failures at all while the cached steps report the
    // wall three times: a loop reading the live rows would never stop, and one
    // reconstructing from its own recorded steps stops on round 3, as the run it
    // is replaying did.
    const { rounds, stub } = stallingAgent(() => []);
    const { step, ran } = fakeStep({
      cached: {
        "failures:0": WALL,
        "failures:1": WALL,
        "failures:2": WALL,
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(stub));

    expect(ran).toContain("failures:0");
    expect(rounds.at(-1)).toEqual({
      mode: "final",
      finalReason: "no-progress"
    });
  });
});

describe("a failed turn", () => {
  it("delivers the agent's own failure copy, never core's", async () => {
    // `taskFailed` is `RoundPolicy` copy — a user-facing string, so it is the
    // agent's. Core shipping a default here would be house prompt copy in a
    // published package.
    const { saved, spy } = savingAgent();
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "exhausted",
          error: "model exploded",
          turns: 1
        },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(spy));

    const task = saved[0] as { status: { message?: { parts?: unknown[] } } };
    expect(JSON.stringify(task)).toContain(policy.copy.taskFailed);
    // The diagnostic is logged, not shown: the user reads the policy string.
    expect(JSON.stringify(task)).not.toContain("model exploded");
  });

  /**
   * The kind is the whole reason `failed` carries one: a rejected credential
   * and an exhausted ladder deliver the same shape, and only the host's words
   * tell an operator which one happened and what to do about it.
   */
  it("delivers the host's copy for the kind that has one", async () => {
    const { saved, spy } = savingAgent();
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "gateway-credential",
          error: "401 Unauthorized",
          turns: 1
        },
        notify: undefined
      }
    });

    const seen: string[] = [];
    await runHandleTask(params(), step, {
      ...deps(spy),
      failureCopy: (kind) => {
        seen.push(kind);
        return "ROTATE THE AI GATEWAY TOKEN";
      }
    });

    expect(seen).toEqual(["gateway-credential"]);
    expect(JSON.stringify(saved[0])).toContain("ROTATE THE AI GATEWAY TOKEN");
    expect(JSON.stringify(saved[0])).not.toContain(policy.copy.taskFailed);
  });

  /**
   * The hook is now reached for *every* failure kind, which is the point of
   * merging the two statuses — but a host that has nothing to add for one of
   * them must still get the policy's copy rather than an empty message.
   */
  it("falls back to policy copy when the host declines the kind", async () => {
    const { saved, spy } = savingAgent();
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "exhausted",
          error: "model exploded",
          turns: 1
        },
        notify: undefined
      }
    });

    const seen: string[] = [];
    await runHandleTask(params(), step, {
      ...deps(spy),
      failureCopy: (kind) => {
        seen.push(kind);
        return undefined;
      }
    });

    // Called, and declined — not skipped. The host decides, core supplies the
    // floor.
    expect(seen).toEqual(["exhausted"]);
    expect(JSON.stringify(saved[0])).toContain(policy.copy.taskFailed);
  });
});

/**
 * A turn whose fault never stops being one.
 *
 * `step.do` retries a bounded number of times and then rethrows. Before this was
 * caught here, that unwound the orchestration, skipped the delivery entirely, and
 * left the Task in `working` while the runtime recorded a hang — observed in a
 * deployed agent on 2026-08-19. These specs pin the recovery, and in particular
 * the two halves of it that are easy to get backwards: it must **not** rethrow
 * when the delivery worked, and it **must** rethrow the original cause when it
 * did not.
 *
 * `markWorking` is the throwing step because it is the first one, so nothing else
 * has run and the assertions are about the recovery alone.
 */
function abandoningAgent(saveTask?: () => Promise<boolean>) {
  const saved: unknown[] = [];
  return {
    saved,
    stub: {
      async markWorking(): Promise<never> {
        throw new Error("the provider refused every attempt");
      },
      async saveTask(task: unknown) {
        saved.push(task);
        return saveTask ? await saveTask() : true;
      },
      async sweepTaskChildren() {}
    }
  };
}

/**
 * What the instance record says once the run is over.
 *
 * A turn that ends badly is a value, not a throw, so every step is `ok` and the
 * instance is `complete` — and a task whose every branch failed used to be
 * indistinguishable from one that went perfectly. That is what made the
 * 2026-09-05 incident cost a day of AI-Gateway archaeology: `wf claude-coder
 * turn-2tt667e2qlvda0ahuti` reported `success: true, error: null` over 59 `ok`
 * steps while the user was reading a failure message.
 *
 * The verdict is the return value because that is the one channel the platform
 * records for a run that finished: it lands on `InstanceStatus.output`.
 */
describe("the verdict a finished run returns", () => {
  it("tells a failed task apart from a successful one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const ok = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });
    const bad = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "exhausted",
          error: "model exploded",
          turns: 1
        },
        notify: undefined
      }
    });

    const replied = await runHandleTask(
      params(),
      ok.step,
      deps(fakeAgent().stub)
    );
    const failed = await runHandleTask(
      params(),
      bad.step,
      deps(fakeAgent().stub)
    );

    expect(replied).toEqual({ outcome: "replied", rounds: 1, turns: 1 });
    expect(failed).toEqual({
      outcome: "failed",
      kind: "exhausted",
      rounds: 1,
      turns: 1
    });
  });

  /**
   * The kind rides out for the same reason `failureCopy` receives one: an
   * exhausted ladder is a thing that happened to one request, and a rejected
   * credential is a thing an operator has to go and fix. A record that flattens
   * them tells nobody which.
   */
  it("carries the kind a credential failure ended on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "gateway-credential",
          error: "401 Unauthorized",
          turns: 1
        },
        notify: undefined
      }
    });

    const verdict = await runHandleTask(params(), step, deps(fakeAgent().stub));

    expect(verdict).toMatchObject({
      outcome: "failed",
      kind: "gateway-credential"
    });
  });

  /**
   * `cause` is whatever was thrown, and the verdict is the instance's `output`,
   * which has a 1 MiB ceiling. An unbounded diagnostic would fail a run while
   * serializing its record of having recovered — the one path written to stop a
   * silent failure, made into one.
   */
  it("caps a fault whose message is a whole response body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = {
      async markWorking(): Promise<never> {
        throw new Error("x".repeat(500_000));
      },
      async saveTask() {
        return true;
      },
      async sweepTaskChildren() {}
    };
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });

    const verdict = await runHandleTask(params(), step, deps(stub));

    expect(verdict.outcome).toBe("abandoned");
    const { error } = verdict as { error: string };
    expect(error.length).toBeLessThan(3_000);
    expect(error).toMatch(/truncated/);
  });

  it("reports a task canceled before the first round as having run none", async () => {
    const { stub } = fakeAgent({ markWorking: "canceled" });
    const { step } = fakeStep();

    await expect(runHandleTask(params(), step, deps(stub))).resolves.toEqual({
      outcome: "canceled",
      rounds: 0,
      turns: 0
    });
  });

  /**
   * The counts are the cheap half and the useful one: "thirteen rounds, sixty
   * turns" is the shape of the incident, readable off the record without opening
   * a single gateway log.
   */
  it("counts the rounds a task ran and the turns they spent", async () => {
    const stub = {
      async markWorking() {
        return "ok";
      },
      async runTaskTurn(input: { round: number }) {
        return input.round === 0
          ? { status: "delegated", reply: "on it", turns: 3 }
          : { status: "replied", reply: "the answer", turns: 2 };
      },
      async scanSubtasks() {
        return { canceled: false, ids: [1] };
      },
      async executeSubtaskChunk() {
        return { done: true, status: "completed", progress: [] };
      },
      async roundFailures() {
        return [];
      },
      async saveTask() {
        return true;
      },
      async sweepTaskChildren() {},
      async cancelPendingSubtasks() {
        return 0;
      },
      async failSubtask() {}
    };
    const { step } = fakeStep({ cached: { notify: undefined } });

    await expect(runHandleTask(params(), step, deps(stub))).resolves.toEqual({
      outcome: "replied",
      rounds: 2,
      turns: 5
    });
  });
});

/**
 * Whose loop it is, on every line — not only the abandoned one.
 *
 * The starter deploys five workflows onto one Worker and therefore one log
 * stream. `[handle-task]` was hard-coded, so a `claude-coder` failure was logged
 * under the name of a different agent: the tag does not filter, and it points at
 * the wrong place while it fails to.
 */
describe("the loop's log lines", () => {
  it("names the agent on a round failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "exhausted",
          error: "model exploded",
          turns: 1
        },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, {
      ...deps(fakeAgent().stub),
      label: "claude-coder"
    });

    expect(error).toHaveBeenCalledWith(
      "[claude-coder] round failed",
      expect.objectContaining({ taskId: "task-1", kind: "exhausted" })
    );
  });

  /**
   * A host that names nothing still logs something greppable. The fallback is
   * the old literal, so nothing that already parses these lines breaks.
   */
  it("falls back to the loop's own name when no label is given", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({
      cached: {
        "turn:0": {
          status: "failed",
          kind: "exhausted",
          error: "model exploded",
          turns: 1
        },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(fakeAgent().stub));

    expect(error).toHaveBeenCalledWith(
      "[handle-task] round failed",
      expect.anything()
    );
  });
});

describe("a task abandoned after its retries are exhausted", () => {
  it("delivers a failed Task carrying the policy's copy", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { saved, stub } = abandoningAgent();
    const { step, ran } = fakeStep({
      cached: { "abandoned:notify": undefined }
    });

    await runHandleTask(params(), step, deps(stub));

    expect(ran).toContain("abandoned:complete");
    expect(JSON.stringify(saved[0])).toContain(policy.copy.taskFailed);
    // The diagnostic is logged, never shown — same rule as an ordinary failure.
    expect(JSON.stringify(saved[0])).not.toContain("refused every attempt");
  });

  /**
   * The load-bearing half. Rethrowing here would reproduce the runtime's "your
   * Worker's code had hung and would never generate a response" record, which is
   * the misleading artefact this recovery exists to remove — and the instance has
   * genuinely finished its job by this point: the Task is terminal and the
   * gatekeeper has been told.
   */
  it("resolves once delivered, so the instance is not recorded as a hang", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = abandoningAgent();
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });

    // Resolving is the whole claim; the verdict is how the instance record still
    // says what happened, since a resolved run is a `complete` one.
    await expect(runHandleTask(params(), step, deps(stub))).resolves.toEqual({
      outcome: "abandoned",
      error: "Error: the provider refused every attempt"
    });
  });

  /**
   * The other half. Swallowing a failed delivery would mark the instance
   * successful while the user got nothing — worse than the erroring instance
   * this replaced, and silent in the Workflows console too. The *original* cause
   * is what an operator needs, not the delivery's secondary fault.
   */
  it("rethrows the original cause when the delivery itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });
    const stub = {
      async markWorking(): Promise<never> {
        throw new Error("the provider refused every attempt");
      },
      async saveTask(): Promise<never> {
        throw new Error("durable object unreachable");
      },
      async sweepTaskChildren() {}
    };

    await expect(runHandleTask(params(), step, deps(stub))).rejects.toThrow(
      "the provider refused every attempt"
    );
  });

  /**
   * The guarded write is still the cancellation check on this path. A user who
   * canceled while the retries were burning must not receive a `failed` callback
   * for the Task they abandoned.
   */
  it("does not notify when a cancel already won the write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = abandoningAgent(async () => false);
    const { step, ran } = fakeStep({
      cached: { "abandoned:notify": undefined }
    });

    const verdict = await runHandleTask(params(), step, deps(stub));

    expect(ran).toContain("abandoned:complete");
    expect(ran).not.toContain("abandoned:notify");
    // Nothing was abandoned *to anyone*: the user had already stopped listening.
    // `abandoned` here would report a failure that was never delivered.
    expect(verdict).toMatchObject({ outcome: "canceled" });
  });

  /**
   * Step names are durable cache keys, so this delivery runs in its own
   * namespace. Sharing the ordinary one would hand a second delivery the first's
   * cached `complete` — the failed Task would never be built, and the outcome
   * would depend on how Workflows caches a step whose failure was caught.
   */
  it("runs under its own step names, never the ordinary delivery's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = abandoningAgent();
    const { step, ran } = fakeStep({
      cached: { "abandoned:notify": undefined }
    });

    await runHandleTask(params(), step, deps(stub));

    expect(ran).toContain("abandoned:complete");
    expect(ran).not.toContain("complete");
    expect(ran).not.toContain("notify");
  });

  /**
   * Several agents share one Worker and therefore one log stream. Without the
   * label every one of them reports going quiet under the same name, which is
   * the moment an operator most needs to know which.
   */
  it("names the agent in the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = abandoningAgent();
    const { step } = fakeStep({ cached: { "abandoned:notify": undefined } });

    await runHandleTask(params(), step, {
      ...deps(stub),
      label: "claude-coder"
    });

    expect(error).toHaveBeenCalledWith(
      "[claude-coder] task abandoned after retries were exhausted",
      expect.objectContaining({ taskId: "task-1" })
    );
  });
});

/**
 * A turn that succeeded, whose callback did not.
 *
 * This is the case the recovery must **not** touch, and the first draft of it
 * did: `notify` exhausts its retries and throws after `complete` durably saved a
 * completed Task, the outer catch treats that as an abandoned turn, and a
 * generic failure is written over a real answer and posted to the gatekeeper. A
 * turn recorded as failed because a webhook was flaky.
 */
describe("a turn whose callback fails after the result was saved", () => {
  it("leaves the completed Task alone and rethrows the callback fault", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    error.mockClear();
    const saved: unknown[] = [];
    const { stub } = fakeAgent();
    const spy = {
      ...stub,
      async saveTask(task: unknown) {
        saved.push(task);
        return true;
      }
    };
    // `notify` is *not* cached, so it runs its body against an unreachable host
    // and throws — the real shape of a callback that never lands.
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 }
      }
    });

    await expect(runHandleTask(params(), step, deps(spy))).rejects.toThrow();

    // One write, and it is the completed one. A second would be the failure
    // this spec exists to prevent.
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved[0])).toContain("the answer");
    expect(ran).not.toContain("abandoned:complete");
    // And nothing claims the turn was abandoned, because it was not.
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining("task abandoned"),
      expect.anything()
    );
  });
});
