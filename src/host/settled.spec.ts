import { describe, it, expect } from "vitest";
// `env` from `cloudflare:workers`, not `cloudflare:test` — that one is
// deprecated and the type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import type { PlainTask } from "../a2a/task.js";
import { buildSubmittedTask, buildCompletedTask } from "../a2a/notify.js";
import type { SettleAgent } from "../../test/worker.js";

/**
 * `onTaskSettled`, against the code that fires it.
 *
 * The hook's whole contract is *when* it runs, and every clause of that is a
 * failure somebody would otherwise find in production: a settle that fires on a
 * write the database refused would release a container out from under a task
 * still running, and one that propagated a throw would turn a task that
 * completed into a call that failed.
 */

// Cast, as every spec here does: `worker-configuration.d.ts` is generated with
// `--include-env=false`, so this package's dev-only bindings are deliberately not
// on a global `Env` a consumer would inherit.
const ns = (env as unknown as { SETTLE_AGENT: DurableObjectNamespace })
  .SETTLE_AGENT;

function fresh(label: string) {
  return ns.get(ns.idFromName(`settled:${label}:${crypto.randomUUID()}`));
}

/** Drive the real `saveTask`, and read the recorder off the same instance. */
async function withAgent<R>(
  label: string,
  fn: (agent: SettleAgent) => Promise<R>
): Promise<R> {
  return runInDurableObject(fresh(label), (instance) =>
    fn(instance as unknown as SettleAgent)
  );
}

/** A task in a state `saveTask` will accept as an update to a submitted row. */
function terminal(taskId: string, state: TaskState): PlainTask {
  const task = buildCompletedTask(taskId, "ctx", "done");
  return { ...task, status: { ...task.status, state } };
}

describe("onTaskSettled", () => {
  it.each([
    ["completed", TaskState.TASK_STATE_COMPLETED],
    ["failed", TaskState.TASK_STATE_FAILED],
    ["rejected", TaskState.TASK_STATE_REJECTED]
  ])("fires once on %s, with the state it settled in", async (label, state) => {
    await withAgent(label, async (agent) => {
      await agent.saveTask(buildSubmittedTask("t1", "ctx"));
      expect(agent.settled).toEqual([]);

      expect(await agent.saveTask(terminal("t1", state))).toBe(true);
      expect(agent.settled).toEqual([{ taskId: "t1", state }]);
    });
  });

  it("fires on cancel too, and after the hook that stops the work", async () => {
    await withAgent("cancel", async (agent) => {
      await agent.saveTask(buildSubmittedTask("t2", "ctx"));
      await agent.cancelTask("t2");

      // Both ran, and `canceled` first: `onTaskCanceled` stops the work, so
      // there is nothing left holding what `onTaskSettled` releases.
      expect(agent.canceled).toEqual(["t2"]);
      expect(agent.settled).toEqual([
        { taskId: "t2", state: TaskState.TASK_STATE_CANCELED }
      ]);
    });
  });

  /**
   * The case a boolean alone cannot tell apart. `AgentDB` allows a terminal row to
   * be re-written with the *same* terminal state and reports success, because a
   * Workflow replay re-runs `complete` and its callback must still go out. A hook
   * keyed on that boolean would release the same resource once per replay.
   */
  it("fires once across a replay that re-saves the same terminal state", async () => {
    await withAgent("replay", async (agent) => {
      await agent.saveTask(buildSubmittedTask("t6", "ctx"));
      const done = terminal("t6", TaskState.TASK_STATE_COMPLETED);

      expect(await agent.saveTask(done)).toBe(true);
      // The replay still succeeds — suppressing it would suppress the callback.
      expect(await agent.saveTask(done)).toBe(true);

      expect(agent.settled).toEqual([
        { taskId: "t6", state: TaskState.TASK_STATE_COMPLETED }
      ]);
    });
  });

  it("fires once when a cancel is recorded twice", async () => {
    await withAgent("recancel", async (agent) => {
      await agent.saveTask(buildSubmittedTask("t7", "ctx"));
      await agent.cancelTask("t7");
      await agent.cancelTask("t7");

      expect(agent.settled).toEqual([
        { taskId: "t7", state: TaskState.TASK_STATE_CANCELED }
      ]);
    });
  });

  it("does not fire when the guarded write is refused", async () => {
    await withAgent("refused", async (agent) => {
      await agent.saveTask(buildSubmittedTask("t3", "ctx"));
      await agent.cancelTask("t3");
      agent.settled.length = 0;

      // A terminal write over a `canceled` row is exactly the race the boolean
      // exists for. Nothing settled here, so nothing may be released.
      expect(
        await agent.saveTask(terminal("t3", TaskState.TASK_STATE_COMPLETED))
      ).toBe(false);
      expect(agent.settled).toEqual([]);
    });
  });

  it("does not fire on a non-terminal state", async () => {
    await withAgent("working", async (agent) => {
      await agent.saveTask(buildSubmittedTask("t4", "ctx"));
      expect(agent.settled).toEqual([]);
    });
  });

  it("survives a throwing override without changing the write's answer", async () => {
    await withAgent("throws", async (agent) => {
      agent.throwOnSettle = true;
      await agent.saveTask(buildSubmittedTask("t5", "ctx"));

      // The row is already durable when the hook runs, so a teardown failure
      // must not be reported as a failed save — that boolean is a cancellation
      // answer, not a cleanup one.
      expect(
        await agent.saveTask(terminal("t5", TaskState.TASK_STATE_COMPLETED))
      ).toBe(true);
      expect(agent.settled).toHaveLength(1);
    });
  });
});
