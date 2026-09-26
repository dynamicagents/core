import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import {
  createAgentHarness,
  TERMINAL_CALLBACK_STATES,
  type AgentHarness,
  type CapturedCallback
} from "../testing/harness.js";
import { buildInputRequiredTask } from "../a2a/hitl.js";
import { buildCompletedTask } from "../a2a/notify.js";
import { requireArtifactsStub } from "../artifacts/binding.js";
import { SESSION_TRANSCRIPT_KIND } from "../artifacts/transcript.js";
import worker, {
  COPY,
  type TaskDebug,
  type TestAgent,
  type TestEnv
} from "../../test/worker.js";

/**
 * The A2A lifecycle on Think, driven end to end through core's real edge.
 *
 * Every scenario goes in as a gatekeeper-signed `SendMessage` and comes out as
 * push callbacks. The object is read only for what a callback cannot carry:
 * the work ledger, and whether a sub-agent actually stopped.
 *
 * **One caller per spec.** An object runs its turns one at a time, so two specs
 * sharing one would serialize and see each other's callbacks.
 */

const testEnv = env as unknown as TestEnv;

function harnessFor(label: string, tenant?: string) {
  const key = `${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: testEnv,
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 },
    ...(tenant ? { tenant } : {})
  });
  const ns = tenant === "capped" ? testEnv.CAPPED_AGENT : testEnv.TEST_AGENT;
  const agent = ns.get(ns.idFromName(key));
  const debug = async (taskId: string): Promise<TaskDebug> =>
    JSON.parse(await agent.debugTask(taskId)) as TaskDebug;
  return { harness, agent, debug };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  read: () => Promise<T> | T,
  ok: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

function terminals(harness: AgentHarness, taskId: string): CapturedCallback[] {
  return harness.callbacks.filter(
    (c) => c.taskId === taskId && TERMINAL_CALLBACK_STATES.has(c.state)
  );
}

function working(harness: AgentHarness, taskId: string): string[] {
  return harness.callbacks
    .filter((c) => c.taskId === taskId && c.state === "TASK_STATE_WORKING")
    .map((c) => c.text);
}

function questionOf(callback: CapturedCallback): HitlRequestData {
  const body = callback.body as {
    task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
  };
  for (const part of body.task?.status?.message?.parts ?? []) {
    const data = part.data as HitlRequestData | undefined;
    if (data?.requestId) return data;
  }
  throw new Error("the input-required callback carried no question");
}

/** A `SendMessage` under a chosen `messageId`, as a gatekeeper retry sends it. */
async function sendAs(
  harness: AgentHarness,
  messageId: string,
  text: string
): Promise<string> {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: {
      tenant: "main",
      message: { messageId, role: "ROLE_USER", parts: [{ text }] },
      configuration: {
        taskPushNotificationConfig: { url: harness.pushUrl, token: "tok" }
      }
    }
  });
  const body = await res.json<{
    result?: { task?: { id: string } };
    error?: { message: string };
  }>();
  if (!body.result?.task?.id) throw new Error(JSON.stringify(body));
  return body.result.task.id;
}

async function cancel(harness: AgentHarness, taskId: string, tenant = "main") {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant, id: taskId }
  });
  const body = await res.json<{ error?: { message: string } }>();
  if (body.error) throw new Error(body.error.message);
}

/** The transcript entries a task's notes landed as. */
async function transcriptEntries(taskId: string): Promise<string[]> {
  const stub = requireArtifactsStub(testEnv);
  const token = await stub.tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
  if (!token) return [];
  const body = await (
    await stub.fetch(new Request(`https://agent.test/a/${token}/events`))
  ).text();
  return [...body.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]);
}

describe("the A2A lifecycle", () => {
  it("accepts a turn and calls back exactly once", async () => {
    const { harness, debug } = harnessFor("accept");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("echo:hello there");
    expect(String(accepted.status.state)).toContain("SUBMITTED");

    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("hello there");
    await pause(300);
    expect(terminals(harness, accepted.id)).toHaveLength(1);
    expect((await debug(accepted.id)).settledHooks).toEqual([
      TaskState.TASK_STATE_COMPLETED
    ]);
  });

  it("runs one turn for a redelivered messageId", async () => {
    const { harness } = harnessFor("redeliver");
    using _ = harness.interceptGatekeeper();

    const first = await sendAs(harness, "gk-m1", "echo:said once");
    const second = await sendAs(harness, "gk-m1", "echo:said once");
    expect(second).toBe(first);

    await harness.waitForTerminal(first);
    await pause(500);
    expect(terminals(harness, first)).toHaveLength(1);
  });

  it("fails a task when the turn errors", async () => {
    const { harness } = harnessFor("error");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("boom");
    const failed = await harness.waitForTerminal(accepted.id);
    expect(failed.state).toBe("TASK_STATE_FAILED");
    expect(failed.text).toBe(COPY.failed);
  });

  it("answers an RPC on a cold object", async () => {
    const { agent } = harnessFor("cold");
    await expect(agent.getTask("no-such-task")).resolves.toBeNull();
  });
});

