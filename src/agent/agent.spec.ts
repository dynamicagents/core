import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { TaskState } from "@a2a-js/sdk";
import type {
  ToolCallContext,
  ToolCallDecision,
  TurnConfig,
  TurnContext
} from "@cloudflare/think";
import type { UIMessage } from "ai";
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
import { TEST_TENANT } from "../testing/auth.js";
import { requireArtifactsStub } from "../artifacts/binding.js";
import { UNAPPROVABLE_ARTIFACT, unrecordedApprovalText } from "./tools.js";
import { SESSION_TRANSCRIPT_KIND } from "../artifacts/transcript.js";
import type { StepJob, TaskParams } from "../workflow/types.js";
import worker, {
  COPY,
  type JobDebug,
  type TestAgent,
  type TestEnv
} from "../../test/worker.js";

/**
 * The step agent, driven end to end through core's real edge: every scenario
 * goes in as a gatekeeper-signed `SendMessage` to the host, runs as a one-step
 * pipeline's job on a test agent, and comes out as push callbacks. The agent is
 * read only for what a callback cannot carry: the job's ledger, its reports,
 * and whether a sub-agent actually stopped.
 *
 * **One caller per spec.** An object runs its turns one at a time, so two specs
 * sharing one would serialize and see each other's callbacks.
 */

const testEnv = env as unknown as TestEnv;

type AgentBinding = "TEST_AGENT" | "CAPPED_AGENT" | "STALE_AGENT";

function harnessFor(label: string, binding: AgentBinding = "TEST_AGENT") {
  const key = `${label}:${crypto.randomUUID()}`;
  const harness = createAgentHarness({
    worker,
    env: testEnv,
    identity: { key, name: "Spec Caller", kind: "custom", workspaceId: 1 }
  });
  const ns = testEnv[binding] as DurableObjectNamespace<TestAgent>;
  /** A stub an abort broke stays broken, so the reads take a fresh one. */
  const stub = () => ns.get(ns.idFromName(key));
  const agent = stub();
  const host = testEnv.TEST_HOST.get(testEnv.TEST_HOST.idFromName(key));
  /** The job a one-step pipeline runs for the task. */
  const debug = async (taskId: string): Promise<JobDebug> =>
    JSON.parse(await stub().debugJob(`${taskId}:main`)) as JobDebug;
  const jobDebug = async (stepJobId: string): Promise<JobDebug> =>
    JSON.parse(await stub().debugJob(stepJobId)) as JobDebug;
  const settled = async (taskId: string): Promise<number[]> =>
    JSON.parse(await stub().debugSettled(taskId)) as number[];
  return { harness, agent, stub, host, debug, jobDebug, settled };
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
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}: ${JSON.stringify(value)}`
      );
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

/** The note entries on a task's transcript, oldest first. */
async function transcriptEntries(taskId: string): Promise<string[]> {
  const stub = requireArtifactsStub(testEnv);
  const token = await stub.tokenFor(SESSION_TRANSCRIPT_KIND, taskId);
  if (!token) return [];
  const body = await (
    await stub.fetch(new Request(`https://agent.test/a/${token}/events`))
  ).text();
  return [...body.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]);
}

/**
 * An instance that has already ended, for a job seeded straight into the
 * ledger: its reports are refused and dropped, as a stopped task's are.
 */
async function endedInstance(): Promise<string> {
  const id = crypto.randomUUID();
  await testEnv.TEST_BAD_TASK.create({ id, params: {} as TaskParams });
  await until(
    "the instance to end",
    async () => (await testEnv.TEST_BAD_TASK.get(id)).status(),
    (s) => s.status === "errored"
  );
  return id;
}

/** A working job, accepted straight into the ledger. */
function seedJob(instance: TestAgent, workflowId: string): StepJob {
  const taskId = crypto.randomUUID();
  const job: StepJob = {
    stepJobId: `${taskId}:main`,
    taskId,
    contextId: "c1",
    input: "seeded",
    attempt: 1,
    caller: "",
    identity: { key: "k" },
    jku: "https://agent.test/.well-known/jwks.json",
    workflow: { name: "TEST_BAD_TASK", id: workflowId },
    host: { binding: "TEST_HOST", name: instance.name }
  };
  instance.ledger.accept(job);
  instance.ledger.markWorking(job.stepJobId);
  return job;
}

function reportsOf(job: JobDebug): string[] {
  return job.reports.map((r) => r.report.state);
}

