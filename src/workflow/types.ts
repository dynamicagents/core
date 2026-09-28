import type {
  HitlOption,
  HitlRequestData,
  HitlRequestKind
} from "@dynamicagents/g2a-protocol";
import type { GatekeeperIdentity } from "../a2a/verify.js";

/**
 * What the task host, the task workflow and a step agent say to each other.
 * Strings and JSON throughout: each crosses a Durable Object RPC or a
 * Workflow's event, and a Workflow persists every one it receives.
 */

/** The params a task host starts its workflow with, one instance per task. */
export interface TaskParams {
  taskId: string;
  contextId: string;
  messageId: string;
  text: string;
  identity: GatekeeperIdentity;
  /** The verified caller's key: the host's name, and each step agent's. */
  callerKey: string;
  /** The caller block's text, rendered by the host. */
  caller: string;
  /** Where this deployment's own origin is learned from. */
  jku: string;
  /** The host's own binding, which step agents reach it through. */
  hostBinding: string;
}

/**
 * One unit of work a workflow step hands a step agent. A step agent runs it
 * over as many turns as it needs, and reports once it settles.
 */
export interface StepJob {
  stepJobId: string;
  /** The A2A task, for attribution, the transcript and the end-of-task notice. */
  taskId: string;
  contextId: string;
  input: string;
  /** 1, or 2 for the retry of a job that failed: the agent says what that means. */
  attempt: number;
  /** What the agent is asked to be for this job. The agent owns what it means. */
  role?: string;
  caller: string;
  identity: GatekeeperIdentity;
  jku: string;
  /** The binding name and instance its reports go to. */
  workflow: { name: string; id: string };
  /** The task host, for progress lines. */
  host: { binding: string; name: string };
}

/** What a step agent reports, one event per report. */
export type StepJobReport =
  | { state: "input-required"; request: HitlRequestData }
  | { state: "completed"; reply: string }
  | { state: "failed"; error: string };

/** A person's answer, as the host relays it to the workflow. */
export interface StepAnswer {
  optionId?: string;
  text?: string;
}

/** What `step.ask` asks. */
export interface AskRequest {
  kind: HitlRequestKind;
  prompt: string;
  options?: HitlOption[];
  allowFreeform?: boolean;
}

/** What a pipeline returns. */
export interface PipelineResult {
  reply: string;
  /** Set for a task that ended as an answer other than success. */
  outcome?: string;
}

/**
 * The instance output. The verdict is what makes a task that ended as a value
 * other than success visible in Workflow status, which otherwise reads
 * `complete` for it.
 */
export interface TaskResult extends PipelineResult {
  verdict: { outcome: string; steps: string[] };
}

/**
 * What a park found: the task `parked` on the question, `closed`, or already
 * `asking` another — a task holds one question at a time.
 */
export type ParkOutcome = "parked" | "closed" | "asking";

/** A noted step job: where the host reaches its agent to stop or notify it. */
export interface NotedStepJob {
  stepJobId: string;
  binding: string;
}
