import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getAgentByName, type Agent } from "agents";
import {
  AgentWorkflow,
  type AgentWorkflowStep,
  type DefaultProgress
} from "agents/workflows";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import type { CoreEnv } from "../env.js";
import type { TaskHost } from "../task/host.js";
import {
  answerEventType,
  digest,
  reportEventType,
  stepJobIdFor
} from "./keys.js";
import type {
  AskRequest,
  NotedStepJob,
  ParkOutcome,
  PipelineResult,
  StepAnswer,
  StepJob,
  StepJobReport,
  TaskParams,
  TaskResult
} from "./types.js";

/**
 * Every wait passes the platform's ceiling. Unset, a wait gives up after a day
 * and fails the instance; a person's answer and a long coding job are both
 * allowed to take longer. The task's own bounds — the gatekeeper's, a
 * question's expiry, a cancel — end it sooner by stopping the instance.
 */
export const WAIT_CEILING = "365 days";

/** What `step.agent` runs a job with. */
export interface AgentStepOptions {
  /** The env binding of the step agent's namespace. The instance is the caller's. */
  agent: string;
  input: string;
  role?: string;
  /** Distinguishes repeats of one step name, as a loop makes. */
  key?: string;
}

/** The step helpers a pipeline gets, beside `step.do` and the rest. */
export interface TaskStep extends AgentWorkflowStep {
  /**
   * Run a job on a step agent and return its reply. A name ending in
   * `:retry` is refused: a failed job's second attempt runs under it.
   */
  agent(name: string, options: AgentStepOptions): Promise<string>;
  /** A progress line to the caller. */
  say(text: string): Promise<void>;
  /**
   * Park the task on a question to the caller, and return the answer. A task
   * holds one question at a time, so one asked while another waits fails.
   */
  ask(name: string, request: AskRequest): Promise<StepAnswer>;
}

/** The step agent surface a workflow and a host call. */
export interface StepAgentStub {
  startStepJob(job: StepJob): Promise<void>;
  answerStepJob(stepJobId: string, answer: StepAnswer): Promise<void>;
  cancelStepJob(stepJobId: string): Promise<void>;
  stepTaskSettled(taskId: string, state: number): Promise<void>;
}

/** The task host surface a workflow's steps call. */
export interface TaskHostStub {
  noteStepJob(taskId: string, job: NotedStepJob): Promise<boolean>;
  park(taskId: string, request: HitlRequestData): Promise<ParkOutcome>;
  progress(taskId: string, text: string, key: string): Promise<void>;
}

/** A job that reported `failed`: the one failure a step retries. */
class StepJobFailed extends Error {}

/**
 * A step's second attempt runs under its name plus this, so a step named with
 * it would take the retry's job.
 */
const RETRY_SUFFIX = ":retry";

/** The start step's retry: the RPCs it makes are short and idempotent. */
const START = {
  retries: { limit: 5, delay: "1 second", backoff: "exponential" },
  timeout: "5 minutes"
} as const;

/**
 * The task workflow: the sequence of a task's steps, and the state between
 * them. A subclass writes {@link pipeline}.
 *
 * **Every subclass declares `run()`**, as `override run(event, step) { return
 * super.run(event, step); }`. The agents SDK wraps `run()` — resolving the host,
 * adding the step helpers — only on the class it is constructed as, and only
 * when that class defines `run` itself. A subclass that inherited it would get
 * no host and no helpers, and nothing would say so; the constructor refuses one
 * instead.
 *
 * `run()` reports the pipeline's result and its throw as durable steps.
 * Returning notifies no agent, and the SDK's own report of a throw is
 * best-effort, so a pipeline cannot leave its task unsettled.
 *
 * Each helper names its steps under a prefix of its own (`agent:`, `ask:`,
 * `say:`), and a label used twice in one run is refused: a step whose name
 * repeats returns the first one's recorded result, silently.
 */
export abstract class TaskWorkflow<
  Env extends Cloudflare.Env & CoreEnv = Cloudflare.Env & CoreEnv
