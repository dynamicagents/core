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
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
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
import { nextWait } from "./workflow.js";

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

/** What the agent said while it worked: the progress lines, without questions. */
function working(harness: AgentHarness, taskId: string): string[] {
  return harness.callbacks
    .filter(
      (c) =>
        c.taskId === taskId &&
        c.state === "TASK_STATE_WORKING" &&
        !questionIn(c) &&
        c.text
    )
    .map((c) => c.text);
}

/** The question a callback carries, on whatever status it rides. */
function questionIn(callback: CapturedCallback): HitlRequestData | null {
  const body = callback.body as {
    task?: { status?: { message?: { parts?: { data?: unknown }[] } } };
    statusUpdate?: { status?: { message?: { parts?: { data?: unknown }[] } } };
  };
  const parts =
    body.task?.status?.message?.parts ??
    body.statusUpdate?.status?.message?.parts ??
    [];
  for (const part of parts) {
    const data = part.data as HitlRequestData | undefined;
    if (data?.requestId) return data;
  }
  return null;
}

/** Every question a task asked, in the order they went out. */
function questionsOf(harness: AgentHarness, taskId: string): HitlRequestData[] {
  const seen = new Map<string, HitlRequestData>();
  for (const c of harness.callbacks) {
    const q = c.taskId === taskId ? questionIn(c) : null;
    if (q && !seen.has(q.requestId)) seen.set(q.requestId, q);
  }
  return [...seen.values()];
}

async function lastQuestion(
  harness: AgentHarness,
  taskId: string,
  count = 1
): Promise<HitlRequestData> {
  const asked = await until(
    `question ${count}`,
    () => questionsOf(harness, taskId),
    (q) => q.length >= count
  );
  return asked[count - 1];
}