describe("a one-step task", () => {
  it("accepts a turn and calls back exactly once", async () => {
    const { harness, debug, settled } = harnessFor("accept");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("echo:hello there");
    expect(String(accepted.status.state)).toContain("SUBMITTED");

    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toBe("hello there");
    await pause(300);
    expect(terminals(harness, accepted.id)).toHaveLength(1);
    expect(reportsOf(await debug(accepted.id))).toEqual(["completed"]);
    // The host's end-of-task notice reaches the agent that ran the job.
    expect(
      await until(
        "the notice",
        () => settled(accepted.id),
        (states) => states.length > 0
      )
    ).toEqual([TaskState.TASK_STATE_COMPLETED]);
  });

  it("runs one job for a redelivered messageId", async () => {
    const { harness } = harnessFor("redeliver");
    using _ = harness.interceptGatekeeper();

    const first = await sendAs(harness, "gk-m1", "echo:said once");
    const second = await sendAs(harness, "gk-m1", "echo:said once");
    expect(second).toBe(first);

    await harness.waitForTerminal(first);
    await pause(500);
    expect(terminals(harness, first)).toHaveLength(1);
  });

  it("fails a task when the turn errors, and its retry errors too", async () => {
    const { harness } = harnessFor("error");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("boom");
    const failed = await harness.waitForTerminal(accepted.id);
    expect(failed.state).toBe("TASK_STATE_FAILED");
    expect(failed.text).toBe(COPY.failed);
  });

  it("answers an RPC on a cold host", async () => {
    const { host } = harnessFor("cold");
    await expect(host.getTask("no-such-task")).resolves.toBeNull();
  });
});

