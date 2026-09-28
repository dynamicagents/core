import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  introspectWorkflowInstance,
  runInDurableObject
} from "cloudflare:test";
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
import { TaskState } from "@a2a-js/sdk";
import { buildFailedTask } from "../a2a/notify.js";
import { TEST_TENANT } from "../testing/auth.js";
import worker, {
  COPY,
  type JobDebug,
  type StepReportDebug,
  type TaskDebug,
  type TestEnv,
  type TestHost
} from "../../test/worker.js";
import type { StepJob, TaskParams, TaskResult } from "./types.js";

/**
 * The task workflow, end to end through core's real edge: a signed
 * `SendMessage` to the host, one workflow instance per task, step jobs on the
 * test agents, push callbacks out.
 *
 * One caller per spec, as in `src/agent/agent.spec.ts`: the host and every
 * step agent are the caller's, and two specs sharing them would serialize.
 */

const testEnv = env as unknown as TestEnv;

function setup(label: string) {
  const key = `${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: testEnv,
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
  });
  const host = testEnv.TEST_HOST.get(testEnv.TEST_HOST.idFromName(key));
  const agent = testEnv.TEST_AGENT.get(testEnv.TEST_AGENT.idFromName(key));
  const agentB = testEnv.TEST_STEP_B.get(testEnv.TEST_STEP_B.idFromName(key));
  const reports = async (stub = agent): Promise<StepReportDebug[]> =>
    JSON.parse(await stub.debugStepJobs()) as StepReportDebug[];
  const debug = async (stepJobId: string, stub = agent): Promise<JobDebug> =>
    JSON.parse(await stub.debugJob(stepJobId)) as JobDebug;
  const settled = async (taskId: string, stub = agent): Promise<number[]> =>
    JSON.parse(await stub.debugSettled(taskId)) as number[];
  const hostDebug = async (taskId: string): Promise<TaskDebug> =>
    JSON.parse(await host.debugTask(taskId)) as TaskDebug;
  return {
    key,
    harness,
    host,
    agent,
    agentB,
    reports,
    debug,
    settled,
    hostDebug
  };
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

async function lastQuestion(
  harness: AgentHarness,
  taskId: string,
  count = 1
): Promise<HitlRequestData> {
  const asked = await until(
    `question ${count}`,
    () =>
      harness.callbacks.filter(
        (c) => c.taskId === taskId && c.state === "TASK_STATE_INPUT_REQUIRED"
      ),
    (c) => c.length >= count
  );
  return questionOf(asked[asked.length - 1]);
}

async function status(taskId: string) {
  return (await testEnv.TEST_TASK.get(taskId)).status();
}

async function cancel(harness: AgentHarness, taskId: string) {
  const res = await harness.rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "CancelTask",
    params: { tenant: TEST_TENANT, id: taskId }
  });
  const body = await res.json<{ error?: { message: string } }>();
  if (body.error) throw new Error(body.error.message);
}

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
      tenant: TEST_TENANT,
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

async function trackedCount(key: string, taskId: string): Promise<number> {
  const host = testEnv.TEST_HOST.get(testEnv.TEST_HOST.idFromName(key));
  return runInDurableObject(host, (instance) => {
    return (
      instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM cf_agents_workflows
        WHERE workflow_id = ${taskId}`[0]?.n ?? 0
    );
  });
}

describe("G0: the base class owns run()", () => {
  it("refuses a pipeline that inherits run(), naming it", async () => {
    const id = `norun-${crypto.randomUUID()}`;
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_BAD_TASK,
      id
    );
    await testEnv.TEST_BAD_TASK.create({ id, params: {} as TaskParams });
    await instance.waitForStatus("errored");
    const error = await instance.getError();
    expect(error.message).toContain("NoRunTask must declare run()");
  });

  it("gives a pipeline that declares run() its host and its helpers", async () => {
    const { harness } = setup("g0");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:hello");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("hello");
  });
});

