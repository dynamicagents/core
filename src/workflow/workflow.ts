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
import { digest, jobEventType, stepJobIdFor } from "./keys.js";
import type {
  AskRequest,
  CompleteOutcome,
  JobEvent,
  NotedStepJob,
  ParkOutcome,
  PipelineResult,
  Reconcile,
  StepAnswer,
  StepJob,
  TaskParams,
  TaskResult
} from "./types.js";

/** What `step.agent` runs a job with. */
export interface AgentStepOptions {
  /** The env binding of the step agent's namespace. The instance is the caller's. */
  agent: string;
  input: string;
  role?: string;
  /** Distinguishes repeats of one step name, as a loop makes. */
  key?: string;
  /**
   * Whether messages that join the task while this step runs are its input. A
   * task takes them for one step at a time; with no such step running, a
   * joining message starts a task of its own.
   */
  joins?: boolean;
  /** How long a wait for the job's next event lasts before it pulls. */
  reconcile: Reconcile;
}

/** What `step.ask` asks with. */
export interface AskStepOptions {
  /** How long a wait for the answer lasts before it pulls. */
  reconcile: Reconcile;
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
   * Ask the caller a question of the pipeline's own, and return the answer. A
   * question nobody answered before the gatekeeper gave up on it fails the
   * task.
   */
  ask(
    name: string,
    request: AskRequest,
    options: AskStepOptions
  ): Promise<StepAnswer>;
}

/** The step agent surface a workflow and a host call. */
export interface StepAgentStub {
  startStepJob(job: StepJob): Promise<void>;
  answerStepJob(
    stepJobId: string,
    requestId: string,
    answers: StepAnswer["answers"]
  ): Promise<void>;
  joinStepJob(
    stepJobId: string,
    message: { messageId: string; text: string }
  ): Promise<void>;
  expireStepJobQuestion(stepJobId: string, requestId: string): Promise<void>;
  completeStepJob(stepJobId: string): Promise<CompleteOutcome>;
  stepJobReports(
    stepJobId: string,
    from: number
  ): Promise<Extract<JobEvent, { from: "agent" }>[]>;
  cancelStepJob(stepJobId: string): Promise<void>;
  stepTaskSettled(taskId: string, state: number): Promise<void>;
}

/** The task host surface a workflow's steps call. */
export interface TaskHostStub {
  noteStepJob(taskId: string, job: NotedStepJob): Promise<boolean>;
  park(
    taskId: string,
    stepJobId: string,
    request: HitlRequestData
  ): Promise<ParkOutcome>;
  idle(taskId: string, branchId: string): Promise<void>;
  working(taskId: string, branchId: string): Promise<void>;
  endBranch(taskId: string, branchId: string): Promise<void>;
  handOver(
    taskId: string,
    stepJobId: string,
    to: string | null,
    from: number
  ): Promise<void>;
  closeJoins(
    taskId: string,
    stepJobId: string,
    from: number
  ): Promise<Extract<JobEvent, { from: "host" }>[]>;
  openJoins(taskId: string, stepJobId: string): Promise<void>;
  stepJobInputs(
    taskId: string,
    stepJobId: string,
    from: number
  ): Promise<Extract<JobEvent, { from: "host" }>[]>;
  progress(taskId: string, text: string, key: string): Promise<void>;
}

/** A job that reported `failed`: the one failure a step retries. */
class StepJobFailed extends Error {}

/**
 * How long a job's next wait lasts: back to `afterMs` once anything arrived,
 * twice the last while nothing does, never past `maxMs`. So a wait nobody
 * answers costs about one wake per `maxMs` once it has doubled up to it, and
 * each wake is two steps of an instance's ceiling (the wait and its pull).
 */
export function nextWait(
  reconcile: Reconcile,
  current: number,
  found: boolean
): number {
  return found ? reconcile.afterMs : Math.min(current * 2, reconcile.maxMs);
}

/** Where a reader is: the next number it wants from each writer. */
interface Cursor {
  agent: number;
  host: number;
}

/**
 * Reads one job's events in each writer's own order, each once.
 *
 * The platform keeps every event sent under a type and hands them out in the
 * order they arrived, which for two sends in flight at once is either order.
 * So each writer numbers its own, a number already read is dropped, and a
 * number past the next one is a gap the reader pulls from that writer first.
 *
 * Every wait is bounded. One that ends without an event pulls both writers
 * from where the cursor stands; one that finds nothing owed doubles the next
 * wait, up to the ceiling, and anything arriving starts it over. Everything it
 * decides it decides from step results, so a replay reads the same way.
 */
