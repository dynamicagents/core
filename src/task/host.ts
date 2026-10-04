import { Agent, getAgentByName } from "agents";
import { Task, TaskState } from "@a2a-js/sdk";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import type { AcceptedTurn } from "../a2a/executor.js";
import type { TaskListPage, TaskListQuery } from "../a2a/agent-stub.js";
import { callerContext } from "../a2a/caller.js";
import { buildInputRequiredTask, type HumanReply } from "../a2a/hitl.js";
import { buildCompletedTask, buildFailedTask } from "../a2a/notify.js";
import { createPushChannel, type PushChannel } from "../a2a/push.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import { assertArtifactsBound } from "../artifacts/binding.js";
import { settleTranscript } from "../artifacts/transcript.js";
import type { CoreEnv } from "../env.js";
import { isTerminalState, TASK_RETENTION_MS } from "../ledger.js";
import { answerEventType } from "../workflow/keys.js";
import type { ParkOutcome, StepAnswer, TaskResult } from "../workflow/types.js";
import type { StepAgentStub } from "../workflow/workflow.js";
import { TaskRuns, type NoticeJob } from "./runs.js";
import { A2ATasks, questionKey, type OwedAnswer } from "./tasks.js";

/** The user-facing strings core needs and never writes. */
export interface A2ACopy {
  /** A task whose workflow failed. */
  failed: string;
  /** A task that finished with nothing to say. */
  emptyReply: string;
  /** A question nobody answered before the gatekeeper gave up on it. */
  questionExpired: string;
}

/** How a queued job that must land is retried: the callback outbox's policy. */
const DELIVERY_RETRY = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000
};

/** What the delivery outbox carries. Strings and JSON: it crosses a queue. */
interface DeliveryJob {
  taskId: string;
  /** The ledger's `deliveryKey` for the event this callback reports. */
  key: string;
  task: unknown;
}

/**
 * The task host: the owner of a caller's A2A tasks. One per verified
 * `identity.key`, as agents are, behind core's unchanged edge.
 *
 * It holds everything the gatekeeper hears — the ledger, the push channel, the
 * delivery outbox, the cancel ordering, the transcript's settle — and nothing
 * about how a task is done. That is the workflow's, one instance per task, id
 * = task id, and the step agents' it runs.
 *
 * These rules hold it:
 *
 *  - **Cancellation is decided by the guarded write, never by a probe.** The
 *    write comes first, then the run is stopped, so an answer that won stays
 *    won and a task already finished is not stopped.
 *  - **The instance is controlled through the binding**, never through the
 *    SDK's tracking row, which a start cut between `create` and its insert
 *    never wrote.
 *  - **Both workflow callbacks repeat**, because the SDK runs them as steps, so
 *    both are guarded.
 *  - **Every RPC entry point is a native `async` method**, so `onStart` has run
 *    before it does — see {@link file://../agent/agent.ts StepAgent}.
 */
export abstract class TaskHost<
  Env extends Cloudflare.Env & CoreEnv = Cloudflare.Env & CoreEnv