describe("G1: the edge → the host → the workflow", () => {
  it("makes one instance per task, id = task id, and reports its verdict", async () => {
    const { harness } = setup("g1-one");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:one");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_TASK,
      task.id
    );
    await harness.waitForTerminal(task.id);
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as TaskResult;
    expect(output).toEqual({
      reply: "one",
      verdict: { outcome: "replied", steps: ["main"] }
    });
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("starts nothing for a redelivered messageId", async () => {
    const { key, harness } = setup("g1-redeliver");
    using _ = harness.interceptGatekeeper();
    const messageId = crypto.randomUUID();
    const first = await sendAs(harness, messageId, "echo:once");
    const second = await sendAs(harness, messageId, "echo:once");
    expect(second).toBe(first);
    await harness.waitForTerminal(first);
    expect(await trackedCount(key, first)).toBe(1);
    await pause(300);
    expect(terminals(harness, first)).toHaveLength(1);
  });

  /**
   * A start cut short at each boundary, then the redelivery that finishes it.
   * Seeded rather than crashed: a real eviction is G6's, under `wrangler dev`.
   */
  for (const boundary of ["row", "create", "tracking"] as const) {
    it(`recovers from a start cut after the ${boundary}, to one instance`, async () => {
      const { key, harness, host } = setup(`g1-${boundary}`);
      using _ = harness.interceptGatekeeper();
      const messageId = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      const turn = {
        messageId,
        taskId,
        contextId: crypto.randomUUID(),
        text: `echo:after ${boundary}`,
        identity: {
          key,
          name: "Spec Caller",
          kind: "custom" as const,
          workspaceId: 1
        },
        pushUrl: harness.pushUrl,
        pushToken: "tok",
        jku: "https://agent.test/.well-known/jwks.json"
      };
      await runInDurableObject(host, async (instance) => {
        instance.ledger.accept({
          messageId,
          taskId,
          contextId: turn.contextId,
          push: {
            taskId,
            contextId: turn.contextId,
            pushUrl: turn.pushUrl,
            pushToken: turn.pushToken,
            jku: turn.jku
          },
          identity: turn.identity
        });
        const params: TaskParams = {
          taskId,
          contextId: turn.contextId,
          messageId,
          text: turn.text,
          identity: turn.identity,
          callerKey: key,
          caller: "",
          jku: turn.jku,
          hostBinding: "TEST_HOST"
        };
        instance.runs.record(params);
        if (boundary === "create") {
          await testEnv.TEST_TASK.create({
            id: taskId,
            params: {
              ...params,
              __agentName: key,
              __agentBinding: "TEST_HOST",
              __workflowName: "TEST_TASK",
              __agentOrigin: {
                kind: "agent",
                version: 1,
                binding: "TEST_HOST",
                name: key
              }
            } as unknown as TaskParams
          });
        }
        if (boundary === "tracking") {
          await instance.runWorkflow("TEST_TASK", params, {
            id: taskId,
            agentBinding: "TEST_HOST"
          });
        }
      });
      await host.acceptTask(turn);
      const done = await harness.waitForTerminal(taskId);
      expect(done.text).toBe(`after ${boundary}`);
      expect((await status(taskId)).status).toBe("complete");
      expect(await trackedCount(key, taskId)).toBe(1);
      await pause(300);
      expect(terminals(harness, taskId)).toHaveLength(1);
    });
  }

  it("settles a task whose completion report never arrived, on the next read", async () => {
    const { harness } = setup("g1-reconcile");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:lost:the report");
    await until(
      "complete",
      () => status(task.id),
      (s) => s.status === "complete"
    );
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(0);
    const res = await harness.rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "GetTask",
      params: { tenant: TEST_TENANT, id: task.id }
    });
    expect(res.ok).toBe(true);
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("lost:the report");
  });

  it("fails a pipeline that throws, in this deployment's words", async () => {
    const { harness } = setup("g1-throw");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("throw");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(COPY.failed);
    expect((await status(task.id)).status).toBe("errored");
  });
});

describe("G2: a pipeline of different agents", () => {
  it("runs a step on each of two namespaces, feeding one to the next", async () => {
    const { harness, agentB, reports } = setup("g2");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("two:hello");
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("B saw hello");
    const output = (await status(task.id)).output as TaskResult;
    expect(output.verdict.steps).toEqual(["first", "second"]);
    expect((await reports()).map((r) => r.stepJobId)).toEqual([
      `${task.id}:first`
    ]);
    expect((await reports(agentB)).map((r) => r.stepJobId)).toEqual([
      `${task.id}:second`
    ]);
  });

  it("returns from the start step while the job is still working", async () => {
    const { harness } = setup("g2-start");
    using _ = harness.interceptGatekeeper();
    const sent = Date.now();
    const task = await harness.send("wait:3");
    await using instance = await introspectWorkflowInstance(
      testEnv.TEST_TASK,
      task.id
    );
    await instance.waitForStepResult({ name: "agent:main:start" });
    const started = Date.now() - sent;
    await harness.waitForTerminal(task.id);
    const finished = Date.now() - sent;
    expect(started).toBeLessThan(2_500);
    expect(finished).toBeGreaterThanOrEqual(3_000);
  });
});