describe("cancellation", () => {
  it("cancels a turn that is still running, and never calls back as done", async () => {
    const { harness, debug, agent } = harnessFor("cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("wait:20");
    await until(
      "the turn to start",
      () => debug(accepted.id),
      (d) => d.row?.state === "working"
    );
    await cancel(harness, accepted.id);
    await pause(1_000);

    const state = await debug(accepted.id);
    expect(state.row?.state).toBe("canceled");
    expect(state.settledHooks).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    // A replayed cancel answers with the task and stops nothing twice.
    expect(await agent.cancelTask(accepted.id)).not.toBeNull();
    expect((await debug(accepted.id)).settledHooks).toEqual([
      TaskState.TASK_STATE_CANCELED
    ]);
  });
});

describe("asking the caller", () => {
  it("parks on a question, and completes once it is answered", async () => {
    const { harness } = harnessFor("ask");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    const question = questionOf(parked);
    expect(question.prompt).toBe("which one?");
    expect(question.options?.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    await harness.answer(accepted.id, question.requestId, {
      optionId: question.options![0].id
    });
    const done = await harness.waitForTerminal(accepted.id);
    // The label the person saw, not the id the wire carried.
    expect(done.text).toBe("Yes");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("ignores a reply picking an option the question never offered", async () => {
    const { harness, debug } = harnessFor("bad-option");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    await harness.answer(accepted.id, questionOf(parked).requestId, {
      optionId: "option_9"
    });
    await pause(500);

    expect((await debug(accepted.id)).row?.state).toBe("input-required");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("ignores a typed reply to a question that takes only its options", async () => {
    const { harness, debug } = harnessFor("typed");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    await harness.answer(accepted.id, questionOf(parked).requestId, {
      text: "maybe"
    });
    await pause(500);

    expect((await debug(accepted.id)).row?.state).toBe("input-required");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("ignores a reply naming a question this task never asked", async () => {
    const { harness, debug } = harnessFor("foreign");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    await harness.waitForState(accepted.id, "TASK_STATE_INPUT_REQUIRED");
    await harness.answer(accepted.id, "another-question", { optionId: "x" });
    await pause(500);

    expect((await debug(accepted.id)).row?.state).toBe("input-required");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("fails a task whose question expired unanswered", async () => {
    const { harness } = harnessFor("expire");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("ask:which one?");
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    await harness.timeout(accepted.id, questionOf(parked).requestId);

    const failed = await harness.waitForTerminal(accepted.id);
    expect(failed.state).toBe("TASK_STATE_FAILED");
    expect(failed.text).toBe(COPY.questionExpired);
  });
});

describe("an awaited sub-agent", () => {
  it("answers with the child's result, and files its note once", async () => {
    const { harness, debug } = harnessFor("delegate");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("delegate:sleep:1");
    const done = await harness.waitForTerminal(accepted.id);
    // Think's own summary of the run: everything the child said.
    expect(done.text).toContain("child did: sleep:1");

    const state = await debug(accepted.id);
    expect(state.work).toEqual([
      expect.objectContaining({ kind: "awaited", open: false, settled: true })
    ]);
    expect(await transcriptEntries(accepted.id)).toEqual([
      "working on sleep:1"
    ]);
  });

  it("files a note the live path missed, from the replay", async () => {
    const { harness } = harnessFor("noprogress");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("delegate:sleep:1");
    await harness.waitForTerminal(accepted.id);
    await until(
      "the replayed note",
      () => transcriptEntries(accepted.id),
      (entries) => entries.length > 0
    );
    expect(await transcriptEntries(accepted.id)).toEqual([
      "working on sleep:1"
    ]);
  });

  it("is stopped when the task is canceled", async () => {
    const { harness, debug } = harnessFor("delegate-cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("delegate:sleep:20");
    await until(
      "the child to start",
      () => debug(accepted.id),
      (d) => d.runs.length === 1
    );
    await cancel(harness, accepted.id);
    await pause(2_000);

    const state = await debug(accepted.id);
    expect(state.row?.state).toBe("canceled");
    expect(state.runs[0].status).not.toBe("completed");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });
});

describe("a detached sub-agent", () => {
  it("keeps the task working until the run reports, then answers once", async () => {
    const { harness, debug } = harnessFor("bg");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:sleep:1");
    const done = await harness.waitForTerminal(accepted.id);

    // The sentence before the call, pushed as the call started.
    expect(working(harness, accepted.id)).toContain(
      "Started in the background."
    );
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("child did: sleep:1");
    await pause(300);
    expect(terminals(harness, accepted.id)).toHaveLength(1);

    const state = await debug(accepted.id);
    expect(state.work).toEqual([
      expect.objectContaining({ kind: "detached", open: false, settled: true })
    ]);
  });

  it("settles only once every run has reported", async () => {
    const { harness } = harnessFor("bg-two");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate2:sleep:1|sleep:4");
    await until(
      "the first run to report",
      () => working(harness, accepted.id),
      (texts) => texts.some((t) => t.includes("child did: sleep:1"))
    );
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    const done = await harness.waitForTerminal(accepted.id);
    expect(done.text).toContain("child did: sleep:4");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });

  it("is stopped with the task, and its late finish is ignored", async () => {
    const { harness, debug } = harnessFor("bg-cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:sleep:20");
    await until(
      "the run to start",
      () => debug(accepted.id),
      (d) => d.work.length === 1 && d.work[0].open
    );
    await cancel(harness, accepted.id);
    await pause(2_000);

    const state = await debug(accepted.id);
    expect(state.row?.state).toBe("canceled");
    expect(state.work[0].open).toBe(false);
    expect(state.runs[0].status).not.toBe("completed");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("starts nothing for a task canceled while it prepares, and releases what was prepared", async () => {
    const { harness, debug } = harnessFor("bg-prepare");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:slowprep");
    // Pushed as the tool call starts, so `prepare` is running.
    await harness.waitForState(accepted.id, "TASK_STATE_WORKING");
    await cancel(harness, accepted.id);

    const state = await until(
      "the prepared run to be released",
      () => debug(accepted.id),
      (d) => d.released.length === 1
    );
    expect(state.released[0].status).toBe("aborted");
    expect(state.work).toEqual([]);
    expect(state.row?.state).toBe("canceled");
  });

  it("does not leave the task open when the dispatch is refused", async () => {
    const { harness, debug } = harnessFor("capped", "capped");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:sleep:1");
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");

    const state = await debug(accepted.id);
    expect(state.work).toEqual([expect.objectContaining({ open: false })]);
  });

  it("follows up once for a soft interruption and then a result", async () => {
    const { harness, agent } = harnessFor("bg-soft");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();
    const run = {
      runId: "detached:soft",
      agentType: "TestBackground",
      status: "running" as const,
      displayOrder: 0,
      startedAt: Date.now()
    };

    await runInDurableObject(agent, async (instance: TestAgent) => {
      instance.ledger.accept({
        messageId: `m-${taskId}`,
        taskId,
        contextId: "c1",
        push: {
          taskId,
          contextId: "c1",
          pushUrl: harness.pushUrl,
          pushToken: "tok",
          jku: "https://agent.test/.well-known/jwks.json"
        },
        identity: { key: "k" }
      });
      instance.ledger.markWorking(taskId);
      instance.ledger.addWork({
        workId: run.runId,
        taskId,
        kind: "detached",
        name: "TestBackground"
      });

      await instance.onSubAgentFinish(run, {
        status: "interrupted",
        childStillRunning: true
      });
      expect(instance.ledger.openWork(taskId)).toBe(1);

      const result = { status: "completed" as const, summary: "late but real" };
      await instance.onSubAgentFinish(run, result);
      await instance.onSubAgentFinish(run, result);
    });

    const done = await harness.waitForTerminal(taskId);
    expect(done.text).toContain("late but real");
    await pause(500);
    expect(terminals(harness, taskId)).toHaveLength(1);
  });
});

describe("recovering what an eviction cut short", () => {
  /** A task accepted straight into the ledger, calling back to `harness`. */
  function seed(instance: TestAgent, harness: AgentHarness, taskId: string) {
    instance.ledger.accept({
      messageId: `m-${taskId}`,
      taskId,
      contextId: "c1",
      push: {
        taskId,
        contextId: "c1",
        pushUrl: harness.pushUrl,
        pushToken: "tok",
        jku: "https://agent.test/.well-known/jwks.json"
      },
      identity: { key: "k" }
    });
    instance.ledger.markWorking(taskId);
  }

  it("settles on the last of two results that landed before either follow-up ran", async () => {
    const { harness, agent } = harnessFor("follow-ups");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();

    await runInDurableObject(agent, async (instance: TestAgent) => {
      seed(instance, harness, taskId);
      for (const [workId, text] of [
        ["detached:one", "echo:first"],
        ["detached:two", "echo:second"]
      ]) {
        instance.ledger.addWork({
          workId,
          taskId,
          kind: "detached",
          name: "TestBackground"
        });
        instance.ledger.beginFollowUp(workId, { id: `finish:${workId}`, text });
      }
      await instance.submitFollowUp({ workId: "detached:one" });
      await instance.submitFollowUp({ workId: "detached:two" });
    });

    const done = await harness.waitForTerminal(taskId);
    expect(done.text).toBe("second");
    await pause(500);
    expect(terminals(harness, taskId)).toHaveLength(1);
  });

  it("sends the follow-up a closed work row still owes", async () => {
    const { harness, agent } = harnessFor("follow-up");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();

    await runInDurableObject(agent, async (instance: TestAgent) => {
      seed(instance, harness, taskId);
      instance.ledger.addWork({
        workId: "detached:cut",
        taskId,
        kind: "detached",
        name: "TestBackground"
      });
      // Closed, and the object gone before the submit.
      instance.ledger.beginFollowUp("detached:cut", {
        id: "finish:detached:cut",
        text: "echo:recovered"
      });
      expect(instance.ledger.pendingFollowUps()).toEqual(["detached:cut"]);
      // What the start-up sweep queues.
      await instance.submitFollowUp({ workId: "detached:cut" });
      await instance.submitFollowUp({ workId: "detached:cut" });
    });

    const done = await harness.waitForTerminal(taskId);
    expect(done.text).toBe("recovered");
    await pause(500);
    expect(terminals(harness, taskId)).toHaveLength(1);
  });

  it("submits the answer a resumed task still owes, once", async () => {
    const { harness, agent } = harnessFor("answer");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();
    const request: HitlRequestData = {
      type: HITL_REQUEST_TYPE,
      requestId: `${taskId}:call-1`,
      requestKind: "choice",
      prompt: "Which one?",
      allowFreeform: true
    };

    await runInDurableObject(agent, async (instance: TestAgent) => {
      seed(instance, harness, taskId);
      instance.ledger.park(
        buildInputRequiredTask(taskId, "c1", request),
        request
      );
      // Resumed, and the object gone before the submit.
      instance.ledger.resume(taskId, {
        id: "answer:cut",
        text: "echo:answered"
      });
      // The gatekeeper's retry, then what the start-up sweep queues.
      await instance.answerTask({
        taskId,
        messageId: "m-retry",
        reply: {
          kind: "answer",
          requestId: request.requestId,
          answer: { answeredBy: "spec", text: "again" }
        }
      });
      await instance.submitAnswer({ taskId });
    });

    const done = await harness.waitForTerminal(taskId);
    expect(done.text).toBe("answered");
    await pause(500);
    expect(terminals(harness, taskId)).toHaveLength(1);
  });

  it("runs the settle hooks a settled task still owes, once", async () => {
    const { harness, agent, debug } = harnessFor("hooks");
    const taskId = crypto.randomUUID();

    await runInDurableObject(agent, async (instance: TestAgent) => {
      seed(instance, harness, taskId);
      // Settled, and the object gone before the hooks ran.
      instance.ledger.settle(buildCompletedTask(taskId, "c1", "done"));
      expect(instance.ledger.pendingHooks()).toEqual([taskId]);
      await instance.runSettleHooks({ taskId });
      await instance.runSettleHooks({ taskId });
    });

    const state = await debug(taskId);
    expect(state.row?.hooksPending).toBe(false);
    expect(state.settledHooks).toEqual([TaskState.TASK_STATE_COMPLETED]);
  });
});

describe("check_back", () => {
  it("ends the turn, keeps the task open, and settles after the wake", async () => {
    const { harness, debug } = harnessFor("checkback");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("checkback:10");
    const waiting = await until(
      "the wait to be recorded",
      () => debug(accepted.id),
      (d) => d.work.length === 1
    );
    expect(waiting.work[0]).toEqual(
      expect.objectContaining({ kind: "wait", open: true })
    );
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    const done = await harness.waitForTerminal(accepted.id, {
      timeoutMs: 45_000
    });
    expect(done.text).toBe("Waited 10s: the build");
    expect(terminals(harness, accepted.id)).toHaveLength(1);
  });
});