> extends AgentWorkflow<TaskHost<Env>, TaskParams, DefaultProgress, Env> {
  #steps: string[] = [];
  #labels = new Set<string>();
  #says = 0;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    if (!Object.hasOwn(Object.getPrototypeOf(this), "run")) {
      throw new TypeError(
        `${new.target.name} must declare run(): ` +
          "`override run(event, step) { return super.run(event, step); }`"
      );
    }
  }

  protected abstract pipeline(
    event: WorkflowEvent<TaskParams>,
    step: TaskStep
  ): Promise<PipelineResult>;

  override async run(
    event: WorkflowEvent<TaskParams>,
    step: WorkflowStep
  ): Promise<TaskResult> {
    // A replay runs the pipeline from the top: the counts start over with it.
    this.#steps = [];
    this.#labels = new Set();
    this.#says = 0;
    const taskStep = step as TaskStep;
    let result: TaskResult;
    try {
      const out = await this.pipeline(event, taskStep);
      result = {
        ...out,
        verdict: { outcome: out.outcome ?? "replied", steps: this.#steps }
      };
    } catch (err) {
      await taskStep.reportError(err instanceof Error ? err : String(err));
      throw err;
    }
    await taskStep.reportComplete(result);
    return result;
  }

  protected override extendStep(
    step: AgentWorkflowStep,
    event: WorkflowEvent<TaskParams>
  ): AgentWorkflowStep {
    const params = event.payload;
    const taskStep = step as TaskStep;
    taskStep.agent = (name, options) =>
      this.#agentStep(taskStep, params, name, options);
    taskStep.say = (text) => this.#say(taskStep, params, text);
    taskStep.ask = (name, request) =>
      this.#askStep(taskStep, params, name, request);
    return taskStep;
  }

  /**
   * Run a job, and run it once more if it fails. A failed report is a turn
   * that errored, and the work it did is kept, so a second attempt on the same
   * agent can carry on from it. What the agent is told about the retry is its
   * own `formatStepJobInput`'s, from the job's `attempt`. Anything else — a
   * closed task, a start that cannot be made — fails at once.
   */
  async #agentStep(
    step: TaskStep,
    params: TaskParams,
    name: string,
    options: AgentStepOptions
  ): Promise<string> {
    if (name.endsWith(RETRY_SUFFIX)) {
      throw new Error(
        `step "${name}": a name ending in "${RETRY_SUFFIX}" is a retry's`
      );
    }
    try {
      return await this.#job(step, params, name, options, 1);
    } catch (err) {
      if (!(err instanceof StepJobFailed)) throw err;
      return this.#job(step, params, `${name}${RETRY_SUFFIX}`, options, 2);
    }
  }

  /**
   * Start a job, then wait for its reports until it settles. The start is its
   * own step, and nothing holds an RPC open while the agent works: the agent
   * reports through `sendWorkflowEvent`, which a parked instance waits on
   * without holding concurrency.
   */
  async #job(
    step: TaskStep,
    params: TaskParams,
    name: string,
    options: AgentStepOptions,
    attempt: number
  ): Promise<string> {
    const stepJobId = await stepJobIdFor(this.workflowId, name, options.key);
    const label =
      options.key === undefined ? name : `${name}:${await digest(options.key)}`;
    this.#claim(`agent:${label}`);
    this.#steps.push(label);
    const job: StepJob = {
      stepJobId,
      taskId: params.taskId,
      contextId: params.contextId,
      input: options.input,
      attempt,
      ...(options.role ? { role: options.role } : {}),
      caller: params.caller,
      identity: params.identity,
      jku: params.jku,
      workflow: { name: this.workflowName, id: this.workflowId },
      host: { binding: params.hostBinding, name: params.callerKey }
    };

    await step.do(`agent:${label}:start`, START, async () => {
      // Noted before it starts, so a cancel landing in between still finds it.
      const noted = await (
        await this.#host(params)
      ).noteStepJob(params.taskId, { stepJobId, binding: options.agent });
      if (!noted) throw new NonRetryableError("the task is closed");
      await (await this.#stepAgent(options.agent, params)).startStepJob(job);
      return null;
    });

    for (let n = 0; ; n++) {
      const event = await step.waitForEvent<StepJobReport>(
        `agent:${label}:wait:${n}`,
        {
          type: await reportEventType(stepJobId, n),
          timeout: WAIT_CEILING
        }
      );
      const report = event.payload;
      if (report.state === "completed") return report.reply;
      if (report.state === "failed") throw new StepJobFailed(report.error);
      const answer = await this.#ask(
        step,
        params,
        `agent:${label}:${n}`,
        report.request
      );
      await step.do(`agent:${label}:answer:${n}`, START, async () => {
        await (
          await this.#stepAgent(options.agent, params)
        ).answerStepJob(stepJobId, answer);
        return null;
      });
    }
  }

  async #askStep(
    step: TaskStep,
    params: TaskParams,
    name: string,
    request: AskRequest
  ): Promise<StepAnswer> {
    this.#claim(`ask:${name}`);
    this.#steps.push(name);
    return this.#ask(step, params, `ask:${name}`, {
      type: HITL_REQUEST_TYPE,
      requestId: `${this.workflowId}:${name}`,
      requestKind: request.kind,
      prompt: request.prompt,
      ...(request.options ? { options: request.options } : {}),
      ...(request.allowFreeform !== undefined
        ? { allowFreeform: request.allowFreeform }
        : {})
    });
  }

  /** Park the task on a question, then wait for the host to relay the answer. */
  async #ask(
    step: TaskStep,
    params: TaskParams,
    label: string,
    request: HitlRequestData
  ): Promise<StepAnswer> {
    const parked = await step.do(`${label}:park`, START, async () => {
      const parked = await (
        await this.#host(params)
      ).park(params.taskId, request);
      if (parked === "closed") {
        throw new NonRetryableError("the task is closed");
      }
      return parked;
    });
    // Thrown outside the step, so the task's error keeps the reason.
    if (parked === "asking") {
      throw new Error(
        `"${label}" asked while the task waits on another question: ask one at a time`
      );
    }
    const event = await step.waitForEvent<StepAnswer>(`${label}:reply`, {
      type: await answerEventType(request.requestId),
      timeout: WAIT_CEILING
    });
    return event.payload;
  }

  /** Numbered, so saying one thing twice is two lines and a replay is none. */
  async #say(step: TaskStep, params: TaskParams, text: string): Promise<void> {
    const n = this.#says++;
    await step.do(`say:${n}`, START, async () => {
      await (
        await this.#host(params)
      ).progress(params.taskId, text, `say:${n}`);
      return null;
    });
  }

  /**
   * A label runs once per run, or its steps would replay another's results.
   * Thrown outside any step, so the instance's error keeps the message: a
   * `NonRetryableError` there reads only as "a step threw".
   */
  #claim(label: string): void {
    if (this.#labels.has(label)) {
      throw new Error(
        `step "${label}" ran twice in one run: give each repeat its own \`key\``
      );
    }
    this.#labels.add(label);
  }

  /**
   * Resolved inside each step, never held across one: a stub whose connection
   * broke never reconnects. Not `this.agent`, which the SDK resolves once per
   * `run()` and keeps for its own reports.
   */
  async #host(params: TaskParams): Promise<TaskHostStub> {
    return (await this.#resolve(
      params.hostBinding,
      params
    )) as unknown as TaskHostStub;
  }

  async #stepAgent(
    binding: string,
    params: TaskParams
  ): Promise<StepAgentStub> {
    return (await this.#resolve(binding, params)) as unknown as StepAgentStub;
  }

  /** Every object a task touches is the caller's: named by its key. */
  async #resolve(binding: string, params: TaskParams): Promise<unknown> {
    const ns = (this.env as Record<string, unknown>)[binding];
    if (!ns) throw new NonRetryableError(`no binding ${binding}`);
    return getAgentByName(
      ns as DurableObjectNamespace<Agent>,
      params.callerKey
    );
  }
}
