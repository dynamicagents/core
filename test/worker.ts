import type { TaskState } from "@a2a-js/sdk";
import type { ThinkModel } from "@cloudflare/think";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { handleArtifactRoute } from "../src/artifacts/route.js";
import type { AgentManifest } from "../src/a2a/card.js";
import type { CoreEnv } from "../src/env.js";
import { A2AAgent, type A2ACopy } from "../src/agent/agent.js";
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
 * something to bind: an `A2AAgent` on a rule-based model, a sub-agent it
 * awaits, one it detaches, and core's `Artifacts` object.
 *
 * Deliberately thin. Anything richer belongs in `starter`, where a real agent
 * is the thing being tested rather than the lifecycle.
 */

export interface TestEnv extends CoreEnv {
  TEST_AGENT: DurableObjectNamespace<TestAgent>;
  CAPPED_AGENT: DurableObjectNamespace<CappedAgent>;
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
  const text = view.lastUserText;
  if (text === "boom") return { error: "told to fail" };

  const answered = view.answered;
  const ask = after(text, "ask:");
  if (ask !== undefined) {
    return answered
      ? { text: "asked" }
      : call("ask_user", { question: ask, options: ["Yes", "No"] });
  }
  const wait = after(text, "wait:");
  if (wait !== undefined) {
    return answered
      ? { text: `waited ${wait}` }
      : call("test_wait", { seconds: Number(wait) });
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
  prepare: async ({ runId }) => ({ lease: `lease:${runId}` }),
  settle: async () => {}
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

/** Read one task's ledger, as JSON: what a callback cannot carry. */
export interface TaskDebug {
  row: {
    state: string;
    deliveryKey: string | null;
    hooksPending: boolean;
  } | null;
  work: { workId: string; kind: string; open: boolean; settled: boolean }[];
  runs: { runId: string; status: string }[];
  /** Every state `onTaskSettled` fired with, for this task. */
  settledHooks: number[];
}

export class TestAgent extends A2AAgent<TestEnv> {
  protected readonly copy = COPY;
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
      check_back: this.checkBackTool()
    };
  }

  /**
   * An object whose name starts `noprogress:` drops live notes, so a spec can
   * prove the finish replay delivers them.
   */
  override async onProgress(
    ...args: Parameters<A2AAgent<TestEnv>["onProgress"]>
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
  async debugTask(taskId: string): Promise<string> {
    const row = this.ledger.row(taskId);
    const runs: TaskDebug["runs"] = [];
    for (const work of this.ledger.workRows(taskId)) {
      if (work.kind === "wait") continue;
      const Cls = work.name === "TestBackground" ? TestBackground : TestChild;
      const child = await this.dynamicAgents.get(Cls, work.workId);
      const inspection = await child.inspectAgentToolRun(work.workId);
      runs.push({
        runId: work.workId,
        status: inspection?.status ?? "unknown"
      });
    }
    const debug: TaskDebug = {
      row: row
        ? {
            state: row.state,
            deliveryKey: row.deliveryKey,
            hooksPending: row.hooksPending
          }
        : null,
      work: this.ledger.workRows(taskId).map((w) => ({
        workId: w.workId,
        kind: w.kind,
        open: w.open,
        settled: w.settled
      })),
      runs,
      settledHooks: this.#settledHooks(taskId)
    };
    return JSON.stringify(debug);
  }

  #settledHooks(taskId: string): number[] {
    this
      .sql`CREATE TABLE IF NOT EXISTS test_settled (task_id TEXT, state INTEGER)`;
    return this.sql<{ state: number }>`
      SELECT state FROM test_settled WHERE task_id = ${taskId}`.map(
      (r) => r.state
    );
  }
}

/** Rejects every detached dispatch synchronously: its cap is zero. */
export class CappedAgent extends TestAgent {
  override maxConcurrentAgentTools = 0;
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

export const testAgent = defineAgent({
  tenant: TEST_TENANT,
  manifest,
  agent: (env: TestEnv) => env.TEST_AGENT
});

export const cappedAgent = defineAgent({
  tenant: "capped",
  manifest,
  agent: (env: TestEnv) => env.CAPPED_AGENT
});

const a2a = createA2AWorker<TestEnv>({
  manifest,
  agents: [testAgent, cappedAgent]
});

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
} satisfies ExportedHandler<TestEnv>;