/** The kinds of every report a job owes or sent, in order. */
function kinds(reports: StepReportDebug[], stepJobId?: string): string[] {
  return reports
    .filter((r) => stepJobId === undefined || r.stepJobId === stepJobId)
    .map((r) => r.report.kind);
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
      // Never two, which is what a double start would leave, and which of zero
      // or one says where the cut fell. `runWorkflow` is `create` then the
      // tracking insert: before `create` the retry runs both; between them it
      // leaves an instance for the retry's `create` to reject as
      // `instance.already_exists`, so the insert is never reached; after it the
      // retry adopts the row that attempt already wrote. Adoption is why `1`
      // here is not core's row in the last case.
      const tracked = { row: 1, create: 0, tracking: 1 } as const;
      expect(await trackedCount(key, taskId)).toBe(tracked[boundary]);
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
    // Idle once the follow-up ran, and finished on the workflow's word.
    expect(kinds(sent)).toEqual(["idle"]);
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
    expect(question.questions[0]?.prompt).toBe("which one?");
    // Asked on a working update; input-required once all it does is wait.
    await harness.waitForState(task.id, "TASK_STATE_INPUT_REQUIRED");
    await harness.answer(task.id, question.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("Yes");
    expect(kinds(await reports())).toEqual([
      "asked",
      "idle",
      "working",
      "idle"
    ]);
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("holds two questions open at once, and takes their answers in either order", async () => {
    const { harness } = setup("g4-two");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:first?");
    const first = await lastQuestion(harness, task.id, 1);
    // A message that joins the task asks a second question beside the first.
    await harness.send("ask:second?", { taskId: task.id });
    const second = await lastQuestion(harness, task.id, 2);
    expect(second.questions[0]?.prompt).toBe("second?");

    await harness.answer(task.id, second.requestId, {
      q1: { optionIds: ["q1.o2"] }
    });
    // The first is still open: its answer's turn names the one it answers.
    await until(
      "the second answer's turn",
      () => working(harness, task.id),
      (lines) => lines.some((l) => l.startsWith('Answer to "second?"'))
    );
    expect(terminals(harness, task.id)).toHaveLength(0);

    await harness.answer(task.id, first.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("Yes");
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

  it("tells the job a question expired, and lets it decide", async () => {
    const { harness, debug } = setup("g5-expiry");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:anyone?");
    const question = await lastQuestion(harness, task.id);
    await harness.timeout(task.id, question.requestId);
    const done = await harness.waitForTerminal(task.id);
    // The task does not fail for it: the model was told, and it went on.
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe(
      'Nobody answered "anyone?" before it expired. Go on without the answer, or ask again.'
    );
    expect((await debug(`${task.id}:main`)).row).toEqual({
      state: "completed",
      open: []
    });
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
      sent.find((x) => x.stepJobId === `${instanceId}:orphan`)?.report.kind
    ).toBe("idle");
  });
});

describe("G10: a message that joins the task", () => {
  it("runs in the task while the job works, and the task ends once", async () => {
    const { harness } = setup("g10-working");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("bgdelegate:sleep:3");
    await harness.waitForState(task.id, "TASK_STATE_WORKING");

    const joined = await harness.send("echo:and one more thing", {
      taskId: task.id
    });
    expect(joined.id).toBe(task.id);
    await until(
      "the joined turn",
      () => working(harness, task.id),
      (lines) => lines.includes("and one more thing")
    );
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain("child did: sleep:3");
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
  });

  it("runs while a question is open, and leaves the question open", async () => {
    const { harness } = setup("g10-asking");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:which one?");
    const question = await lastQuestion(harness, task.id);
    await harness.waitForState(task.id, "TASK_STATE_INPUT_REQUIRED");

    await harness.send("echo:any news?", { taskId: task.id });
    await until(
      "the joined turn",
      () => working(harness, task.id),
      (lines) => lines.includes("any news?")
    );
    expect(terminals(harness, task.id)).toHaveLength(0);

    await harness.answer(task.id, question.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("Yes");
  });

  it("is refused by a task whose step takes none, so the caller starts another", async () => {
    const { harness } = setup("g10-solo");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("solo:bgdelegate:sleep:3");
    await harness.waitForState(task.id, "TASK_STATE_WORKING");
    const res = await harness.rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "SendMessage",
      params: {
        tenant: TEST_TENANT,
        message: {
          messageId: crypto.randomUUID(),
          role: "ROLE_USER",
          taskId: task.id,
          parts: [{ text: "and one more thing" }]
        },
        configuration: {
          taskPushNotificationConfig: { url: harness.pushUrl, token: "tok" }
        }
      }
    });
    const body = await res.json<{ error?: { code: number } }>();
    expect(body.error?.code).toBe(A2A_ERROR_CODE.UNSUPPORTED_OPERATION);
  });
});

describe("G11: an event the platform loses", () => {
  it("pulls a report whose event never arrived, and the task finishes", async () => {
    const { harness, agent, reports } = setup("g11-report");
    using _ = harness.interceptGatekeeper();
    // The agent's first report is sent, as far as it knows, and never arrives.
    await agent.dropReport(0);
    const task = await harness.send("echo:still here");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("still here");
    expect((await reports()).map((r) => [r.report.kind, r.sent])).toEqual([
      ["idle", true]
    ]);
  });

  it("pulls an input whose event never arrived, and the job takes it", async () => {
    const { harness, host } = setup("g11-input");
    using _ = harness.interceptGatekeeper();
    await host.dropInput(0);
    const task = await harness.send("ask:which one?");
    const question = await lastQuestion(harness, task.id);
    await harness.answer(task.id, question.requestId, {
      q1: { optionIds: ["q1.o1"] }
    });
    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("Yes");
  });
});

describe("the cost of waiting", () => {
  /** How many wakes a wait nobody answers takes to last `totalMs`. */
  function wakes(
    reconcile: { afterMs: number; maxMs: number },
    totalMs: number
  ) {
    let waited = 0;
    let wait = reconcile.afterMs;
    let n = 0;
    while (waited < totalMs) {
      waited += wait;
      wait = nextWait(reconcile, wait, false);
      n++;
    }
    return n;
  }

  it("keeps a week-long wait far under an instance's step ceiling", () => {
    // A question may stay open for a week; a Workflow instance holds 10,000
    // steps by default, and each wake is two: the wait and its pull.
    const week = 7 * 24 * 60 * 60_000;
    const n = wakes({ afterMs: 5 * 60_000, maxMs: 30 * 60_000 }, week);
    expect(n).toBeLessThan(340);
    expect(2 * n).toBeLessThan(10_000 / 10);
  });

  it("starts over at the first bound once anything arrives", () => {
    const reconcile = { afterMs: 1_000, maxMs: 8_000 };
    expect(nextWait(reconcile, 1_000, false)).toBe(2_000);
    expect(nextWait(reconcile, 8_000, false)).toBe(8_000);
    expect(nextWait(reconcile, 8_000, true)).toBe(1_000);
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

describe("a pipeline's question under its own ids", () => {
  /**
   * `step.ask` takes the caller's ids, and an answers map is a plain object:
   * read naively, these find `Object.prototype`'s and pass as answered.
   */
  it.each(["constructor", "toString"])(
    "refuses an answer that leaves %s unanswered, and stays parked",
    async (id) => {
      const { harness } = setup(`ask-id-${id}`);
      using _ = harness.interceptGatekeeper();
      const task = await harness.send(`ask-id:${id}`);
      const question = await lastQuestion(harness, task.id);
      expect(question.questions[0]?.id).toBe(id);

      await expect(
        harness.answer(task.id, question.requestId, {})
      ).rejects.toThrow(`question "${id}" has no answer`);
      await pause(300);
      expect(terminals(harness, task.id)).toHaveLength(0);
    }
  );
});

describe("G9 in miniature: the approval loop", () => {
  it("replans on a rejection's feedback, then acts once approved", async () => {
    const { harness } = setup("g9");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("approve:the thing");

    const first = await lastQuestion(harness, task.id, 1);
    expect(first.questions[0]).toMatchObject({
      kind: "choice",
      id: "plan",
      prompt: "plan 0 for the thing"
    });
    await harness.answer(task.id, first.requestId, {
      plan: { optionIds: ["reject"], text: "smaller" }
    });

    const second = await lastQuestion(harness, task.id, 2);
    expect(second.questions[0]?.prompt).toBe("plan 1 for the thing (smaller)");
    expect(working(harness, task.id)).toContain("Replanning.");
    await harness.answer(task.id, second.requestId, {
      plan: { optionIds: ["approve"] }
    });

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
    // Started first: a start that finds the hooks owed queues a run of its own.
    await host.getTask("none");

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

  it("stops the run a settle cut short still owes", async () => {
    const { harness, host, hostDebug, debug } = setup("stop-owed");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:still there?");
    await lastQuestion(harness, task.id);

    await runInDurableObject(host, async (instance) => {
      // A settle the host makes while the run still goes, and the host gone
      // before the stop.
      const failed = buildFailedTask(task.id, task.contextId, COPY.failed);
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

  it("relays an input an eviction left unsent, once, from its next start", async () => {
    const { harness, host } = setup("owed-input");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("ask:which one?");
    const question = await lastQuestion(harness, task.id);

    await runInDurableObject(host, async (instance) => {
      // The answer recorded, and the host gone before it was relayed.
      instance.ledger.closeRequest(task.id, question.requestId, "answered");
      instance.runs.addInput(task.id, `${task.id}:main`, "m-cut", {
        kind: "answer",
        requestId: question.requestId,
        answers: { q1: { optionIds: ["q1.o1"] } }
      });
      // The gatekeeper's retry finds it taken.
      const taken = await instance.answerTask({
        taskId: task.id,
        messageId: "m-retry",
        reply: {
          kind: "answer",
          requestId: question.requestId,
          answer: {
            answeredBy: "spec",
            answers: { q1: { optionIds: ["q1.o1"] } }
          }
        }
      });
      expect(taken).toBe(false);
      await instance.onStart();
    });

    const done = await harness.waitForTerminal(task.id);
    expect(done.text).toBe("Yes");
    await pause(300);
    expect(terminals(harness, task.id)).toHaveLength(1);
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

  it("owes each end-of-task notice until its agent takes it", async () => {
    const { harness, host } = setup("notices");
    using _ = harness.interceptGatekeeper();
    const taskId = crypto.randomUUID();
    const state = TaskState.TASK_STATE_FAILED;
    await host.getTask("none");

    await runInDurableObject(host, async (instance) => {
      acceptInto(instance, harness.pushUrl, taskId);
      instance.ledger.markWorking(taskId);
      // An agent the host cannot reach, beside one it can.
      instance.runs.note(taskId, {
        stepJobId: `${taskId}:a`,
        binding: "NO_SUCH_AGENT"
      });
      instance.runs.note(taskId, {
        stepJobId: `${taskId}:b`,
        binding: "TEST_AGENT"
      });
      instance.ledger.settle(buildFailedTask(taskId, "c1", "no"));
      await instance.runSettleHooks({ taskId });
      expect(instance.ledger.row(taskId)?.hooksPending).toBe(false);

      await expect(
        instance.notifyStepAgent({ taskId, binding: "NO_SUCH_AGENT", state })
      ).rejects.toThrow();
      await instance.notifyStepAgent({ taskId, binding: "TEST_AGENT", state });
      expect(
        instance.runs.owedNotices().filter((notice) => notice.taskId === taskId)
      ).toEqual([{ taskId, binding: "NO_SUCH_AGENT", state }]);

      // A start sends it again.
      const stub = instance as unknown as {
        queue(
          callback: string,
          payload: unknown,
          ...rest: unknown[]
        ): Promise<string>;
      };
      const queued: unknown[] = [];
      const queue = stub.queue.bind(instance);
      stub.queue = (callback, payload, ...rest) => {
        if (callback === "notifyStepAgent") queued.push(payload);
        return queue(callback, payload, ...rest);
      };
      await instance.onStart();
      expect(queued).toContainEqual({
        taskId,
        binding: "NO_SUCH_AGENT",
        state
      });
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

  it("asks two questions of its own at once, and takes both answers", async () => {
    const { harness } = setup("asks");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("asks:");
    const [one] = [await lastQuestion(harness, task.id, 1)];
    const two = await lastQuestion(harness, task.id, 2);
    await harness.answer(task.id, two.requestId, { q1: { text: "second" } });
    await harness.answer(task.id, one.requestId, { q1: { text: "first" } });
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect([one, two].map((q) => q.questions[0]?.prompt).sort()).toEqual([
      "one",
      "two"
    ]);
    expect(done.text.split(" and ").sort()).toEqual(["first", "second"]);
  });

  it("refuses a step named as a retry", async () => {
    const { harness } = setup("retry-named");
    using _ = harness.interceptGatekeeper();
    const task = await harness.send("retry-named:");
    const done = await harness.waitForTerminal(task.id);
    expect(done.state).toBe("TASK_STATE_FAILED");
    const { error } = await status(task.id);
    expect(error?.message).toContain('step "main:retry"');
  });
});
