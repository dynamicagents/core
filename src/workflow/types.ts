import type { HitlAnswer, HitlRequestData } from "@dynamicagents/g2a-protocol";
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
  /**
   * The verified caller's scope: the host's name, and each step agent's. The
   * composed name and not the claimed key alone, which is
   * {@link file://../a2a/caller-scope.ts VerifiedCaller}'s to spell.
   */
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

/** What a step agent reports about a job, one event per report. */
export type StepJobReport =
  /** A turn asked the person something: one request of any number open. */
  | { kind: "asked"; request: HitlRequestData }
  /** The job went back to work after idling: an input or a result woke it. */
  | { kind: "working" }
  /**
   * Nothing runs for the job: no turn queued or running, no work open. With
   * requests open it waits on the person; with none it is finished, unless an
   * input is already on its way, and `reply` is what it would end on.
   */
  | { kind: "idle"; open: string[]; reply: string }
  /** A turn errored: the job failed, and its step may run it again. */
  | { kind: "failed"; error: string };

/** What the host relays to a job, in the order it took them. */
export type StepInput =
  /** A person's answers to one request, one per question, keyed by its id. */
  | { kind: "answer"; requestId: string; answers: Record<string, HitlAnswer> }
  /** A message that joined the task while it was open. */
  | { kind: "join"; messageId: string; text: string }
  /** A request nobody answered before the gatekeeper gave up on it. */
  | { kind: "expiry"; requestId: string };

/**
 * One event under a job's type (`jobEventType`). Each writer numbers its own
 * from 0, because the platform keeps only arrival order: a duplicate is a seq
 * already read, and a gap is one not yet arrived.
 */
export type JobEvent =
  | { from: "agent"; seq: number; report: StepJobReport }
  | { from: "host"; seq: number; input: StepInput };

/** A step agent's answer to finishing a job it reported idle with nothing open. */
export type CompleteOutcome = { done: true; reply: string } | { done: false };

/**
 * How a job's waits are bounded. Each wait gives up after `afterMs`; one that
 * finds nothing owed doubles the next, up to `maxMs`, and anything arriving
 * resets it. Supplied by the consumer: core ships no numbers.
 */
export interface Reconcile {
  afterMs: number;
  maxMs: number;
}

/** A person's answers to a pipeline's own question (`step.ask`). */
export interface StepAnswer {
  /** One per question, keyed by the question's id. */
  answers: Record<string, HitlAnswer>;
}

/** What `step.ask` asks: the questions, and why, in the protocol's own shape. */
export type AskRequest = Omit<HitlRequestData, "type" | "requestId">;

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

/** What a park found: the request asked of the task, or the task `closed`. */
export type ParkOutcome = "parked" | "closed";

/** A noted step job: where the host reaches its agent to stop or notify it. */
export interface NotedStepJob {
  stepJobId: string;
  binding: string;
  /** Whether messages that join the task are relayed to this job. */
  joins?: boolean;
}