describe("G3: a job that spans turns", () => {
  it("stays open across its background run's follow-up, and reports once", async () => {
    const { harness, reports } = setup("g3");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("bgdelegate:sleep:1");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("child did: sleep:1");
    expect(working(harness, task.id)).toContain("Started in the background.");
    const sent = await reports();
    expect(sent.map((r) => r.report.state)).toEqual(["completed"]);
    expect(sent.every((r) => r.sent)).toBe(true);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });
});

describe("G4: a step agent's question", () => {
  it("relays the job's ask_user through the host, and completes on the answer", async () => {
    const { harness, reports } = setup("g4");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:which one?");
    const question = await lastQuestion(harness, task.id);
    expect(question.type).toBe(HITL_REQUEST_TYPE);
    expect(question.prompt).toBe("which one?");
    await harness.answer(task.id, question.requestId, { optionId: "option_1" });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("Yes");
    expect((await reports()).map((r) => r.report.state)).toEqual([
      "input-required",
      "completed"
    ]);
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });
});

describe("G5: stopping", () => {
  it("cancels mid-job: instance terminated, job stopped and kept, no callback", async () => {
    const { harness, agent, debug, settled } = setup("g5-job");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("bgdelegate:sleep:30");
    await harness.waitForState(task.id, "TASK_STATE_WORKING");
    const stepJobId = `${task.id}:main`;
    await until(
      "the background run",
      () => debug(stepJobId),
      (d) => d.work.some((w) => w.kind === "detached" && w.open)
    );
    await cancel(harness, task.id);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    const job = await until(
      "the job canceled",
      () => debug(stepJobId),
      (d) => d.row?.state === "canceled"
    );
    expect(job.work.every((w) => !w.open)).toBe(true);
    // Kept: the job's row and its conversation are still there.
    const messages = await runInDurableObject(
      agent,
      async (a) => (await a.getMessages()).length
    );
    expect(messages).toBeGreaterThan(0);
    // The end-of-task notice reached the agent that ran the job.
    await until(
      "the notice",
      () => settled(task.id),
      (states) => states.length === 1
    );
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(0);
  });

  it("cancels a task parked on its job's question", async () => {
    const { harness, debug } = setup("g5-question");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:still there?");
    await lastQuestion(harness, task.id);
    await cancel(harness, task.id);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    await until(
      "the job canceled",
      () => debug(`${task.id}:main`),
      (d) => d.row?.state === "canceled"
    );
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(0);
  });

  it("expires a question: the task fails in its words, and the run stops", async () => {
    const { harness, debug } = setup("g5-expiry");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:anyone?");
    const question = await lastQuestion(harness, task.id);
    await harness.timeout(task.id, question.requestId);
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(COPY.questionExpired);
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    await until(
      "the job canceled",
      () => debug(`${task.id}:main`),
      (d) => d.row?.state === "canceled"
    );
  });

  it("starts nothing for a job stopped before its start arrived", async () => {
    const { key, agent, debug } = setup("g5-race");
    const stepJobId = `race-${crypto.randomUUID()}:main`;
    await agent.cancelStepJob(stepJobId);
    const job: StepJob = {
      stepJobId,
      taskId: crypto.randomUUID(),
      contextId: "ctx",
      input: "echo:should not run",
      attempt: 1,
      caller: "",
      identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 },
      jku: "https://agent.test/.well-known/jwks.json",
      workflow: { name: "TEST_TASK", id: "none" },
      host: { binding: "TEST_HOST", name: key }
    };
    await agent.startStepJob(job);
    await pause(500);
    const row = await debug(stepJobId);
    expect(row.row?.state).toBe("canceled");
    const submissions = await runInDurableObject(
      agent,
      (a) =>
        a.sql<{ n: number }>`SELECT COUNT(*) AS n FROM cf_think_submissions`[0]
          ?.n ?? 0
    );
    expect(submissions).toBe(0);
  });

  it("drops a report whose instance has ended", async () => {
    const { key, agent, reports } = setup("g5-drop");
    // An instance for a task no host holds: its first step is refused, and it errors.
    const instanceId = crypto.randomUUID();
    await testEnv.TEST_TASK.create({
      id: instanceId,
      params: {
        taskId: instanceId,
        contextId: "ctx",
        messageId: "m",
        text: "echo:x",
        identity: { key },
        callerKey: key,
        caller: "",
        jku: "https://agent.test/.well-known/jwks.json",
        hostBinding: "TEST_HOST",
        __agentName: key,
        __agentBinding: "TEST_HOST",
        __workflowName: "TEST_TASK"
      } as unknown as TaskParams
    });
    await until(
      "errored",
      () => status(instanceId),
      (s) => s.status === "errored"
    );
    await agent.startStepJob({
      stepJobId: `${instanceId}:orphan`,
      taskId: instanceId,
      contextId: "ctx",
      input: "echo:orphaned",
      attempt: 1,
      caller: "",
      identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 },
      jku: "https://agent.test/.well-known/jwks.json",
      workflow: { name: "TEST_TASK", id: instanceId },
      host: { binding: "TEST_HOST", name: key }
    });
    const sent = await until(
      "the report dropped",
      () => reports(),
      (r) => r.some((x) => x.stepJobId === `${instanceId}:orphan` && x.sent)
    );
    expect(
      sent.find((x) => x.stepJobId === `${instanceId}:orphan`)?.report.state
    ).toBe("completed");
  });
});

