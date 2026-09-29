import {
  DurableObject,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { HITL_APPROVE_OPTION_ID } from "@dynamicagents/g2a-protocol";
import { installScheduler } from "../src/alarm/index.js";
import type { TaskState } from "@a2a-js/sdk";
import { Think, type ThinkModel } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { handleArtifactRoute } from "../src/artifacts/route.js";
import type { AgentManifest } from "../src/a2a/card.js";
import type { CoreEnv } from "../src/env.js";
import { StepAgent } from "../src/agent/agent.js";
import { TaskHost, type A2ACopy } from "../src/task/host.js";
import { TaskWorkflow, type TaskStep } from "../src/workflow/workflow.js";
import type {
  PipelineResult,
  StepJob,
  TaskParams
} from "../src/workflow/types.js";
import type { SubAgentSpec } from "../src/contract/subagent.js";
import { SubAgent, type SubAgentClass } from "../src/subagent/subagent.js";
import { createA2AWorker, defineAgent } from "../src/worker/index.js";
import {
  call,
  scriptedModel,
  type MockStep,
  type ModelTurnView
} from "../src/testing/mock-model.js";
import { TEST_TENANT } from "../src/testing/auth.js";

/**
 * The Worker under test.
 *
 * `@dynamicagents/core` is a library, not a Worker — but a Think agent only
 * runs inside workerd. So this is the minimal host that gives the pool
 * something to bind: a task host, the pipeline it runs, step agents on a
 * rule-based model, a sub-agent they await, one they detach, and core's
 * `Artifacts` object.
 *
 * Deliberately thin. Anything richer belongs in `starter`, where a real agent
 * is the thing being tested rather than the lifecycle.
 */

export interface TestEnv extends CoreEnv {
  TEST_HOST: DurableObjectNamespace<TestHost>;
  TEST_AGENT: DurableObjectNamespace<TestAgent>;
  TEST_STEP_B: DurableObjectNamespace<TestStepB>;
  CAPPED_AGENT: DurableObjectNamespace<CappedAgent>;
  STALE_AGENT: DurableObjectNamespace<StaleAgent>;
  TEST_TASK: Workflow<TaskParams>;
  TEST_BAD_TASK: Workflow<TaskParams>;
}

export const COPY: A2ACopy = {
  failed: "Something went wrong on my side.",
  emptyReply: "I finished, but had nothing to say.",
  questionExpired: "Nobody answered in time, so I stopped."
};

/** The text of the most recent tool result, as the model was shown it. */
function lastToolOutput(view: ModelTurnView): string {
  for (let i = view.prompt.length - 1; i >= 0; i--) {
    const message = view.prompt[i];
    if (message.role !== "tool") continue;
    const part = message.content.find((p) => p.type === "tool-result") as
      { output?: { type: string; value: unknown } } | undefined;
    const value = part?.output?.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return "";
}

function after(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

/**
 * The parent's script, keyed on the message that started the turn. Anything it
 * does not claim is echoed — which is how a follow-up turn answers: a finished
 * run and a `check_back` wake arrive as ordinary user messages.
 */
function parentRule(view: ModelTurnView): MockStep {
  const raw = view.lastUserText;
  // A retry is told so; only `flaky` behaves differently for it.
  if (raw === "retry:flaky") return { text: "recovered" };
  const text = after(raw, "retry:") ?? raw;
  if (["boom", "flaky", "broken"].includes(text)) {
    return { error: "told to fail" };
  }

  const answered = view.answered;
  const ask = after(text, "ask:");
  if (ask !== undefined) {
    return answered
      ? { text: "asked" }
      : call("ask_user", { question: ask, options: ["Yes", "No"] });
  }
  const artifact = after(text, "approve-artifact:");
  if (artifact !== undefined) {
    return call("ask_user", { question: "Approve this?", artifact });
  }
  const wait = after(text, "wait:");
  if (wait !== undefined) {
    return answered
      ? { text: `waited ${wait}` }
      : call("test_wait", { seconds: Number(wait) });
  }
  const closing = after(text, "closing:");
  if (closing !== undefined) {
    // A step that waits, then one that would act — if the turn went on.
    if (!answered) return call("test_wait", { seconds: Number(closing) });
    return lastToolOutput(view).includes("waited")
      ? call("test_mark", {})
      : { text: "went on" };
  }
  const delegate = after(text, "delegate:");
  if (delegate !== undefined) {
    return answered
      ? { text: lastToolOutput(view) }
      : call("test_child", { task: delegate }, "Delegating.");
  }
  const bg2 = after(text, "bgdelegate2:");
  if (bg2 !== undefined) {
    if (answered) return {};
    const [first, second] = bg2.split("|");
    return {
      text: "Started two in the background.",
      calls: [
        { toolName: "test_background", input: { task: first } },
        { toolName: "test_background", input: { task: second } }
      ]
    };
  }
  const bg = after(text, "bgdelegate:");
  if (bg !== undefined) {
    return answered
      ? { text: lastToolOutput(view) }
      : call("test_background", { task: bg }, "Started in the background.");
  }
  if (text === "whoami") {
    return answered ? { text: lastToolOutput(view) } : call("test_whoami", {});
  }
  const checkback = after(text, "checkback:");
  if (checkback !== undefined) {
    return answered
      ? {}
      : call(
          "check_back",
          { seconds: Number(checkback), why: "the build" },
          "Checking back shortly."
        );
  }
  return { text: after(text, "echo:") ?? text };
}

/** A sub-agent's script: `sleep:N` sleeps in a tool, narrating first. */
function childRule(view: ModelTurnView): MockStep {
  const text = view.lastUserText;
  if (text === "fail") return { error: "child told to fail" };
  const sleep = after(text, "sleep:");
  if (sleep !== undefined) {
    return view.answered
      ? { text: `child did: sleep:${sleep}` }
      : call("child_sleep", { seconds: Number(sleep) }, `working on ${text}`);
  }
  return { text: `child did: ${text}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

const waitTool = tool({
  description: "Wait in this turn.",
  inputSchema: z.object({ seconds: z.number().min(0) }),
  execute: async ({ seconds }, { abortSignal }) => {
    await sleep(seconds * 1000, abortSignal);
    return { waited: seconds };
  }
});

const taskInput = z.object({ task: z.string() });

const CHILD_SPEC: SubAgentSpec<{ task: string }, TestEnv> = {
  name: "test_child",
  description: "Hand a task to the test sub-agent and wait for it.",
  inputSchema: taskInput,
  soul: "You are the test sub-agent.",
  formatInput: (input) => input.task,
  prepare: async ({ runId, input }) => {
    // Long enough for a spec to cancel the task while it prepares.
    if (input.task === "slowprep") await sleep(2_000);
    return { lease: `lease:${runId}` };
  },
  /** Durable, like `onTaskSettled`: a spec reads every release. */
  settle: async ({ runId, result, parent }) => {
    parent.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_released (run_id TEXT, status TEXT)"
    );
    parent.storage.sql.exec(
      "INSERT INTO test_released VALUES (?, ?)",
      runId,
      result.status
    );
  }
};

const BACKGROUND_SPEC: SubAgentSpec<{ task: string }, TestEnv> = {
  ...CHILD_SPEC,
  name: "test_background",
  description: "Hand a long task to the background sub-agent.",
  detached: true
};

abstract class TestSubAgentBase extends SubAgent<TestEnv> {
  getModel(): ThinkModel {
    return scriptedModel(childRule);
  }

  override getTools(): ToolSet {
    return {
      ...super.getTools(),
      child_sleep: tool({
        description: "Do a piece of long work.",
        inputSchema: z.object({ seconds: z.number().min(0) }),
        execute: async ({ seconds }, { abortSignal }) => {
          await sleep(seconds * 1000, abortSignal);
          return { slept: seconds };
        }
      })
    };
  }
}

export class TestChild extends TestSubAgentBase {
  static override spec = CHILD_SPEC as SubAgentSpec<never, never>;
}

export class TestBackground extends TestSubAgentBase {
  static override spec = BACKGROUND_SPEC as SubAgentSpec<never, never>;
}

/** One report a job owes or sent. */
export interface StepReportDebug {
  stepJobId: string;
  n: number;
  report: { state: string; reply?: string; error?: string };
  sent: boolean;
}

/** One job's ledger, as JSON: what a report cannot carry. */
export interface JobDebug {
  row: { state: string; request: { requestId: string } | null } | null;
  work: {
    workId: string;
    kind: string;
    name: string;
    open: boolean;
    settled: boolean;
  }[];
  runs: { runId: string; status: string }[];
  reports: StepReportDebug[];
  /** Every run a spec's `settle` released, on this object. */
  released: { runId: string; status: string }[];
  /** How many `test_mark` calls ran, on this object. */
  marks: number;
}

export class TestAgent extends StepAgent<TestEnv> {
  protected readonly compactAfterTokens = 100_000;
  protected readonly keepRecentTokens = 20_000;
  /** just-bash in an agent that never shells out is dead weight. */
  override workspaceBash = false as const;

  getModel(): ThinkModel {
    return scriptedModel(parentRule);
  }

  override getSubAgents(): SubAgentClass[] {
    return [TestChild, TestBackground];
  }

  override getTools(): ToolSet {
    return {
      ...super.getTools(),
      test_wait: waitTool,
      check_back: this.checkBackTool(),
      test_whoami: tool({
        description: "Say which task, job and role this turn is for.",
        inputSchema: z.object({}),
        execute: async () =>
          JSON.stringify({
            taskId: this.turnTaskId() ?? null,
            stepJobId: this.turnStepJobId() ?? null,
            role: this.turnStepJob()?.role ?? null
          })
      }),
      test_mark: tool({
        description: "Act on the world.",
        inputSchema: z.object({}),
        execute: async () => {
          this.sql`CREATE TABLE IF NOT EXISTS test_marks (at INTEGER)`;
          this.sql`INSERT INTO test_marks VALUES (${Date.now()})`;
          return "marked";
        }
      })
    };
  }

  /** A retry is told so: the scripted model keys on the `retry:` prefix. */
  protected override formatStepJobInput(job: StepJob): string {
    return job.attempt > 1 ? `retry:${job.input}` : job.input;
  }

  /**
   * An object whose name starts `noprogress:` drops live notes, so a spec can
   * prove the finish replay delivers them.
   */
  override async onProgress(
    ...args: Parameters<StepAgent<TestEnv>["onProgress"]>
  ): Promise<void> {
    if (this.name.startsWith("noprogress:")) return;
    await super.onProgress(...args);
  }

  /** Durable, so a spec reads what fired however the object was woken. */
  protected override async onTaskSettled(
    taskId: string,
    state: TaskState
  ): Promise<void> {
    this
      .sql`CREATE TABLE IF NOT EXISTS test_settled (task_id TEXT, state INTEGER)`;
    this.sql`INSERT INTO test_settled VALUES (${taskId}, ${state})`;
  }

  /** JSON, not the shape: RPC type mapping over a Think class is too deep. */
  async debugJob(stepJobId: string): Promise<string> {
    const row = this.ledger.row(stepJobId);
    const runs: JobDebug["runs"] = [];
    for (const work of this.ledger.workRows(stepJobId)) {
      if (work.kind === "wait") continue;
      const Cls = work.name === "TestBackground" ? TestBackground : TestChild;
      const child = await this.dynamicAgents.get(Cls, work.workId);
      const inspection = await child.inspectAgentToolRun(work.workId);
      runs.push({
        runId: work.workId,
        status: inspection?.status ?? "unknown"
      });
    }
    const debug: JobDebug = {
      row: row
        ? {
            state: row.state,
            request: row.request ? { requestId: row.request.requestId } : null
          }
        : null,
      work: this.ledger.workRows(stepJobId).map((w) => ({
        workId: w.workId,
        kind: w.kind,
        name: w.name,
        open: w.open,
        settled: w.settled
      })),
      runs,
      reports: this.#reports().filter((r) => r.stepJobId === stepJobId),
      released: this.#released(),
      marks: this.#marks()
    };
    return JSON.stringify(debug);
  }

  /** Every step job report this object owes or sent, as JSON. */
  async debugStepJobs(): Promise<string> {
    return JSON.stringify(this.#reports());
  }

  /** Every state `onTaskSettled` fired with for a task, as JSON. */
  async debugSettled(taskId: string): Promise<string> {
    this
      .sql`CREATE TABLE IF NOT EXISTS test_settled (task_id TEXT, state INTEGER)`;
    return JSON.stringify(
      this.sql<{ state: number }>`
        SELECT state FROM test_settled WHERE task_id = ${taskId}`.map(
        (r) => r.state
      )
    );
  }

  #reports(): StepReportDebug[] {
    // Any read makes the ledger's tables, which a fresh object has not.
    this.ledger.numbers("");
    return this.sql<{
      step_job_id: string;
      n: number;
      report_json: string;
      sent: number;
    }>`
      SELECT step_job_id, n, report_json, sent FROM da_step_job_reports
      ORDER BY step_job_id, n`.map((r) => ({
      stepJobId: r.step_job_id,
      n: r.n,
      report: JSON.parse(r.report_json) as StepReportDebug["report"],
      sent: r.sent === 1
    }));
  }

  #released(): JobDebug["released"] {
    this
      .sql`CREATE TABLE IF NOT EXISTS test_released (run_id TEXT, status TEXT)`;
    return this.sql<{ run_id: string; status: string }>`
      SELECT run_id, status FROM test_released`.map((r) => ({
      runId: r.run_id,
      status: r.status
    }));
  }

  #marks(): number {
    this.sql`CREATE TABLE IF NOT EXISTS test_marks (at INTEGER)`;
    return (
      this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM test_marks`[0]?.n ?? 0
    );
  }
}

/** Rejects every detached dispatch synchronously: its cap is zero. */
export class CappedAgent extends TestAgent {
  override maxConcurrentAgentTools = 0;
}

/** A second step agent class, so a pipeline can span two namespaces. */
export class TestStepB extends TestAgent {}

/** A step agent on Think's own staleness cutoff, which `StepAgent` lifts. */
export class StaleAgent extends TestAgent {
  protected static override submissionRecoveryStaleMs =
    Think.submissionRecoveryStaleMs;
}

/** One task on the host, as JSON. */
export interface TaskDebug {
  row: {
    state: string;
    deliveryKey: string | null;
    hooksPending: boolean;
    stopPending: boolean;
  } | null;
  /** Every state the host's `onTaskSettled` fired with, for this task. */
  settledHooks: number[];
}

/**
 * The task host. Its pipeline is {@link TestTask}; the step agents it runs are
 * {@link TestAgent} and its siblings.
 */
export class TestHost extends TaskHost<TestEnv> {
  protected readonly copy = COPY;
  protected readonly workflowBinding = "TEST_TASK";
  protected readonly hostBinding = "TEST_HOST";

  /** A reply starting `lost:` is a completion report that never arrived. */
  override async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    if (
      (result as { reply?: string } | undefined)?.reply?.startsWith("lost:")
    ) {
      return;
    }
    await super.onWorkflowComplete(workflowName, workflowId, result);
  }

  protected override async onTaskSettled(
    taskId: string,
    state: TaskState
  ): Promise<void> {
    this
      .sql`CREATE TABLE IF NOT EXISTS test_settled (task_id TEXT, state INTEGER)`;
    this.sql`INSERT INTO test_settled VALUES (${taskId}, ${state})`;
  }

  async debugTask(taskId: string): Promise<string> {
    const row = this.ledger.row(taskId);
    this
      .sql`CREATE TABLE IF NOT EXISTS test_settled (task_id TEXT, state INTEGER)`;
    const debug: TaskDebug = {
      row: row
        ? {
            state: row.state,
            deliveryKey: row.deliveryKey,
            hooksPending: row.hooksPending,
            stopPending: row.stopPending
          }
        : null,
      settledHooks: this.sql<{ state: number }>`
        SELECT state FROM test_settled WHERE task_id = ${taskId}`.map(
        (r) => r.state
      )
    };
    return JSON.stringify(debug);
  }
}

/**
 * The test pipeline, keyed on the task's text like the scripted models:
 *
 *  - `two:<text>` — a step on each of two agents, the second fed the first's reply;
 *  - `approve:<text>` — plan, ask for approval, plan again on a rejection's
 *    feedback, and act once approved;
 *  - `role:<role>:<text>` — one step, with a role;
 *  - `say:<text>` — a progress line, then the one step;
 *  - `capped:<text>` — the one step, on {@link CappedAgent};
 *  - `stale:<text>` — the one step, on {@link StaleAgent};
 *  - `orphan:<text>` — the one step, beside a branch that throws while it works;
 *  - `twice:` — one label run twice;
 *  - `asks:` — two questions at once;
 *  - `retry-named:` — a step named as a retry;
 *  - `throw` — the pipeline throws;
 *  - anything else — one step on {@link TestAgent}, fed the text.
 */
export class TestTask extends TaskWorkflow<TestEnv> {
  override run(event: WorkflowEvent<TaskParams>, step: WorkflowStep) {
    return super.run(event, step);
  }

  protected async pipeline(
    event: WorkflowEvent<TaskParams>,
    step: TaskStep
  ): Promise<PipelineResult> {
    const text = event.payload.text;
    if (text === "throw") throw new Error("the pipeline threw");

    const two = after(text, "two:");
    if (two !== undefined) {
      const first = await step.agent("first", {
        agent: "TEST_AGENT",
        input: two
      });
      const second = await step.agent("second", {
        agent: "TEST_STEP_B",
        input: `echo:B saw ${first}`
      });
      return { reply: second };
    }

    const approve = after(text, "approve:");
    if (approve !== undefined) {
      let feedback = "";
      for (let n = 0; ; n++) {
        const plan = await step.agent("plan", {
          agent: "TEST_AGENT",
          input: `echo:plan ${n} for ${approve}${feedback}`,
          role: "plan",
          key: String(n)
        });
        const answer = await step.ask(`approve:${n}`, {
          kind: "approval",
          prompt: plan,
          allowFreeform: true
        });
        if (answer.optionId === HITL_APPROVE_OPTION_ID) {
          const done = await step.agent("code", {
            agent: "TEST_AGENT",
            input: `echo:did ${plan}`,
            role: "code"
          });
          return { reply: done };
        }
        feedback = ` (${answer.text ?? "rejected"})`;
        await step.say("Replanning.");
      }
    }

    const role = after(text, "role:");
    if (role !== undefined) {
      const [name, ...rest] = role.split(":");
      return {
        reply: await step.agent("main", {
          agent: "TEST_AGENT",
          input: rest.join(":"),
          role: name
        })
      };
    }

    const orphan = after(text, "orphan:");
    if (orphan !== undefined) {
      const [reply] = await Promise.all([
        step.agent("main", { agent: "TEST_AGENT", input: orphan }),
        (async () => {
          await step.sleep("orphan:pause", "1 second");
          throw new Error("the pipeline threw beside a working step");
        })()
      ]);
      return { reply };
    }

    if (text === "twice:") {
      await step.agent("main", { agent: "TEST_AGENT", input: "echo:once" });
      await step.agent("main", { agent: "TEST_AGENT", input: "echo:twice" });
      return { reply: "never" };
    }

    if (text === "asks:") {
      await Promise.all(
        ["one", "two"].map((name) =>
          step.ask(name, { kind: "approval", prompt: name })
        )
      );
      return { reply: "never" };
    }

    if (text === "retry-named:") {
      await step.agent("main:retry", { agent: "TEST_AGENT", input: "echo:x" });
      return { reply: "never" };
    }

    for (const [prefix, agent] of [
      ["capped:", "CAPPED_AGENT"],
      ["stale:", "STALE_AGENT"]
    ] as const) {
      const input = after(text, prefix);
      if (input !== undefined) {
        return { reply: await step.agent("main", { agent, input }) };
      }
    }

    const said = after(text, "say:");
    if (said !== undefined) await step.say(said);
    return {
      reply: await step.agent("main", {
        agent: "TEST_AGENT",
        input: said ?? text
      })
    };
  }
}

/** A pipeline that inherits `run()`: the constructor refuses it. */
export class NoRunTask extends TaskWorkflow<TestEnv> {
  protected async pipeline(): Promise<PipelineResult> {
    return { reply: "never" };
  }
}

/** Core's own class, exported unchanged. */
export { Artifacts } from "../src/artifacts/do.js";

const manifest: AgentManifest = {
  name: "da-core-test",
  description: "core's lifecycle test agent",
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

export const testHost = defineAgent({
  tenant: TEST_TENANT,
  manifest,
  agent: (env: TestEnv) => env.TEST_HOST
});

const a2a = createA2AWorker<TestEnv>({
  manifest,
  agents: [testHost]
});

/**
 * {@link PlainScheduled} and {@link DelegatingScheduled}, plain Durable Objects
 * for the `/alarm` specs — and the difference between them is the test.
 *
 * A lifecycle installs its runtime handlers only where the host does not
 * already have one, silently — so "the host defines its own `alarm()`" and "the
 * host does not" are two different installations of the same code, and only one
 * of them can be checked by reading it. {@link PlainScheduled} is the first,
 * {@link DelegatingScheduled} the second.
 */
export class PlainScheduled extends DurableObject<Cloudflare.Env> {
  /** In-memory, so a spec can see *that* a callback ran, not only its effect. */
  readonly marks: string[] = [];

  readonly wake = installScheduler(this, {
    callbacks: {
      mark: (payload: { at: string }) => {
        this.marks.push(payload.at);
      }
    }
  });
}

/** The shape the workspace object has: its own `alarm()`, delegating. */
export class DelegatingScheduled extends DurableObject<Cloudflare.Env> {
  readonly marks: string[] = [];
  /** Proves the host's own handler still runs after the lifecycle takes over. */
  ownAlarms = 0;

  readonly wake = installScheduler(this, {
    callbacks: {
      mark: (payload: { at: string }) => {
        this.marks.push(payload.at);
      }
    },
    hostOwns: ["alarm"]
  });

  override async alarm(): Promise<void> {
    this.ownAlarms += 1;
    await this.wake.alarm();
  }
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<TestEnv>;