describe("cancellation", () => {
  it("cancels a turn that is still running, and never calls back as done", async () => {
    const { harness, debug, host, settled } = harnessFor("cancel");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("wait:20");
    await until(
      "the turn to start",
      () => debug(accepted.id),
      (d) => d.row?.state === "working"
    );
    await cancel(harness, accepted.id);
    await until(
      "the job to stop",
      () => debug(accepted.id),
      (d) => d.row?.state === "canceled"
    );
    await until(
      "the notice",
      () => settled(accepted.id),
      (states) => states.length > 0
    );
    expect(await settled(accepted.id)).toEqual([TaskState.TASK_STATE_CANCELED]);
    expect(terminals(harness, accepted.id)).toHaveLength(0);

    // A replayed cancel answers with the task and stops nothing twice.
    expect(await host.cancelTask(accepted.id)).not.toBeNull();
    await pause(500);
    expect(await settled(accepted.id)).toEqual([TaskState.TASK_STATE_CANCELED]);
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
    expect(question.requestId.startsWith(`${accepted.id}:main:`)).toBe(true);
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

describe("asking the caller to approve an artifact", () => {
  /** An open artifact holding one note, as a plan is before anyone approves it. */
  async function plan(): Promise<string> {
    const artifacts = requireArtifactsStub(testEnv);
    const token = await artifacts.createArtifact("plan");
    await artifacts.addEntry(token, { label: "plan", text: "the plan" });
    return token;
  }

  it("parks on an approval carrying the artifact's link", async () => {
    const { harness } = harnessFor("approve-park");
    using _ = harness.interceptGatekeeper();
    const token = await plan();

    const accepted = await harness.send(`approve-artifact:${token}`);
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    const question = questionOf(parked);
    expect(question.requestKind).toBe("approval");
    expect(question.options).toBeUndefined();
    expect(question.allowFreeform).toBe(true);
    expect(question.prompt).toMatch(
      new RegExp(`^Approve this\\?\\n\\nhttps?://[^/]+/a/${token}$`)
    );
    expect(question.artifact).toEqual({
      id: token,
      url: question.prompt.split("\n\n").at(-1)
    });
  });

  it("locks an approved artifact, and tells the model", async () => {
    const { harness } = harnessFor("approve-yes");
    using _ = harness.interceptGatekeeper();
    const token = await plan();

    const accepted = await harness.send(`approve-artifact:${token}`);
    const [parked] = await harness.waitForState(
      accepted.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    await harness.answer(accepted.id, questionOf(parked).requestId, {
      optionId: "approve"
    });

    expect((await harness.waitForTerminal(accepted.id)).text).toBe("Approved.");
    expect(
      await requireArtifactsStub(testEnv).readArtifact(token)
    ).toMatchObject({
      status: "approved",
      locked: true,
      entries: [
        { label: "plan", text: "the plan" },
        { label: "approval", text: "Approved." }
      ]
    });
  });

  it("records a rejection and a comment without locking", async () => {
    const { harness } = harnessFor("approve-no");
    using _ = harness.interceptGatekeeper();
    const token = await plan();

    const rejected = await harness.send(`approve-artifact:${token}`);
    const [first] = await harness.waitForState(
      rejected.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    await harness.answer(rejected.id, questionOf(first).requestId, {
      optionId: "reject"
    });
    expect((await harness.waitForTerminal(rejected.id)).text).toBe("Rejected.");

    const commented = await harness.send(`approve-artifact:${token}`);
    const [second] = await harness.waitForState(
      commented.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    await harness.answer(commented.id, questionOf(second).requestId, {
      text: "leave the tests alone"
    });
    expect((await harness.waitForTerminal(commented.id)).text).toBe(
      "Comment: leave the tests alone"
    );

    expect(
      await requireArtifactsStub(testEnv).readArtifact(token)
    ).toMatchObject({
      status: null,
      locked: false,
      entries: [
        { label: "plan" },
        { label: "approval", text: "Rejected." },
        { label: "approval", text: "Comment: leave the tests alone" }
      ]
    });
  });

  /**
   * Two questions can be parked on one artifact. The first approval locks it,
   * and the second answer reaches nothing — which the model is told, rather
   * than read "Approved." for an approval that did not take.
   */
  it("tells the model an answer that another answer overtook", async () => {
    const { harness } = harnessFor("approve-race");
    using _ = harness.interceptGatekeeper();
    const token = await plan();

    const first = await harness.send(`approve-artifact:${token}`);
    const [a] = await harness.waitForState(
      first.id,
      "TASK_STATE_INPUT_REQUIRED"
    );
    const second = await harness.send(`approve-artifact:${token}`);
    const [b] = await harness.waitForState(
      second.id,
      "TASK_STATE_INPUT_REQUIRED"
    );

    await harness.answer(first.id, questionOf(a).requestId, {
      optionId: "approve"
    });
    expect((await harness.waitForTerminal(first.id)).text).toBe("Approved.");

    await harness.answer(second.id, questionOf(b).requestId, {
      optionId: "reject"
    });
    expect((await harness.waitForTerminal(second.id)).text).toBe(
      unrecordedApprovalText("Rejected.")
    );
    expect(
      (await requireArtifactsStub(testEnv).readArtifact(token))?.entries.map(
        (entry) => entry.text
      )
    ).toEqual(["the plan", "Approved."]);
  });

  /**
   * Nothing is parked, and the turn does not end on the call: the call fails,
   * and the model reads why and carries on in the same turn.
   */
  it.each([
    ["one it does not know", async () => "Q".repeat(40)],
    [
      "one already locked",
      async () => {
        const token = await plan();
        await requireArtifactsStub(testEnv).lock(token, "approved");
        return token;
      }
    ],
    [
      "one already settled",
      async () => {
        const token = await plan();
        await requireArtifactsStub(testEnv).settle(token, "completed");
        return token;
      }
    ]
  ])("tells the model it cannot ask about %s", async (_label, make) => {
    const { harness } = harnessFor("approve-refused");
    using _ = harness.interceptGatekeeper();
    const artifact = await make();

    const accepted = await harness.send(`approve-artifact:${artifact}`);
    const done = await harness.waitForTerminal(accepted.id);

    expect(done.state).toBe("TASK_STATE_COMPLETED");
    expect(done.text).toContain(UNAPPROVABLE_ARTIFACT);
    expect(
      harness.callbacks.some(
        (c) =>
          c.taskId === accepted.id && c.state === "TASK_STATE_INPUT_REQUIRED"
      )
    ).toBe(false);
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
  it("keeps the job working until the run reports, then answers once", async () => {
    const { harness, debug } = harnessFor("bg");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("bgdelegate:sleep:1");
    const done = await harness.waitForTerminal(accepted.id);

    // The sentence before the call, pushed through the host as it started.
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
    expect(reportsOf(state)).toEqual(["completed"]);
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
    await until(
      "the job to stop",
      () => debug(accepted.id),
      (d) => d.row?.state === "canceled" && !d.work[0].open
    );
    await pause(1_000);

    const state = await debug(accepted.id);
    expect(state.runs[0].status).not.toBe("completed");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
  });

  it("starts nothing for a job stopped while it prepares, and releases what was prepared", async () => {
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

  it("does not leave the job open when the dispatch is refused, and releases what was prepared", async () => {
    const { harness, debug } = harnessFor("capped", "CAPPED_AGENT");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("capped:bgdelegate:sleep:1");
    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");

    const state = await debug(accepted.id);
    expect(state.work).toEqual([
      expect.objectContaining({ open: false, settled: true })
    ]);
    expect(state.released).toEqual([
      expect.objectContaining({ status: "error" })
    ]);
  });

  it("follows up once for a soft interruption and then a result", async () => {
    const { agent, jobDebug } = harnessFor("bg-soft");
    const ended = await endedInstance();
    const run = {
      runId: "detached:soft",
      agentType: "TestBackground",
      status: "running" as const,
      displayOrder: 0,
      startedAt: Date.now()
    };

    const job = await runInDurableObject(agent, async (instance: TestAgent) => {
      const job = seedJob(instance, ended);
      instance.ledger.addWork({
        workId: run.runId,
        stepJobId: job.stepJobId,
        kind: "detached",
        name: "TestBackground"
      });

      await instance.onSubAgentFinish(run, {
        status: "interrupted",
        childStillRunning: true
      });
      expect(instance.ledger.openWork(job.stepJobId)).toBe(1);

      const result = { status: "completed" as const, summary: "late but real" };
      await instance.onSubAgentFinish(run, result);
      await instance.onSubAgentFinish(run, result);
      return job;
    });

    const state = await until(
      "the job's report",
      () => jobDebug(job.stepJobId),
      (d) => d.reports.length > 0
    );
    await pause(500);
    const settled = await jobDebug(job.stepJobId);
    expect(reportsOf(settled)).toEqual(["completed"]);
    expect(state.reports[0].report.reply).toContain("late but real");
  });
});

describe("a turn the runtime cuts", () => {
  /** Longer than the runtime lets an alarm invocation run. */
  const CEILING_AGE_MS = 16 * 60_000;

  /**
   * Reset the object mid-step, its turn aged as one the runtime cuts at its
   * ceiling is: Think reads a turn's age from its chat fiber, its task run and
   * its stream. `beforeCut` writes in the same call, so it holds past the
   * abort.
   */
  async function cutMidStep(
    { stub, debug }: ReturnType<typeof harnessFor>,
    taskId: string,
    beforeCut?: (instance: TestAgent) => void
  ): Promise<void> {
    await until(
      "the turn to start",
      () => debug(taskId),
      (d) => d.row?.state === "working"
    );
    await pause(1_000);
    await runInDurableObject(stub(), (instance: TestAgent, state) => {
      beforeCut?.(instance);
      for (const table of [
        "cf_agents_runs",
        "cf_agents_task_runs",
        "cf_agents_streams"
      ]) {
        state.storage.sql.exec(
          `UPDATE ${table} SET created_at = created_at - ?`,
          CEILING_AGE_MS
        );
      }
    });
    // The abort rejects the call that made it.
    await runInDurableObject(stub(), (_instance, state) => {
      state.abort("cut");
    }).catch(() => {});
  }

  async function submissions(
    stub: () => DurableObjectStub<TestAgent>
  ): Promise<string[]> {
    return runInDurableObject(stub(), async (instance: TestAgent) =>
      (await instance.listSubmissions()).map((s) => s.status).sort()
    );
  }

  /** How many times the conversation says `text`: once per turn that ended. */
  async function said(
    stub: () => DurableObjectStub<TestAgent>,
    text: string
  ): Promise<number> {
    return runInDurableObject(
      stub(),
      async (instance: TestAgent) =>
        (await instance.getMessages())
          .flatMap((m) => m.parts)
          .filter((p) => p.type === "text" && p.text === text).length
    );
  }

  it("is continued under its submission, and its job reports once", async () => {
    const agent = harnessFor("cut");
    const { harness, stub, debug } = agent;
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("wait:4");
    await cutMidStep(agent, accepted.id);

    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    await pause(500);
    expect(terminals(harness, accepted.id)).toHaveLength(1);
    expect(reportsOf(await debug(accepted.id))).toEqual(["completed"]);
    expect(await submissions(stub)).toEqual(["completed"]);
    expect(await said(stub, "waited 4")).toBe(1);
  });

  it("fails its job on Think's own staleness cutoff, and is not run beside the retry", async () => {
    const agent = harnessFor("stale", "STALE_AGENT");
    const { harness, stub, debug, jobDebug } = agent;
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("stale:wait:4");
    await cutMidStep(agent, accepted.id);

    const done = await harness.waitForTerminal(accepted.id);
    expect(done.state).toBe("TASK_STATE_COMPLETED");
    await pause(500);
    expect(reportsOf(await debug(accepted.id))).toEqual(["failed"]);
    expect(reportsOf(await jobDebug(`${accepted.id}:main:retry`))).toEqual([
      "completed"
    ]);
    expect(await submissions(stub)).toEqual(["completed", "error"]);
    // The retry's reply alone.
    expect(await said(stub, "waited 4")).toBe(1);
  });

  it("is declined once its job was canceled, and the agent runs its next job", async () => {
    const agent = harnessFor("cut-cancel");
    const { harness, stub, debug } = agent;
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("wait:4");
    // The stop's first write, held, with the cut before it reached the turn.
    // A cancel sent only after the cut races the restart's own recovery,
    // which can finish the job first.
    await cutMidStep(agent, accepted.id, (instance) => {
      instance.ledger.cancel(`${accepted.id}:main`);
    });
    await cancel(harness, accepted.id);

    const next = await harness.send("echo:after");
    expect((await harness.waitForTerminal(next.id)).text).toBe("after");
    expect(terminals(harness, accepted.id)).toHaveLength(0);
    expect((await debug(accepted.id)).row?.state).toBe("canceled");
    // Think ends a turn it did not continue as an error.
    expect(await submissions(stub)).toEqual(["completed", "error"]);
    expect(await said(stub, "waited 4")).toBe(0);
  });
});

describe("recovering what an eviction cut short", () => {
  it("settles on the last of two results that landed before either follow-up ran", async () => {
    const { agent, jobDebug } = harnessFor("follow-ups");
    const ended = await endedInstance();

    const job = await runInDurableObject(agent, async (instance: TestAgent) => {
      const job = seedJob(instance, ended);
      for (const [workId, text] of [
        ["detached:one", "echo:first"],
        ["detached:two", "echo:second"]
      ]) {
        instance.ledger.addWork({
          workId,
          stepJobId: job.stepJobId,
          kind: "detached",
          name: "TestBackground"
        });
        instance.ledger.beginFollowUp(workId, { id: `finish:${workId}`, text });
      }
      await instance.submitFollowUp({ workId: "detached:one" });
      await instance.submitFollowUp({ workId: "detached:two" });
      return job;
    });

    const state = await until(
      "the job's report",
      () => jobDebug(job.stepJobId),
      (d) => d.reports.length > 0
    );
    expect(state.reports[0].report.reply).toBe("second");
    await pause(500);
    expect(reportsOf(await jobDebug(job.stepJobId))).toEqual(["completed"]);
  });

  it("sends the follow-up a closed work row still owes", async () => {
    const { agent, jobDebug } = harnessFor("follow-up");
    const ended = await endedInstance();

    const job = await runInDurableObject(agent, async (instance: TestAgent) => {
      const job = seedJob(instance, ended);
      instance.ledger.addWork({
        workId: "detached:cut",
        stepJobId: job.stepJobId,
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
      return job;
    });

    const state = await until(
      "the job's report",
      () => jobDebug(job.stepJobId),
      (d) => d.reports.length > 0
    );
    expect(state.reports[0].report.reply).toBe("recovered");
    await pause(500);
    expect(reportsOf(await jobDebug(job.stepJobId))).toEqual(["completed"]);
  });

  it("submits the answer a resumed job still owes, once", async () => {
    const { agent, jobDebug } = harnessFor("answer");
    const ended = await endedInstance();

    const job = await runInDurableObject(agent, async (instance: TestAgent) => {
      const job = seedJob(instance, ended);
      const request: HitlRequestData = {
        type: HITL_REQUEST_TYPE,
        requestId: `${job.stepJobId}:call-1`,
        requestKind: "choice",
        prompt: "Which one?",
        allowFreeform: true
      };
      instance.ledger.park(job.stepJobId, request);
      // Resumed, and the object gone before the submit.
      instance.ledger.resume(job.stepJobId, {
        id: "answer:cut",
        text: "echo:answered"
      });
      // The workflow's retry, then what the start-up sweep queues.
      await instance.answerStepJob(job.stepJobId, { text: "again" });
      await instance.submitAnswer({ stepJobId: job.stepJobId });
      return job;
    });

    const state = await until(
      "the job's reply",
      () => jobDebug(job.stepJobId),
      (d) => d.reports.length > 1
    );
    expect(reportsOf(state)).toEqual(["input-required", "completed"]);
    expect(state.reports[1].report.reply).toBe("answered");
  });
});

describe("stopping a job's work", () => {
  it("keeps a row open, and a failed job's report back, until its stop has held", async () => {
    const { agent } = harnessFor("stop-work");
    const ended = await endedInstance();

    const job = await runInDurableObject(agent, async (instance: TestAgent) => {
      const job = seedJob(instance, ended);
      instance.ledger.addWork({
        workId: "wait:w1",
        stepJobId: job.stepJobId,
        kind: "wait",
        name: "check_back",
        scheduleId: "s1"
      });
      const stub = instance as unknown as {
        cancelSchedule(id: string): Promise<boolean>;
        onSubmissionStatus(submission: unknown): Promise<void>;
        queue(callback: string, ...rest: unknown[]): Promise<string>;
      };
      const queued: string[] = [];
      const queue = stub.queue.bind(instance);
      stub.queue = (callback, ...rest) => {
        queued.push(callback);
        return queue(callback, ...rest);
      };
      stub.cancelSchedule = async () => {
        throw new Error("the schedule store is away");
      };

      // The turn errors, and the stop that follows fails.
      await stub.onSubmissionStatus({
        submissionId: "sub-1",
        status: "error",
        error: "cut",
        metadata: { stepJobId: job.stepJobId }
      });
      expect(instance.ledger.row(job.stepJobId)?.state).toBe("failed");
      expect(queued).toContain("finishStopWork");
      expect(queued).not.toContain("deliverStepJobReport");
      await expect(
        instance.finishStopWork({ stepJobId: job.stepJobId })
      ).rejects.toThrow("not stopped yet");
      expect(instance.ledger.openWorkRows(job.stepJobId)).toHaveLength(1);
      // A redelivered start sends nothing early either.
      await instance.startStepJob(job);
      expect(queued).not.toContain("deliverStepJobReport");
      // A restart retries the stop, and sends the report only after it.
      expect(instance.ledger.unstopped()).toContain(job.stepJobId);
      expect(instance.ledger.unsent()).not.toContainEqual({
        stepJobId: job.stepJobId,
        n: 0
      });

      stub.cancelSchedule = async () => true;
      await instance.finishStopWork({ stepJobId: job.stepJobId });
      expect(instance.ledger.openWorkRows(job.stepJobId)).toEqual([]);
      expect(queued).toContain("deliverStepJobReport");
      return job;
    });

    await until(
      "the report released",
      () =>
        runInDurableObject(
          agent,
          (instance: TestAgent) =>
            instance.ledger.report(job.stepJobId, 0)?.sent ?? false
        ),
      (sent) => sent
    );
  });

  it("runs the task's settle hook only once its work has stopped", async () => {
    const { agent } = harnessFor("stop-hook");
    const ended = await endedInstance();

    await runInDurableObject(agent, async (instance: TestAgent) => {
      const job = seedJob(instance, ended);
      instance.ledger.addWork({
        workId: "wait:w1",
        stepJobId: job.stepJobId,
        kind: "wait",
        name: "check_back",
        scheduleId: "s1"
      });
      const stub = instance as unknown as {
        cancelSchedule(id: string): Promise<boolean>;
      };
      stub.cancelSchedule = async () => {
        throw new Error("the schedule store is away");
      };
      const hooks = async () =>
        JSON.parse(await instance.debugSettled(job.taskId)) as number[];

      // The notice cancels the open job, and its stop fails.
      await instance.stepTaskSettled(job.taskId, TaskState.TASK_STATE_FAILED);
      expect(instance.ledger.row(job.stepJobId)?.state).toBe("canceled");
      expect(await hooks()).toEqual([]);
      // A notice repeated finds the hook owed, not yet due.
      await instance.stepTaskSettled(job.taskId, TaskState.TASK_STATE_FAILED);
      expect(await hooks()).toEqual([]);

      stub.cancelSchedule = async () => true;
      await instance.finishStopWork({ stepJobId: job.stepJobId });
      expect(await hooks()).toEqual([TaskState.TASK_STATE_FAILED]);
      expect(instance.ledger.dueTaskHooks()).toEqual([]);
    });
  });
});

describe("check_back", () => {
  it("ends the turn, keeps the job open, and settles after the wake", async () => {
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

/** The protected hooks a spec calls directly, with the turn's job stubbed. */
interface TurnHooks {
  turnStepJobId(): string | undefined;
  beforeTurn(ctx: TurnContext): TurnConfig | void | Promise<TurnConfig | void>;
  beforeToolCall(
    ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void>;
  onChatRecovery(ctx: {
    messages: UIMessage[];
  }): Promise<{ continue: boolean } | void>;
}

function userMessageFor(job: StepJob): UIMessage {
  return {
    id: `stepjob:${job.stepJobId}`,
    role: "user",
    parts: [{ type: "text", text: job.input }],
    metadata: {
      turnMetadata: {
        taskId: job.taskId,
        stepJobId: job.stepJobId,
        contextId: job.contextId
      }
    }
  };
}

describe("a turn for a job that has ended", () => {
  it("is not continued after an interruption, however the job ended", async () => {
    const { agent } = harnessFor("recovery");
    const ended = await endedInstance();

    await runInDurableObject(agent, async (instance: TestAgent) => {
      const hooks = instance as unknown as TurnHooks;
      const recover = (job: StepJob) =>
        hooks.onChatRecovery({ messages: [userMessageFor(job)] });

      const open = seedJob(instance, ended);
      expect(await recover(open)).toBeUndefined();

      const completed = seedJob(instance, ended);
      instance.ledger.settle(completed.stepJobId, {
        state: "completed",
        reply: "done"
      });
      const failed = seedJob(instance, ended);
      instance.ledger.settle(failed.stepJobId, {
        state: "failed",
        error: "the turn failed"
      });
      const canceled = seedJob(instance, ended);
      instance.ledger.cancel(canceled.stepJobId);
      for (const job of [completed, failed, canceled]) {
        expect(await recover(job)).toEqual({ continue: false });
      }
    });
  });

  it("is not continued when it names no job", async () => {
    const { agent } = harnessFor("no-job");

    await runInDurableObject(agent, async (instance: TestAgent) => {
      const hooks = instance as unknown as TurnHooks;
      // An `A2AAgent` turn's message names its task alone.
      const message: UIMessage = {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "go on" }],
        metadata: { turnMetadata: { taskId: "t1" } }
      };
      expect(await hooks.onChatRecovery({ messages: [message] })).toEqual({
        continue: false
      });
    });
  });

  it("is offered no tools, and every call it makes is refused", async () => {
    const { agent } = harnessFor("no-tools");
    const ended = await endedInstance();

    await runInDurableObject(agent, async (instance: TestAgent) => {
      const hooks = instance as unknown as TurnHooks;
      const job = seedJob(instance, ended);
      hooks.turnStepJobId = () => job.stepJobId;
      const call = { toolName: "test_mark" } as unknown as ToolCallContext;

      expect(
        (await hooks.beforeTurn({} as TurnContext))?.activeTools
      ).toBeUndefined();
      expect(await hooks.beforeToolCall(call)).toBeUndefined();

      instance.ledger.settle(job.stepJobId, { state: "failed", error: "cut" });
      expect((await hooks.beforeTurn({} as TurnContext))?.activeTools).toEqual(
        []
      );
      expect(await hooks.beforeToolCall(call)).toEqual({
        action: "block",
        reason: "the task has ended"
      });
    });
  });

  it("stops at its next step when its job ends while it runs", async () => {
    const { harness, agent, debug } = harnessFor("closing");
    using _ = harness.interceptGatekeeper();

    const accepted = await harness.send("closing:2");
    const stepJobId = `${accepted.id}:main`;
    await until(
      "the turn to start",
      () => debug(accepted.id),
      (d) => d.row?.state === "working"
    );
    await pause(500);
    // Ended with no abort, as a failed job is.
    await runInDurableObject(agent, (instance: TestAgent) => {
      instance.ledger.cancel(stepJobId);
    });
    await pause(4_000);

    const state = await debug(accepted.id);
    expect(state.marks).toBe(0);
    expect(state.reports).toEqual([]);
    const said = await runInDurableObject(agent, async (instance: TestAgent) =>
      (await instance.getMessages())
        .flatMap((m) => m.parts)
        .some((p) => p.type === "text" && p.text === "went on")
    );
    expect(said).toBe(false);
    await cancel(harness, accepted.id);
  });
});