> extends Agent<Env> {
  /**
   * The task ledger. Not `tasks`: every `Agent` already has `this.tasks`, the
   * agents SDK's durable task capability.
   */
  readonly ledger = new A2ATasks((strings, ...values) =>
    this.sql(strings, ...values)
  );
  readonly runs = new TaskRuns((strings, ...values) =>
    this.sql(strings, ...values)
  );

  protected abstract readonly copy: A2ACopy;
  /** The env binding of the workflow that runs this tenant's tasks. */
  protected abstract readonly workflowBinding: string;
  /**
   * This host's own env binding: what a workflow's callbacks, and its steps,
   * reach the host through. Named, not found — left to itself, the SDK looks for
   * a binding matching the class name.
   */
  protected abstract readonly hostBinding: string;

  override async onStart(): Promise<void> {
    // A wiring fault with a name: the host settles every task's transcript.
    assertArtifactsBound(this.env);
    // Every side effect a transition owes is recorded with it, so a host
    // evicted between the two finds the debt here. Queued rather than run: each
    // is retried, and none of them belongs in a start.
    for (const { taskId, key } of this.ledger.pendingDeliveries()) {
      const task = this.ledger.get(taskId);
      if (task) await this.#enqueueDelivery(taskId, key, task);
    }
    for (const taskId of this.ledger.pendingHooks()) {
      await this.queue("runSettleHooks", { taskId }, { id: `hooks:${taskId}` });
    }
    for (const notice of this.runs.owedNotices()) {
      await this.#queueNotice(notice);
    }
    for (const taskId of this.ledger.pendingAnswers()) {
      await this.queue(
        "deliverAnswer",
        { taskId },
        { id: `answer:${taskId}`, retry: DELIVERY_RETRY }
      );
    }
    for (const taskId of this.ledger.unbound()) {
      await this.queue(
        "resumeStart",
        { taskId },
        { id: `start:${taskId}`, retry: DELIVERY_RETRY }
      );
    }
    for (const taskId of this.ledger.pendingStops()) {
      await this.queue(
        "finishStop",
        { taskId },
        { id: `stop:${taskId}`, retry: DELIVERY_RETRY }
      );
    }
    // A cron schedule is idempotent: every start arms the same one.
    await this.schedule("0 1 * * 0", "retainTasks");
  }

  // --- the A2A surface core's edge calls ---------------------------------------

  /**
   * Record the task, then start its workflow, and answer with the task as
   * accepted: the edge publishes it as the `submitted` ack. Idempotent on
   * `messageId`: a redelivery finds the row bound and returns it.
   */
  async acceptTask(turn: AcceptedTurn): Promise<PlainTask> {
    const row = this.ledger.accept({
      messageId: turn.messageId,
      taskId: turn.taskId,
      contextId: turn.contextId,
      push: {
        taskId: turn.taskId,
        contextId: turn.contextId,
        pushUrl: turn.pushUrl,
        pushToken: turn.pushToken,
        jku: turn.jku
      },
      identity: turn.identity
    });
    const task = this.ledger.get(row.taskId)!;
    if (row.state !== "submitted" || row.bound) return task;
    this.runs.record({
      taskId: row.taskId,
      contextId: row.contextId,
      messageId: turn.messageId,
      text: turn.text,
      identity: turn.identity,
      callerKey: this.name,
      caller: this.callerContext(turn.identity),
      jku: turn.jku,
      hostBinding: this.hostBinding
    });
    await this.#start(row.taskId);
    return task;
  }

  async getTask(taskId: string): Promise<PlainTask | null> {
    await this.#reconcile(taskId);
    return this.ledger.get(taskId);
  }

  async listTasks(query: TaskListQuery): Promise<TaskListPage> {
    return this.ledger.list(query);
  }

  /**
   * The a2a-js `TaskStore` write. A `canceled` state takes the same path
   * `cancelTask` does: the SDK's cancel branch writes the canceled task here
   * rather than calling the executor, and a cancel from the wire has to stop
   * the run either way.
   */
  async saveTask(task: Task): Promise<boolean> {
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      return (await this.#cancel(task.id, task)) !== null;
    }
    return this.ledger.save(task);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    return this.#cancel(taskId);
  }

  /**
   * Record a person's reply to the question the task is parked on, and relay
   * it to the workflow waiting for it.
   *
   * A reply naming no question of this task, an option the question never
   * offered, or a typed answer to a question that takes only its options,
   * changes nothing. A timeout is settled from the queue, not here: the request
   * handler loads the task before it takes the message, and a task failed
   * inline would make it refuse the very message reporting the expiry.
   *
   * The resume owes the relay, so a failed send is retried and the start-up
   * sweep finishes one an eviction cut.
   *
   * Returns whether this reply was taken — resumed on, or an expiry queued —
   * decided by the guarded write, so a cancel landing first makes it false.
   */
  async answerTask(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<boolean> {
    const { taskId, messageId, reply } = input;
    const row = this.ledger.row(taskId);
    if (!row) return false;
    // An answer an earlier call resumed on and never relayed goes first.
    if (row.answer) await this.deliverAnswer({ taskId });
    const request = row.request;
    if (!request || request.requestId !== reply.requestId) {
      console.warn("[host] a reply names no question of this task", {
        taskId,
        requestId: reply.requestId
      });
      return false;
    }
    if (reply.kind === "timeout") {
      await this.queue("expireTask", { taskId, requestId: reply.requestId });
      return true;
    }
    const { optionId, text } = reply.answer;
    const offered = offeredOptions(request);
    if (optionId !== undefined && !offered.includes(optionId)) {
      console.warn(
        "[host] a reply picks an option the question never offered",
        { taskId, requestId: reply.requestId, optionId }
      );
      return false;
    }
    if (
      optionId === undefined &&
      offered.length > 0 &&
      !request.allowFreeform
    ) {
      console.warn(
        "[host] a typed reply to a question that takes only its options",
        { taskId, requestId: reply.requestId }
      );
      return false;
    }
    const owed: OwedAnswer = {
      id: `answer:${messageId}`,
      requestId: request.requestId,
      ...(optionId !== undefined ? { optionId } : {}),
      ...(text !== undefined ? { text } : {})
    };
    // The resume and the guard against asking again commit together.
    const resumed = this.ctx.storage.transactionSync(() => {
      if (!this.ledger.resume(taskId, owed)) return false;
      this.runs.answered(taskId, request.requestId);
      return true;
    });
    if (resumed) await this.deliverAnswer({ taskId });
    return resumed;
  }

  // --- what the workflow calls from its steps ----------------------------------

  /**
   * Record a job a step is about to start, answering whether the task is still
   * open. Checked and written with no await between, so a cancel either sees
   * the job or refuses it.
   */
  async noteStepJob(
    taskId: string,
    job: { stepJobId: string; binding: string }
  ): Promise<boolean> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return false;
    this.runs.note(taskId, job);
    return true;
  }

  /**
   * Park the task on a question and owe its callback. A question already
   * answered is not asked again: a replayed park step would otherwise put an
   * answered question back.
   */
  async park(taskId: string, request: HitlRequestData): Promise<ParkOutcome> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return "closed";
    if (this.runs.wasAnswered(request.requestId)) return "parked";
    const parked = buildInputRequiredTask(taskId, row.contextId, request);
    if (this.ledger.park(parked, request)) {
      await this.#enqueueDelivery(
        taskId,
        questionKey(request.requestId),
        parked
      );
    }
    return this.ledger.row(taskId)?.request?.requestId === request.requestId
      ? "parked"
      : "asking";
  }

  /**
   * A progress line, from a step or a step agent. Best-effort, as progress
   * always was: the gatekeeper dedupes on the key, and a line that does not
   * arrive never fails the work that wrote it.
   */
  async progress(taskId: string, text: string, key: string): Promise<void> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;
    await this.#channel(taskId)?.working(text, key);
  }

  // --- the workflow's callbacks ------------------------------------------------

  override async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    await this.#completed(workflowId, result);
  }

  override async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    await this.#errored(workflowId, error);
  }

  async #completed(taskId: string, result: unknown): Promise<void> {
    const reply = (result as TaskResult | undefined)?.reply;
    await this.#finish(
      taskId,
      buildCompletedTask(
        taskId,
        this.#contextOf(taskId),
        reply || this.copy.emptyReply
      )
    );
  }

  async #errored(taskId: string, error: string): Promise<void> {
    console.warn("[host] the task's workflow failed", { taskId, error });
    await this.#finish(
      taskId,
      buildFailedTask(taskId, this.#contextOf(taskId), this.copy.failed)
    );
  }

  // --- queued work -------------------------------------------------------------

  /** A start an eviction cut short, run again from the recorded params. */
  async resumeStart(payload: { taskId: string }): Promise<void> {
    const row = this.ledger.row(payload.taskId);
    if (!row || row.state !== "submitted" || row.bound) return;
    await this.#start(payload.taskId);
  }

  /** Relay the answer a resumed task owes its workflow, then clear it. */
  async deliverAnswer(payload: { taskId: string }): Promise<void> {
    const row = this.ledger.row(payload.taskId);
    if (!row?.answer) return;
    const { id, requestId, ...answer } = row.answer;
    // Idempotent, and what a replayed park step reads: never ask it again.
    this.runs.answered(payload.taskId, requestId);
    if (!isTerminalState(row.state)) {
      const relayed: StepAnswer = answer;
      await this.sendWorkflowEvent(this.workflowBinding, payload.taskId, {
        type: await answerEventType(requestId),
        payload: relayed
      });
    }
    this.ledger.answered(payload.taskId, id);
  }

  /**
   * A question nobody answered: the task fails in this deployment's words,
   * and its run is stopped. The write comes first, so an answer that won stays
   * won.
   */
  async expireTask(payload: {
    taskId: string;
    requestId: string;
  }): Promise<void> {
    const row = this.ledger.row(payload.taskId);
    if (!row || row.request?.requestId !== payload.requestId) return;
    const failed = buildFailedTask(
      payload.taskId,
      row.contextId,
      this.copy.questionExpired
    );
    if (!this.ledger.settle(failed, { stop: true })) return;
    await this.#stopRun(payload.taskId);
    await this.#afterSettle(payload.taskId, failed);
  }

  /**
   * POST one callback, if it is still the one the task owes. Throws on a
   * non-2xx so the queue retries. A question the task has moved past — to an
   * answer, or to another question — is neither sent nor acknowledged.
   */
  async deliverTask(job: DeliveryJob): Promise<void> {
    const row = this.ledger.row(job.taskId);
    if (!row?.push || row.deliveryKey !== job.key) return;
    await createPushChannel(this.env.A2A_SIGNING_KEY, row.push).deliver(
      Task.fromJSON(job.task)
    );
    this.ledger.delivered(job.taskId, job.key);
  }

  /**
   * The stop and the settle hooks a start-up sweep found owed. The stop comes
   * first and both are owed in one write, so this finishes either.
   */
  async runSettleHooks(payload: { taskId: string }): Promise<void> {
    const row = this.ledger.row(payload.taskId);
    if (!row?.hooksPending) return;
    if (row.stopPending) await this.#stopRun(payload.taskId);
    await this.#settled(payload.taskId);
  }

  /** The end-of-task notice, to one agent that ran a job for the task. */
  async notifyStepAgent(job: NoticeJob): Promise<void> {
    await (
      await this.#stepAgent(job.binding)
    ).stepTaskSettled(job.taskId, job.state);
    this.runs.noticed(job.taskId, job.binding);
  }

  async #queueNotice(notice: NoticeJob): Promise<void> {
    await this.queue<NoticeJob>("notifyStepAgent", notice, {
      id: `notice:${notice.taskId}:${notice.binding}`,
      retry: DELIVERY_RETRY
    });
  }

  /**
   * The weekly retention sweep: settle what reconciliation can, then delete
   * what is past the window.
   */
  async retainTasks(): Promise<void> {
    for (const taskId of this.ledger.openBound()) await this.#reconcile(taskId);
    this.ledger.sweep(Date.now() - TASK_RETENTION_MS);
    this.runs.sweep();
  }

  // --- the start protocol ------------------------------------------------------

  /**
   * Start the task's workflow, recovering at every boundary.
   *
   * `runWorkflow` is `create({ id })` then a tracking insert. A start run again
   * after an earlier one got as far as `create` finds the instance there — in
   * production `create` throws on an id in use, and locally it resumes — and a
   * tracking insert that throws on an id already tracked means the same. So a
   * failed start whose instance exists adopts it. The row is bound last.
   */
  async #start(taskId: string): Promise<void> {
    const params = this.runs.params(taskId);
    if (!params) return;
    try {
      await this.runWorkflow(this.workflowBinding, params, {
        id: taskId,
        agentBinding: this.hostBinding
      });
    } catch (err) {
      if (!(await this.#instanceExists(taskId))) throw err;
    }
    this.ledger.bind(taskId);
    if (this.ledger.markWorking(taskId) === "canceled") {
      await this.#stopRun(taskId);
    }
  }

  async #instanceExists(taskId: string): Promise<boolean> {
    try {
      await (await this.#workflow().get(taskId)).status();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A task whose instance ended without its report reaching the host: the
   * backstop for a completion report that ran out of retries. An instance
   * terminated while its task was open was stopped from outside — the host
   * terminates only after its own guarded write — and fails the task.
   */
  async #reconcile(taskId: string): Promise<void> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state) || !row.bound) return;
    try {
      const status = await (await this.#workflow().get(taskId)).status();
      if (status.status === "complete") {
        await this.#completed(taskId, status.output);
      } else if (status.status === "errored") {
        await this.#errored(taskId, status.error?.message ?? "errored");
      } else if (status.status === "terminated") {
        await this.#errored(taskId, "terminated with the task open");
      }
    } catch (err) {
      console.warn("[host] could not read the task's workflow", {
        taskId,
        err: String(err)
      });
    }
  }

  // --- settlement and cancellation -----------------------------------------------

  async #finish(taskId: string, task: Task): Promise<void> {
    if (!this.ledger.settle(task)) return;
    await this.#afterSettle(taskId, task);
  }

  async #afterSettle(taskId: string, task: Task): Promise<void> {
    const state = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    await this.#enqueueDelivery(taskId, state, task);
    await this.#settled(taskId);
  }

  /**
   * The one place a task becomes canceled: the guarded flip first — terminal,
   * so every later non-canceled write is refused — then the run is stopped. The
   * flip's verdict decides whether anything else happens: a cancel replayed on
   * a task already canceled answers with it and stops nothing twice.
   */
  async #cancel(taskId: string, task?: Task): Promise<PlainTask | null> {
    const canceled = this.ledger.cancel(taskId, task);
    if (!canceled) {
      return this.ledger.row(taskId)?.state === "canceled"
        ? this.ledger.get(taskId)
        : null;
    }
    await this.#stopRun(taskId);
    await this.#settled(taskId);
    return canceled;
  }

  /**
   * Stop the task's instance, then every job its steps started. A stopped job
   * keeps its work: the agent that picks the task up again decides what
   * becomes of it. The stop the ledger owes is cleared only once every part
   * of it held; one that failed is retried from the queue. Safe to repeat.
   */
  async #stopRun(taskId: string): Promise<void> {
    if (await this.#tryStopRun(taskId)) return;
    await this.queue(
      "finishStop",
      { taskId },
      { id: `stop:${taskId}`, retry: DELIVERY_RETRY }
    );
  }

  /** A stop that failed, tried again. Throws, so the queue retries it. */
  async finishStop(payload: { taskId: string }): Promise<void> {
    if (!this.ledger.row(payload.taskId)?.stopPending) return;
    if (!(await this.#tryStopRun(payload.taskId))) {
      throw new Error(`the run of task ${payload.taskId} is not stopped yet`);
    }
  }

  async #tryStopRun(taskId: string): Promise<boolean> {
    let stopped = true;
    try {
      await (await this.#workflow().get(taskId)).terminate();
    } catch (err) {
      if (!(await this.#instanceStopped(taskId))) {
        stopped = false;
        console.warn("[host] instance not terminated", {
          taskId,
          err: String(err)
        });
      }
    }
    for (const job of this.runs.jobs(taskId)) {
      try {
        await (await this.#stepAgent(job.binding)).cancelStepJob(job.stepJobId);
      } catch (err) {
        stopped = false;
        console.warn("[host] step job not stopped", {
          taskId,
          stepJobId: job.stepJobId,
          err: String(err)
        });
      }
    }
    if (stopped) this.ledger.stopped(taskId);
    return stopped;
  }

  /**
   * Whether a terminate that threw found nothing left to stop: an instance
   * already ended, or one never created. The binding does not say why a read
   * failed, so the row does: a bound task's instance exists, and its stop
   * stays owed. An unbound one's may not — a start that creates it later stops
   * it itself, finding the task canceled (see `#start`), and one an eviction
   * cut short runs no job, because `noteStepJob` refuses a closed task.
   */
  async #instanceStopped(taskId: string): Promise<boolean> {
    try {
      const { status } = await (await this.#workflow().get(taskId)).status();
      return ["complete", "errored", "terminated"].includes(status);
    } catch {
      return !this.ledger.row(taskId)?.bound;
    }
  }

  /**
   * End the transcript, then tell each agent that ran a job, then the host's
   * own hook, then record that all of them ran. The transcript first, because
   * somebody may be watching for the line that says it finished. At least
   * once: an eviction before the record reruns them. Each notice stays owed
   * past that record, until its agent took it: it is what stops the task's
   * jobs and releases what they held.
   */
  async #settled(taskId: string): Promise<void> {
    const state =
      this.ledger.get(taskId)?.status?.state ??
      TaskState.TASK_STATE_UNSPECIFIED;
    await settleTranscript(this.env, taskId, state);
    for (const notice of this.runs.oweNotices(taskId, state)) {
      await this.#queueNotice(notice);
    }
    try {
      await this.onTaskSettled(taskId, state);
    } catch (err) {
      console.warn("[host] task settle hook failed", {
        taskId,
        state,
        err: String(err)
      });
    }
    this.ledger.hooksRan(taskId);
  }

  /**
   * A task reached a state it never leaves. Fires for every terminal state,
   * `canceled` included, at least once. A throw is logged and swallowed: the
   * row is already durable. What a step agent held for the task is released in
   * its own `onTaskSettled`, which the end-of-task notice runs.
   */
  protected async onTaskSettled(
    _taskId: string,
    _state: TaskState
  ): Promise<void> {}

  /**
   * Hand one callback to the durable queue, keyed on the event it reports.
   * The stable id makes a repeat replace the pending item rather than queue a
   * second.
   */
  async #enqueueDelivery(
    taskId: string,
    key: string,
    task: Task
  ): Promise<void> {
    await this.queue<DeliveryJob>(
      "deliverTask",
      { taskId, key, task: Task.toJSON(task) },
      { id: `deliver:${taskId}:${key}`, retry: DELIVERY_RETRY }
    );
  }

  // --- helpers ---------------------------------------------------------------------

  /**
   * The caller block's text, which each step agent's turns carry. A rendering
   * of a protocol fact, so core supplies it; override to name what a workspace
   * id means in a deployment.
   */
  protected callerContext(identity: GatekeeperIdentity): string {
    return callerContext(identity).trim();
  }

  #workflow(): Workflow {
    const binding = (this.env as Record<string, unknown>)[this.workflowBinding];
    if (!binding) {
      throw new Error(`no workflow binding ${this.workflowBinding}`);
    }
    return binding as Workflow;
  }

  async #stepAgent(binding: string): Promise<StepAgentStub> {
    const ns = (this.env as Record<string, unknown>)[binding];
    if (!ns) throw new Error(`no binding ${binding}`);
    return (await getAgentByName(
      ns as DurableObjectNamespace<Agent>,
      this.name
    )) as unknown as StepAgentStub;
  }

  #channel(taskId: string): PushChannel | null {
    const push = this.ledger.row(taskId)?.push;
    return push ? createPushChannel(this.env.A2A_SIGNING_KEY, push) : null;
  }

  #contextOf(taskId: string): string {
    return this.ledger.row(taskId)?.contextId ?? "";
  }
}

/**
 * The option ids a question takes. An `approval` that names none takes the
 * protocol's fixed pair.
 */
function offeredOptions(request: HitlRequestData): string[] {
  if (request.options) return request.options.map((o) => o.id);
  return request.requestKind === "approval"
    ? [HITL_APPROVE_OPTION_ID, HITL_REJECT_OPTION_ID]
    : [];
}