describe("a failed step is retried once", () => {
  it("runs the step again, told it is a retry, and completes", async () => {
    const { harness } = setup("retry");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("flaky");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("recovered");
    const output = (await status(task.id)).output as TaskResult;
    expect(output.verdict.steps).toEqual(["main", "main:retry"]);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("fails the task when the retry fails too", async () => {
    const { harness } = setup("retry-fails");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("broken");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(COPY.failed);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });
});

describe("G9 in miniature: the approval loop", () => {
  it("replans on a rejection's feedback, then acts once approved", async () => {
    const { harness } = setup("g9");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("approve:the thing");

    const first = await lastQuestion(harness, task.id, 1);
    expect(first.requestKind).toBe("approval");
    expect(first.prompt).toBe("plan 0 for the thing");
    await harness.answer(task.id, first.requestId, {
      optionId: "reject",
      text: "smaller"
    });

    const second = await lastQuestion(harness, task.id, 2);
    expect(second.prompt).toBe("plan 1 for the thing (smaller)");
    expect(working(harness, task.id)).toContain("Replanning.");
    await harness.answer(task.id, second.requestId, { optionId: "approve" });

    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("did plan 1 for the thing (smaller)");
    const output = (await status(task.id)).output as TaskResult;
    expect(output.verdict.steps).toHaveLength(5);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });
});

describe("attribution and role", () => {
  it("gives a job's turn the A2A task id, its job id and its role", async () => {
    const { harness } = setup("whoami");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("whoami");
    const done = await harness.waitForTerminal(task.id);
    expect(JSON.parse(done.text)).toEqual({
      taskId: task.id,
      stepJobId: `${task.id}:main`,
      role: null
    });
  });

  it("hands a job's role to its turn", async () => {
    const { harness } = setup("role");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("role:plan:whoami");
    const done = await harness.waitForTerminal(task.id);
    expect(JSON.parse(done.text)).toMatchObject({ role: "plan" });
  });

  it("pushes a step's say line once", async () => {
    const { harness } = setup("say");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("say:echo:hi");
    await harness.waitForTerminal(task.id);
    expect(
      working(harness, task.id).filter((t) => t === "echo:hi")
    ).toHaveLength(1);
  });
});

describe("the host's own bookkeeping", () => {
  it("runs the settle hooks a settled task still owes, once", async () => {
    const { harness, host, hostDebug } = setup("hooks");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();

    await runInDurableObject(host, async (instance) => {
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
      // Settled, and the host gone before the hooks ran.
      instance.ledger.settle(buildFailedTask(taskId, "c1", "no"));
      expect(instance.ledger.pendingHooks()).toEqual([taskId]);
      await instance.runSettleHooks({ taskId });
      await instance.runSettleHooks({ taskId });
    });

    const state = await hostDebug(taskId);
    expect(state.row?.hooksPending).toBe(false);
    expect(state.settledHooks).toEqual([TaskState.TASK_STATE_FAILED]);
  });

  it("stops the run an expiry cut short still owes", async () => {
    const { harness, host, hostDebug, debug } = setup("stop-owed");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:still there?");
    await lastQuestion(harness, task.id);

    await runInDurableObject(host, async (instance) => {
      // The expiry's guarded write, and the host gone before the stop.
      const failed = buildFailedTask(
        task.id,
        task.contextId,
        COPY.questionExpired
      );
      expect(instance.ledger.settle(failed, { stop: true })).toBe(true);
      await instance.runSettleHooks({ taskId: task.id });
    });

    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    await until(
      "the job canceled",
      () => debug(`${task.id}:main`),
      (d) => d.row?.state === "canceled"
    );
    expect((await hostDebug(task.id)).row?.stopPending).toBe(false);
  });

  it("fails a task whose instance was stopped from outside, on the next read", async () => {
    const { harness } = setup("terminated");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:still there?");
    await lastQuestion(harness, task.id);

    await (await testEnv.TEST_TASK.get(task.id)).terminate();
    await until(
      "terminated",
      () => status(task.id),
      (s) => s.status === "terminated"
    );
    await harness.rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "GetTask",
      params: { tenant: TEST_TENANT, id: task.id }
    });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(COPY.failed);
  });

  it("reconciles and sweeps in its weekly retention", async () => {
    const { harness, host } = setup("retention");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("echo:lost:swept");
    await until(
      "complete",
      () => status(task.id),
      (s) => s.status === "complete"
    );
    expect(terminals(harness, task.id)).toHaveLength(0);

    await host.retainTasks();
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("lost:swept");

    await runInDurableObject(host, async (instance) => {
      // Past the window: everything the host held for the task goes.
      instance.sql`UPDATE da_a2a_tasks SET created_at = 0`;
      await instance.retainTasks();
      expect(instance.ledger.row(task.id)).toBeNull();
      expect(instance.runs.params(task.id)).toBeNull();
      expect(instance.runs.jobs(task.id)).toEqual([]);
    });
  });

  it("relays an answer an earlier call left owed, before anything else", async () => {
    const { harness, host } = setup("owed-answer");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:which one?");
    const question = await lastQuestion(harness, task.id);

    await runInDurableObject(host, async (instance) => {
      // Resumed, and the host gone before the relay — and before the guard
      // against asking again was written.
      instance.ledger.resume(task.id, {
        id: "answer:cut",
        requestId: question.requestId,
        optionId: "option_1"
      });
      expect(instance.runs.wasAnswered(question.requestId)).toBe(false);
      // The gatekeeper's retry.
      await instance.answerTask({
        taskId: task.id,
        messageId: "m-retry",
        reply: {
          kind: "answer",
          requestId: question.requestId,
          answer: { answeredBy: "spec", optionId: "option_1" }
        }
      });
    });

    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("Yes");
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
    // The relay wrote the guard the eviction cut.
    expect(
      await runInDurableObject(host, (instance) =>
        instance.runs.wasAnswered(question.requestId)
      )
    ).toBe(true);
  });

  function acceptInto(instance: TestHost, pushUrl: string, taskId: string) {
    instance.ledger.accept({
      messageId: `m-${taskId}`,
      taskId,
      contextId: "c1",
      push: {
        taskId,
        contextId: "c1",
        pushUrl,
        pushToken: "tok",
        jku: "https://agent.test/.well-known/jwks.json"
      },
      identity: { key: "k" }
    });
  }

  it("owes a stop until every part of it has held", async () => {
    const { harness, host } = setup("stop-kept");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();

    await runInDurableObject(host, async (instance) => {
      acceptInto(instance, harness.pushUrl, taskId);
      // A job on an agent the host cannot reach: its stop fails.
      instance.runs.note(taskId, {
        stepJobId: `${taskId}:main`,
        binding: "NO_SUCH_AGENT"
      });
      instance.ledger.cancel(taskId);
      await expect(instance.finishStop({ taskId })).rejects.toThrow(
        "not stopped yet"
      );
      expect(instance.ledger.row(taskId)?.stopPending).toBe(true);
      expect(instance.ledger.pendingStops()).toEqual([taskId]);
    });
  });

  it("keeps a bound task's stop owed while its instance cannot be read", async () => {
    const { harness, host } = setup("stop-unread");
    const taskId = crypto.randomUUID();

    await runInDurableObject(host, async (instance) => {
      acceptInto(instance, harness.pushUrl, taskId);
      instance.ledger.bind(taskId);
      instance.ledger.cancel(taskId);
      // The terminate fails, and so does the read that would explain it.
      Object.defineProperty(instance, "workflowBinding", {
        value: "NO_SUCH_WORKFLOW"
      });
      await expect(instance.finishStop({ taskId })).rejects.toThrow(
        "not stopped yet"
      );
      expect(instance.ledger.row(taskId)?.stopPending).toBe(true);
    });
  });
});

describe("a pipeline's own guards", () => {
  it("stops a job its task no longer waits for, keeping its work", async () => {
    const { harness, debug } = setup("orphan");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("orphan:wait:20");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    expect(done.text).toBe(COPY.failed);
    await until(
      "the orphaned job stopped",
      () => debug(`${task.id}:main`),
      (d) => d.row?.state === "canceled"
    );
  });

  it("refuses a label run twice, by name", async () => {
    const { harness } = setup("twice");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("twice:");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    const { error } = await status(task.id);
    expect(error?.message).toContain('step "agent:main" ran twice');
  });
});