class JobReader {
  readonly cursor: Cursor = { agent: 0, host: 0 };
  #waits = 0;
  #pulls = 0;
  #wait: number;
  #held: JobEvent[] = [];

  constructor(
    private readonly step: TaskStep,
    private readonly prefix: string,
    private readonly type: string,
    private readonly reconcile: Reconcile,
    private readonly pull: (
      next: Cursor & { attempt: number }
    ) => Promise<JobEvent[]>
  ) {
    this.#wait = reconcile.afterMs;
  }

  /** The next events in order: one or more, after as many waits as it takes. */
  async next(): Promise<JobEvent[]> {
    for (;;) {
      const held = this.#take([]);
      if (held.length > 0) return held;
      let arrived: JobEvent | null = null;
      try {
        const event = await this.step.waitForEvent<JobEvent>(
          `${this.prefix}:event:${this.#waits++}`,
          { type: this.type, timeout: this.#wait }
        );
        arrived = event.payload as JobEvent;
      } catch {
        // A timeout, or a wait an eviction cut: either way, pull. The pull only
        // reads, so a replay that finds the event there instead loses nothing.
      }
      if (arrived && arrived.seq <= this.cursor[arrived.from]) {
        const ready = this.#take([arrived]);
        this.#wait = nextWait(this.reconcile, this.#wait, ready.length > 0);
        if (ready.length > 0) return ready;
        continue;
      }
      const pulled = await this.pull({
        ...this.cursor,
        attempt: this.#pulls++
      });
      const ready = this.#take(arrived ? [arrived, ...pulled] : pulled);
      this.#wait = nextWait(this.reconcile, this.#wait, ready.length > 0);
      if (ready.length > 0) return ready;
    }
  }

  /** Events read some other way, the host's unread inputs among them. */
  unread(events: JobEvent[]): void {
    this.#held.push(...events);
  }

  /**
   * The events that are next in each writer's order, in the order they came,
   * with anything already read dropped and anything past a gap held back.
   */
  #take(events: JobEvent[]): JobEvent[] {
    const candidates = [...this.#held, ...events];
    const ready: JobEvent[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const event of candidates) {
        if (event.seq !== this.cursor[event.from]) continue;
        ready.push(event);
        this.cursor[event.from] += 1;
        progressed = true;
      }
    }
    this.#held = candidates.filter((e) => e.seq >= this.cursor[e.from]);
    return ready;
  }
}

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
    taskStep.ask = (name, request, options) =>
      this.#askStep(taskStep, params, name, request, options);
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
   * Start a job, then read its events until it finishes. The start is its own
   * step, and nothing holds an RPC open while the agent works: the agent's
   * reports and the host's inputs both arrive as events under the job's one
   * type, which a waiting instance holds no concurrency for.
   *
   * Every input reaches the agent from here, after this has read it, so the
   * workflow knows of every wait and what ended it. Every wait is bounded: one
   * that times out pulls from both writers what this has not read, so an event
   * the platform loses costs a delay and not the task.
   *
   * The job finishes here, not on the agent's word: only this sees whether an
   * input is already on its way when the agent goes idle with nothing open.
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
      ).noteStepJob(params.taskId, {
        stepJobId,
        binding: options.agent,
        ...(options.joins ? { joins: true } : {})
      });
      if (!noted) throw new NonRetryableError("the task is closed");
      await (await this.#stepAgent(options.agent, params)).startStepJob(job);
      return null;
    });

    const prefix = `agent:${label}`;
    const reader = new JobReader(
      step,
      prefix,
      await jobEventType(stepJobId),
      options.reconcile,
      (next) =>
        step.do(`${prefix}:pull:${next.attempt}`, START, async () => [
          ...(await (
            await this.#stepAgent(options.agent, params)
          ).stepJobReports(stepJobId, next.agent)),
          ...(await (
            await this.#host(params)
          ).stepJobInputs(params.taskId, stepJobId, next.host))
        ])
    );

    // The host's inputs handed to the agent so far. Not the reader's cursor,
    // which a batch of events advances past inputs this loop has yet to hand.
    let handed = 0;
    for (;;) {
      for (const event of await reader.next()) {
        if (event.from === "host") {
          handed = event.seq + 1;
          await step.do(`${prefix}:input:${event.seq}`, START, async () => {
            const agent = await this.#stepAgent(options.agent, params);
            const input = event.input;
            if (input.kind === "answer") {
              await agent.answerStepJob(
                stepJobId,
                input.requestId,
                input.answers
              );
            } else if (input.kind === "join") {
              await agent.joinStepJob(stepJobId, {
                messageId: input.messageId,
                text: input.text
              });
            } else {
              await agent.expireStepJobQuestion(stepJobId, input.requestId);
            }
            return null;
          });
          continue;
        }
        const report = event.report;
        const at = `${prefix}:${report.kind}:${event.seq}`;
        if (report.kind === "failed") {
          // The retry takes over the branch, with the messages that joined
          // this attempt and it never read.
          const retry =
            attempt === 1
              ? await stepJobIdFor(
                  this.workflowId,
                  `${name}${RETRY_SUFFIX}`,
                  options.key
                )
              : null;
          await step.do(`${at}:hand-over`, START, async () => {
            await (
              await this.#host(params)
            ).handOver(params.taskId, stepJobId, retry, handed);
            return null;
          });
          throw new StepJobFailed(report.error);
        }
        if (report.kind === "asked") {
          await step.do(at, START, async () => {
            const parked = await (
              await this.#host(params)
            ).park(params.taskId, stepJobId, report.request);
            if (parked === "closed") {
              throw new NonRetryableError("the task is closed");
            }
            return null;
          });
          continue;
        }
        if (report.kind === "working" || report.open.length > 0) {
          await step.do(at, START, async () => {
            const host = await this.#host(params);
            if (report.kind === "working") {
              await host.working(params.taskId, stepJobId);
            } else await host.idle(params.taskId, stepJobId);
            return null;
          });
          continue;
        }
        // Idle with nothing open: finished, unless an input is already here.
        const unread = await step.do(`${at}:close`, START, async () =>
          (await this.#host(params)).closeJoins(
            params.taskId,
            stepJobId,
            handed
          )
        );
        const outcome: CompleteOutcome =
          unread.length > 0
            ? { done: false }
            : await step.do(`${at}:complete`, START, async () => {
                const done = await (
                  await this.#stepAgent(options.agent, params)
                ).completeStepJob(stepJobId);
                if (done.done) {
                  await (
                    await this.#host(params)
                  ).endBranch(params.taskId, stepJobId);
                }
                return done;
              });
        if (outcome.done) return outcome.reply;
        // It carries on, so what it would have ended on is said now.
        await step.do(`${at}:carry-on`, START, async () => {
          const host = await this.#host(params);
          if (unread.length === 0)
            await host.openJoins(params.taskId, stepJobId);
          if (report.reply) {
            await host.progress(
              params.taskId,
              report.reply,
              `${stepJobId}:${at}`
            );
          }
          return null;
        });
        reader.unread(unread);
      }
    }
  }

  async #askStep(
    step: TaskStep,
    params: TaskParams,
    name: string,
    request: AskRequest,
    options: AskStepOptions
  ): Promise<StepAnswer> {
    this.#claim(`ask:${name}`);
    this.#steps.push(name);
    const prefix = `ask:${name}`;
    // A job id of its own, so its answer travels the way a job's input does.
    const askId = `${this.workflowId}:ask:${name}`;
    const requestId = `${this.workflowId}:${name}`;
    await step.do(`${prefix}:park`, START, async () => {
      const parked = await (
        await this.#host(params)
      ).park(params.taskId, askId, {
        ...request,
        type: HITL_REQUEST_TYPE,
        requestId
      });
      if (parked === "closed") {
        throw new NonRetryableError("the task is closed");
      }
      // A branch that waits on the person until answered, so a pipeline that
      // waits on nothing else stops the gatekeeper's clock.
      await (await this.#host(params)).idle(params.taskId, askId);
      return null;
    });
    const reader = new JobReader(
      step,
      prefix,
      await jobEventType(askId),
      options.reconcile,
      (next) =>
        step.do(`${prefix}:pull:${next.attempt}`, START, async () =>
          (await this.#host(params)).stepJobInputs(
            params.taskId,
            askId,
            next.host
          )
        )
    );
    for (;;) {
      for (const event of await reader.next()) {
        if (event.from !== "host" || event.input.kind === "join") continue;
        const input = event.input;
        await step.do(`${prefix}:done`, START, async () => {
          await (await this.#host(params)).endBranch(params.taskId, askId);
          return null;
        });
        if (input.kind === "expiry") {
          throw new NonRetryableError(`"${name}" was never answered`);
        }
        return { answers: input.answers };
      }
    }
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
