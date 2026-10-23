import {
  DurableObject,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID
} from "@dynamicagents/g2a-protocol";
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
  JobEvent,
  PipelineResult,
  Reconcile,
  StepJob,
  TaskParams
} from "../src/workflow/types.js";
import type { SubAgentSpec } from "../src/contract/subagent.js";
import { SubAgent, type SubAgentClass } from "../src/subagent/subagent.js";
import { createA2AWorker, defineAgent } from "../src/worker/index.js";
import {
  askApproval,
  askForm,
  askUser,
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
  emptyReply: "I finished, but had nothing to say."
};

/**
 * Short, so a spec that loses an event sees the pull within a second or two.
 * A deployment's own are minutes: see `Reconcile`.
 */
export const RECONCILE: Reconcile = { afterMs: 1_000, maxMs: 4_000 };

/**
 * Swallow the next send of one numbered event while reporting it sent: what the
 * platform did to the report a task waited a year for. Durable, so a spec sets
 * it before the event exists.
 */
function dropsEvent(
  sql: TestAgent["sql"],
  event: { payload: unknown }
): boolean {
  sql`CREATE TABLE IF NOT EXISTS test_drops (from_ TEXT, seq INTEGER)`;
  const payload = event.payload as Partial<JobEvent> | undefined;
  if (!payload?.from || payload.seq === undefined) return false;
  return (
    sql<{ seq: number }>`DELETE FROM test_drops
      WHERE from_ = ${payload.from} AND seq = ${payload.seq}
      RETURNING seq`.length > 0
  );
}

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
  const reason = after(text, "reason:");
  if (reason !== undefined) {
    return { reasoning: "weighing it up", text: reason };
  }
  const ask = after(text, "ask:");
  if (ask !== undefined) {
    return answered ? { text: "asked" } : askUser(ask, ["Yes", "No"]);
  }
  const artifact = after(text, "approve-artifact:");
  if (artifact !== undefined) {
    return answered
      ? { text: lastToolOutput(view) }
      : askApproval("Approve this?", artifact);
  }
  // Several questions in one call: a choice explained, a choice of many, and
  // words. The answers come back as one message, which is echoed.
  if (text === "form:") {
    return askForm({
      prompt: "Before I start:",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [
            { label: "Postgres", description: "The one in production." },
            { label: "SQLite" }
          ]
        },
        {
          question: "Which checks must pass?",
          options: [{ label: "lint" }, { label: "test" }],
          multiple: true
        },
        { question: "What should it be called?" }
      ]
    });
  }
  // A choice beside an approval, in one call.
  const approveForm = after(text, "approve-form:");
  if (approveForm !== undefined) {
    return answered
      ? { text: lastToolOutput(view) }
      : askForm({
          questions: [
            {
              question: "Which merge?",
              options: [{ label: "Squash" }, { label: "Rebase" }]
            },
            { question: "Approve this?", artifact: approveForm }
          ]
        });
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
  // Start a run in the background, then ask the person something while it
  // works: the result lands on a job that is waiting on an answer.
  const bgask = after(text, "bgask:");
  if (bgask !== undefined) {
    return answered
      ? askUser("Carry on?", ["Yes", "No"])
      : call("test_background", { task: bgask }, "Started in the background.");
  }
  // A background result that needs the person: its follow-up turn asks about
  // it, by the child's own words.
  const result = /child did: (please-ask\S*)/.exec(text)?.[1];
  if (result !== undefined) {
    return answered
      ? { text: lastToolOutput(view) }
      : askUser(`About ${result}?`, ["Yes", "No"]);
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
  // Two steps, each saying something before its tool call, and the first
  // sentence in several deltas: what the pre-call flush is read through. The
  // first call parks in `test_hold`, so the spec reads that sentence with the
  // step provably still open.
  const narrate = after(text, "narrate:");
  if (narrate !== undefined) {
    const out = lastToolOutput(view);
    if (out === "marked") return { text: "narrated" };
    if (out.includes("held")) return call("test_mark", {}, "Then marking.");
    return call("test_hold", { key: narrate }, ["  First, ", "waiting.\n"]);
  }
  // One step, two calls, a sentence before each: only the first is flushed. The
  // last call parks, so the step stays open while the spec reads what arrived.
  const twocalls = after(text, "twocalls:");
  if (twocalls !== undefined) {
    return answered
      ? { text: "both ran" }
      : {
          text: "Before the first.",
          calls: [
            { toolName: "test_mark", input: {} },
            {
              toolName: "test_hold",
              input: { key: twocalls },
              text: "Before the second."
            }
          ]
        };
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

/**
 * A sub-agent's script: `sleep:N` sleeps in a tool, narrating first. `cut:N`
 * says `step k.` and parks in `child_park`, N times, then answers: a spec
 * evicts the object at each park.
 */
function childRule(view: ModelTurnView): MockStep {
  const text = view.lastUserText;
  if (text === "fail") return { error: "child told to fail" };
  if (text === "note-at") {
    return view.answered
      ? { text: "child did: note-at" }
      : call("child_note_at", {}, "noting");
  }
  // Says something, so the run files notes on the page it was given.
  if (text.startsWith("same-page:")) {
    return view.answered
      ? { text: `child did: ${text}` }
      : call("child_sleep", { seconds: 0 }, `working on ${text}`);
  }
  const sleep = after(text, "sleep:");
  if (sleep !== undefined) {
    return view.answered
      ? { text: `child did: sleep:${sleep}` }
      : call("child_sleep", { seconds: Number(sleep) }, `working on ${text}`);
  }
  // Read off the run's own message: a recovery asks with a prompt of its own.
  const cut = userTexts(view)
    .map((said) => after(said, "cut:"))
    .find((n) => n !== undefined);
  if (cut !== undefined) {
    const said = stepsSaid(view);
    return said < Number(cut)
      ? call("child_park", {}, `step ${said + 1}.`)
      : { text: "the answer." };
  }
  return { text: `child did: ${text}` };
}

function userTexts(view: ModelTurnView): string[] {
  return view.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []));
}

/**
 * How many `step k.` the assistant has said. Counted from its text, not its
 * tool results: a cut can lose the call that followed one.
 */
function stepsSaid(view: ModelTurnView): number {
  return view.prompt
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text" && /^step \d+\.$/.test(part.text))
    .length;
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
    // `same-page:<page>` carries on whichever run wrote that page before.
    const page = /^same-page:([^:]+)/.exec(input.task)?.[1];
    return { lease: `lease:${runId}`, ...(page ? { page } : {}) };
  },
  transcriptKey: ({ runtime }) =>
    typeof runtime?.page === "string" ? `page:${runtime.page}` : undefined,
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

/** When `child_note_at`'s note says it happened. */
export const EARLIER_NOTE_AT = 1_700_000_000_000;

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
      }),
      child_note_at: tool({
        description: "File a note that happened before it is filed.",
        inputSchema: z.object({}),
        execute: async () => {
          await this.note(
            "child:at",
            "an earlier note",
            undefined,
            EARLIER_NOTE_AT
          );
          return { noted: true };
        }
      }),
      child_park: tool({
        description: "Work until the object is evicted.",
        inputSchema: z.object({}),
        execute: async (_input, { abortSignal }) => {
          this.sql`CREATE TABLE IF NOT EXISTS test_parks (at INTEGER)`;
          this.sql`INSERT INTO test_parks VALUES (${Date.now()})`;
          await sleep(60_000, abortSignal);
          return { parked: true };
        }
      })
    };
  }

  /**
   * Age this run's turn by `ms`, as the runtime's ceiling ages one it cuts:
   * Think reads a turn's age from its chat fiber, its task run and its stream.
   */
  async debugAge(ms: number): Promise<number> {
    let aged = 0;
    for (const table of [
      "cf_agents_runs",
      "cf_agents_task_runs",
      "cf_agents_streams"
    ]) {
      aged += this.ctx.storage.sql.exec(
        `UPDATE ${table} SET created_at = created_at - ?`,
        ms
      ).rowsWritten;
    }
    return aged;
  }

  /** How often this run parked in `child_park`, and the messages it wrote. */
  async debugRun(): Promise<{ parks: number; assistantMessages: number }> {
    this.sql`CREATE TABLE IF NOT EXISTS test_parks (at INTEGER)`;
    return {
      parks:
        this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM test_parks`[0]?.n ??
        0,
      assistantMessages: (await this.getMessages()).filter(
        (m) => m.role === "assistant"
      ).length
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
  report: {
    kind: string;
    reply?: string;
    error?: string;
    open?: string[];
    request?: { requestId: string };
  };
  sent: boolean;
}

/** One job's ledger, as JSON: what a report cannot carry. */
export interface JobDebug {
  /** The job's state, and the requests it still waits on. */
  row: { state: string; open: string[] } | null;
  work: {
    workId: string;
    kind: string;
    name: string;
    open: boolean;
    settled: boolean;
  }[];
  runs: {
    runId: string;
    status: string;
    parks: number;
    assistantMessages: number;
  }[];
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

  /** A parked `test_hold`, by key, with the resolve that frees it. */
  readonly #holding = new Map<string, () => void>();
  /**
   * Keys released before any turn parked on them. Without this latch a release
   * that wins the race against the tool call is simply lost, and the turn it
   * was meant to free parks until the object dies — a hang where the hold is
   * there to buy certainty.
   */
  readonly #releasedHolds = new Set<string>();

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
      }),
      test_hold: tool({
        description: "Wait in this turn until the caller releases it.",
        inputSchema: z.object({ key: z.string() }),
        execute: ({ key }, { abortSignal }) => this.#hold(key, abortSignal)
      })
    };
  }

  /**
   * Park the turn until {@link releaseHold}, so a spec holds a step open for as
   * long as it needs rather than racing a sleep: what the pre-tool-call flush
   * is read through in `src/agent/agent.spec.ts`. Abort-aware like
   * {@link waitTool}, so a canceled turn does not stay parked.
   */
  #hold(key: string, signal?: AbortSignal): Promise<{ held: string }> {
    if (this.#releasedHolds.delete(key)) return Promise.resolve({ held: key });
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const onAbort = () => {
        this.#holding.delete(key);
        reject(new Error("aborted"));
      };
      this.#holding.set(key, () => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ held: key });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The keys parked in `test_hold` right now. */
  async debugHolding(): Promise<string[]> {
    return [...this.#holding.keys()];
  }

  /** Lose report `seq` of any job on this object: see {@link dropsEvent}. */
  async dropReport(seq: number): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS test_drops (from_ TEXT, seq INTEGER)`;
    this.sql`INSERT INTO test_drops VALUES ('agent', ${seq})`;
  }

  override async sendWorkflowEvent(
    ...args: Parameters<StepAgent<TestEnv>["sendWorkflowEvent"]>
  ): Promise<void> {
    if (dropsEvent(this.sql.bind(this), args[2])) return;
    await super.sendWorkflowEvent(...args);
  }

  /** Free a parked `test_hold`, or the next turn that parks on that key. */
  async releaseHold(key: string): Promise<void> {
    const free = this.#holding.get(key);
    if (!free) {
      this.#releasedHolds.add(key);
      return;
    }
    this.#holding.delete(key);
    free();
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
        status: inspection?.status ?? "unknown",
        ...(await child.debugRun())
      });
    }
    const debug: JobDebug = {
      row: row
        ? { state: row.state, open: this.ledger.openRequests(stepJobId) }
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

  /** Lose input `seq` of any job on this host: see {@link dropsEvent}. */
  async dropInput(seq: number): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS test_drops (from_ TEXT, seq INTEGER)`;
    this.sql`INSERT INTO test_drops VALUES ('host', ${seq})`;
  }

  override async sendWorkflowEvent(
    ...args: Parameters<TaskHost<TestEnv>["sendWorkflowEvent"]>
  ): Promise<void> {
    if (dropsEvent(this.sql.bind(this) as TestAgent["sql"], args[2])) return;
    await super.sendWorkflowEvent(...args);
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
 *  - `asks:`: two questions at once, both answered;
 *  - `solo:<text>`: the one step, taking no joined messages;
 *  - `retry-named:` — a step named as a retry;
 *  - `throw` — the pipeline throws;
 *  - anything else: one step on {@link TestAgent}, fed the text, taking the
 *    messages that join the task.
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
        input: two,
        reconcile: RECONCILE
      });
      const second = await step.agent("second", {
        agent: "TEST_STEP_B",
        input: `echo:B saw ${first}`,
        reconcile: RECONCILE
      });
      return { reply: second };
    }

    // One words question under a caller-chosen id; the reply is the answer.
    const askId = after(text, "ask-id:");
    if (askId !== undefined) {
      const { answers } = await step.ask(
        "ask-id",
        {
          questions: [{ kind: "text", id: askId, prompt: `Asked as ${askId}` }]
        },
        { reconcile: RECONCILE }
      );
      return { reply: answers[askId]?.text ?? "" };
    }

    const approve = after(text, "approve:");
    if (approve !== undefined) {
      let feedback = "";
      for (let n = 0; ; n++) {
        const plan = await step.agent("plan", {
          agent: "TEST_AGENT",
          input: `echo:plan ${n} for ${approve}${feedback}`,
          role: "plan",
          key: String(n),
          reconcile: RECONCILE
        });
        const { answers } = await step.ask(
          `approve:${n}`,
          {
            questions: [
              {
                kind: "choice",
                id: "plan",
                prompt: plan,
                options: [
                  { id: HITL_APPROVE_OPTION_ID, label: "Approve" },
                  { id: HITL_REJECT_OPTION_ID, label: "Reject" }
                ]
              }
            ]
          },
          { reconcile: RECONCILE }
        );
        if (answers.plan?.optionIds?.[0] === HITL_APPROVE_OPTION_ID) {
          const done = await step.agent("code", {
            agent: "TEST_AGENT",
            input: `echo:did ${plan}`,
            role: "code",
            reconcile: RECONCILE
          });
          return { reply: done };
        }
        feedback = ` (${answers.plan?.text ?? "rejected"})`;
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
          role: name,
          reconcile: RECONCILE
        })
      };
    }

    const orphan = after(text, "orphan:");
    if (orphan !== undefined) {
      const [reply] = await Promise.all([
        step.agent("main", {
          agent: "TEST_AGENT",
          input: orphan,
          reconcile: RECONCILE
        }),
        (async () => {
          await step.sleep("orphan:pause", "1 second");
          throw new Error("the pipeline threw beside a working step");
        })()
      ]);
      return { reply };
    }

    if (text === "twice:") {
      await step.agent("main", {
        agent: "TEST_AGENT",
        input: "echo:once",
        reconcile: RECONCILE
      });
      await step.agent("main", {
        agent: "TEST_AGENT",
        input: "echo:twice",
        reconcile: RECONCILE
      });
      return { reply: "never" };
    }

    if (text === "asks:") {
      const answers = await Promise.all(
        ["one", "two"].map((name) =>
          step.ask(
            name,
            { questions: [{ kind: "text", id: "q1", prompt: name }] },
            { reconcile: RECONCILE }
          )
        )
      );
      return { reply: answers.map((a) => a.answers.q1?.text).join(" and ") };
    }

    if (text === "retry-named:") {
      await step.agent("main:retry", {
        agent: "TEST_AGENT",
        input: "echo:x",
        reconcile: RECONCILE
      });
      return { reply: "never" };
    }

    for (const [prefix, agent] of [
      ["capped:", "CAPPED_AGENT"],
      ["stale:", "STALE_AGENT"]
    ] as const) {
      const input = after(text, prefix);
      if (input !== undefined) {
        return {
          reply: await step.agent("main", {
            agent,
            input,
            reconcile: RECONCILE
          })
        };
      }
    }

    // One step that takes no joined messages: one sent onto the task is refused.
    const solo = after(text, "solo:");
    if (solo !== undefined) {
      return {
        reply: await step.agent("main", {
          agent: "TEST_AGENT",
          input: solo,
          reconcile: RECONCILE
        })
      };
    }

    const said = after(text, "say:");
    if (said !== undefined) await step.say(said);
    return {
      reply: await step.agent("main", {
        agent: "TEST_AGENT",
        input: said ?? text,
        joins: true,
        reconcile: RECONCILE
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
