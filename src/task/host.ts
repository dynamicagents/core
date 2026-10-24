import { Agent, getAgentByName } from "agents";
import { Task, TaskState } from "@a2a-js/sdk";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REJECT_OPTION_ID,
  type HitlAnswer,
  type HitlQuestion,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import type { AcceptedTurn } from "../a2a/executor.js";
import type { TaskListPage, TaskListQuery } from "../a2a/agent-stub.js";
import { callerContext } from "../a2a/caller.js";
import {
  buildAskingTask,
  buildWaitingTask,
  type HumanReply
} from "../a2a/hitl.js";
import {
  buildCompletedTask,
  buildFailedTask,
  buildWorkingTask
} from "../a2a/notify.js";
import { createPushChannel, type PushChannel } from "../a2a/push.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import type { CoreEnv } from "../env.js";
import { isTerminalState, TASK_RETENTION_MS } from "../ledger.js";
import { jobEventType } from "../workflow/keys.js";
import type {
  JobEvent,
  NotedStepJob,
  ParkOutcome,
  StepInput,
  TaskResult
} from "../workflow/types.js";
import type { StepAgentStub } from "../workflow/workflow.js";
import { TaskRuns, type NoticeJob } from "./runs.js";
import { A2ATasks, questionKey, STATE_KEY } from "./tasks.js";

/** The user-facing strings core needs and never writes. */
export interface A2ACopy {
  /** A task whose workflow failed. */
  failed: string;
  /** A task that finished with nothing to say. */
  emptyReply: string;
}

/** How a queued job that must land is retried: the callback outbox's policy. */
const DELIVERY_RETRY = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000
};

/**
 * What the delivery outbox carries: which callback, by the key the ledger owes
 * it under. What it posts is read from the ledger when it goes, so a state
 * owed again in the meantime posts the latest.
 */
interface DeliveryJob {
  taskId: string;
  key: string;
}

/** One input the relay owes a job's workflow. */
interface InputJob {
  taskId: string;
  stepJobId: string;
  seq: number;
}

/**
 * The task host: the owner of a caller's A2A tasks. One per verified
 * `identity.key`, as agents are, behind core's unchanged edge.
 *
 * It holds everything the gatekeeper hears — the ledger, the push channel, the
 * delivery outbox, the cancel ordering — and nothing about how a task is done.
 * That is the workflow's, one instance per task, id = task id, and the step
 * agents' it runs.
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
  readonly ledger = new A2ATasks(
    (strings, ...values) => this.sql(strings, ...values),
    (fn) => this.ctx.storage.transactionSync(fn)
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
    // Every side effect a transition owes is recorded with it, so a host
    // evicted between the two finds the debt here. Queued rather than run: each
    // is retried, and none of them belongs in a start.
    for (const { taskId, key } of this.ledger.pendingDeliveries()) {
      await this.#enqueueDelivery(taskId, key);
    }
    for (const input of this.runs.unsentInputs()) {
      await this.#queueInput(input);
    }
    for (const taskId of this.ledger.pendingHooks()) {
      await this.queue("runSettleHooks", { taskId }, { id: `hooks:${taskId}` });
    }
    for (const notice of this.runs.owedNotices()) {
      await this.#queueNotice(notice);
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
   * Record a person's reply to one of the requests the task has open, and
   * relay it to the workflow, which hands it to the job that asked.
   *
   * A reply naming no open request of this task changes nothing: it is late,
   * for a request already answered or expired. One whose answers do not fit the
   * questions asked (one missing, an option never offered, two picked of a
   * question that takes one) is refused with the reason, so the gatekeeper can
   * say so instead of showing the question answered while the task waits on. A
   * timeout closes the request as expired, and the job is told so: it decides
   * whether to go on without the answer, and the task does not fail for it.
   *
   * Closing the request and owing its input are one write, so a relay that
   * fails is retried and the start-up sweep finishes one an eviction cut.
   *
   * Returns whether this reply was taken, decided by the guarded write, so a
   * cancel landing first makes it false.
   */
  async answerTask(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<boolean | { refused: string }> {
    const { taskId, messageId, reply } = input;
    const row = this.ledger.row(taskId);
    const asked = this.ledger.request(taskId, reply.requestId);
    if (!row || isTerminalState(row.state) || asked?.state !== "pending") {
      console.warn("[host] a reply names no open request of this task", {
        taskId,
        requestId: reply.requestId
      });
      // An answer to a question that has closed, sent for the first time: a
      // failed step's, expired with it. Taken, it would be dropped unread; the
      // gatekeeper tells the person instead. A replay, or a timeout, is not.
      if (
        row &&
        !isTerminalState(row.state) &&
        asked &&
        reply.kind !== "timeout" &&
        !this.runs.hasInput(taskId, messageId)
      ) {
        return { refused: `question ${reply.requestId} is no longer open` };
      }
      return false;
    }
    let relayed: StepInput;
    if (reply.kind === "timeout") {
      relayed = { kind: "expiry", requestId: reply.requestId };
    } else {
      const { answers } = reply.answer;
      const refused = answersMismatch(asked.request, answers);
      if (refused) {
        console.warn("[host] a reply does not answer the questions asked", {
          taskId,
          requestId: reply.requestId,
          refused
        });
        return { refused: `the answer does not fit the question: ${refused}` };
      }
      relayed = { kind: "answer", requestId: reply.requestId, answers };
    }
    const owed = this.ctx.storage.transactionSync(() => {
      const closed = this.ledger.closeRequest(
        taskId,
        reply.requestId,
        relayed.kind === "expiry" ? "expired" : "answered"
      );
      if (!closed) return null;
      return this.runs.addInput(taskId, asked.stepJobId, messageId, relayed);
    });
    if (owed === null) return false;
    await this.#queueInput({ taskId, stepJobId: asked.stepJobId, seq: owed });
    // The last open request answered: working again now, not once the agent
    // reports it, which a lost event could put off by a whole wait.
    await this.#settleState(taskId);
    return true;
  }

  /**
   * A message that joins the task: more input to the work already running, in
   * the conversation it belongs to. Relayed to the job its pipeline named to
   * take joined messages. `closed` when the task has ended, or takes none right
   * now: the gatekeeper starts a new task with the message instead. Idempotent
   * on `messageId`, and checked before either: a message already taken, sent
   * again because its accept was lost, is taken again rather than refused, or
   * the gatekeeper would start a second task with it.
   */
  async joinTask(input: {
    taskId: string;
    messageId: string;
    text: string;
  }): Promise<"joined" | "closed"> {
    const { taskId, messageId, text } = input;
    const owed = this.ctx.storage.transactionSync(() => {
      const row = this.ledger.row(taskId);
      if (!row) return "closed" as const;
      if (this.runs.hasInput(taskId, messageId)) return "taken" as const;
      if (isTerminalState(row.state)) return "closed" as const;
      const stepJobId = this.runs.joinTarget(taskId);
      if (!stepJobId) return "closed" as const;
      const seq = this.runs.addInput(taskId, stepJobId, messageId, {
        kind: "join",
        messageId,
        text
      });
      return { stepJobId, seq };
    });
    if (owed === "closed") return "closed";
    if (owed === "taken") return "joined";
    if (owed.seq !== null) {
      await this.#queueInput({
        taskId,
        stepJobId: owed.stepJobId,
        seq: owed.seq
      });
    }
    return "joined";
  }

  // --- what the workflow calls from its steps ----------------------------------

  /**
   * Record a job a step is about to start, answering whether the task is still
   * open. Checked and written with no await between, so a cancel either sees
   * the job or refuses it.
   */
  async noteStepJob(taskId: string, job: NotedStepJob): Promise<boolean> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return false;
    this.runs.note(taskId, job);
    await this.#settleState(taskId);
    return true;
  }

  /**
   * A request a job asked: recorded, and its callback owed in the same write.
   * Any number may be open, and asking stops nothing else, so it goes out on a
   * `working` update. A request already recorded is not asked again: a
   * replayed park step would otherwise post it twice.
   */
  async park(
    taskId: string,
    stepJobId: string,
    request: HitlRequestData
  ): Promise<ParkOutcome> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return "closed";
    const asking = buildAskingTask(taskId, row.contextId, request);
    const parked = this.ledger.ask(taskId, stepJobId, request, asking);
    if (parked === "parked") {
      await this.#enqueueDelivery(taskId, questionKey(request.requestId));
    }
    return parked;
  }

  /**
   * A branch of the task (a job, or a pipeline's own question) waits on the
   * person: idle, with nothing open but its requests.
   */
  async idle(taskId: string, branchId: string): Promise<void> {
    this.runs.setWaiting(taskId, branchId, true);
    await this.#settleState(taskId);
  }

  /** A branch went back to work: an answer, a message or a result woke it. */
  async working(taskId: string, branchId: string): Promise<void> {
    this.runs.setWaiting(taskId, branchId, false);
    await this.#settleState(taskId);
  }

  /** A branch finished: its job completed, or its question was answered. */
  async endBranch(taskId: string, branchId: string): Promise<void> {
    this.runs.endBranch(taskId, branchId);
    await this.#settleState(taskId);
  }

  /**
   * A job failed. Its branch ends, and the retry's opens in the same write,
   * so a sibling waiting on the person does not read as the whole task
   * waiting in between. Its questions close as expired: nobody would read
   * their answers, and the retry asks again if it needs to. A job that took
   * joined messages hands the retry those it never ran (see
   * `TaskRuns.handOverJoins`), and every one that joins after; with no retry
   * (`to` null) it takes none.
   */
  async handOver(
    taskId: string,
    stepJobId: string,
    to: string | null,
    unread: { from: number; unrun: string[] }
  ): Promise<void> {
    const moved = this.ctx.storage.transactionSync(() => {
      for (const asked of this.ledger.openRequests(taskId)) {
        if (asked.stepJobId === stepJobId) {
          this.ledger.closeRequest(taskId, asked.requestId, "expired");
        }
      }
      this.runs.endBranch(taskId, stepJobId);
      if (!to) {
        this.runs.setJoins(taskId, stepJobId, false);
        return [];
      }
      this.runs.openBranch(taskId, to);
      return this.runs.handOverJoins(taskId, stepJobId, to, unread);
    });
    for (const seq of moved) {
      await this.#queueInput({ taskId, stepJobId: to as string, seq });
    }
    await this.#settleState(taskId);
  }

  /**
   * The task's A2A state, read from its branches: `input-required` once every
   * branch open waits on the person, which is what stops the gatekeeper's
   * clock; `working` otherwise, posted with nothing to say. A step a pipeline
   * runs itself is no branch, so a task waiting on one alone reads working.
   */
  async #settleState(taskId: string): Promise<void> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;
    const waiting =
      this.runs.waiting(taskId) && this.ledger.openRequests(taskId).length > 0;
    const id = crypto.randomUUID();
    const task = waiting
      ? buildWaitingTask(taskId, row.contextId, `${taskId}:${id}`)
      : buildWorkingTask(taskId, row.contextId, "", id);
    if (
      this.ledger.setState(taskId, waiting ? "input-required" : "working", task)
    ) {
      await this.#enqueueDelivery(taskId, STATE_KEY);
    }
  }

  /**
   * Stop taking joined messages for a job its workflow is about to finish, and
   * return any input it has not read yet, from number `from` on. With one
   * owed, nothing is closed: the workflow hands it to the job, which carries
   * on. Checked and written with no await between, so a message joining now
   * either is returned here or finds the task closed.
   */
  async closeJoins(
    taskId: string,
    stepJobId: string,
    from: number
  ): Promise<Extract<JobEvent, { from: "host" }>[]> {
    return this.ctx.storage.transactionSync(() => {
      const unread = this.runs.inputs(taskId, stepJobId, from);
      if (unread.length === 0) this.runs.setJoins(taskId, stepJobId, false);
      return unread;
    });
  }

  /** Take joined messages for a job again: finishing it was refused. */
  async openJoins(taskId: string, stepJobId: string): Promise<void> {
    this.runs.setJoins(taskId, stepJobId, true);
  }

  /** A job's inputs from number `from` on: what its workflow pulls when one is late. */
  async stepJobInputs(
    taskId: string,
    stepJobId: string,
    from: number
  ): Promise<Extract<JobEvent, { from: "host" }>[]> {
    return this.runs.inputs(taskId, stepJobId, from);
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

  /**
   * Send one input to its job's workflow, under the job's one event type and
   * its own number. An input for a task that has ended goes nowhere: its
   * workflow is stopped. Throws on a failed send, so the queue retries.
   */
  async relayInput(job: InputJob): Promise<void> {
    const row = this.ledger.row(job.taskId);
    const event = this.runs.input(job.stepJobId, job.seq);
    if (!event) return;
    if (row && !isTerminalState(row.state)) {
      await this.sendWorkflowEvent(this.workflowBinding, job.taskId, {
        type: await jobEventType(job.stepJobId),
        payload: event
      });
    }
    this.runs.inputSent(job.stepJobId, job.seq);
  }

  /**
   * POST one callback, if it is still owed, with what the ledger owes now.
   * Throws on a non-2xx so the queue retries. A question since answered, a
   * state since replaced, or anything an open task owed before it settled, is
   * neither sent nor acknowledged.
   */
  async deliverTask(job: DeliveryJob): Promise<void> {
    // A state that replaced this one while it posted is owed too, and this is
    // the queue item that would post it: a repeat under the same id replaced
    // the item running, which its finishing then removes.
    for (;;) {
      const row = this.ledger.row(job.taskId);
      const task = this.ledger.owed(job.taskId, job.key);
      if (!row?.push || !task) return;
      // A question rides the state the task is in when it goes, not the one it
      // was asked in: posted behind an `input-required` the queue sent first,
      // a `working` would be the last state the caller saw.
      const waiting =
        job.key !== STATE_KEY && row.state === "input-required" && task.status;
      const sent = waiting
        ? {
            ...task,
            status: {
              ...task.status,
              state: TaskState.TASK_STATE_INPUT_REQUIRED
            }
          }
        : task;
      await createPushChannel(this.env.A2A_SIGNING_KEY, row.push).deliver(
        Task.fromJSON(Task.toJSON(sent as Task))
      );
      if (this.ledger.delivered(job.taskId, job.key, task)) return;
    }
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
   * after an earlier one got as far as `create` finds the instance there —
   * `create` rejects an id in use with `instance.already_exists` — and a
   * tracking insert that throws on an id already tracked means the same. So a
   * failed start whose instance exists adopts it. The row is bound last.
   *
   * Whether the adopted instance carries a tracking row depends on where the
   * earlier attempt was cut: none when it was cut between `create` and the
   * insert, and the row that attempt wrote when it got past it. Neither state
   * is worth reconciling — the table is the SDK's own bookkeeping, nothing
   * here reads it, and a workflow's callbacks reach the host whether or not
   * its row exists.
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
      return;
    }
    // A job that went idle on a question while the task was still `submitted`
    // could not move it; it is `working` now, and may be waiting already.
    await this.#settleState(taskId);
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
    await this.#enqueueDelivery(taskId, state);
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
   * Tell each agent that ran a job, then run the host's own hook, then record
   * that all of them ran. At least once: an eviction before the record reruns
   * them. Each notice stays owed past that record, until its agent took it: it
   * is what stops the task's jobs and releases what they held — their runs'
   * transcripts end with the runs, on the agent.
   */
  async #settled(taskId: string): Promise<void> {
    const state =
      this.ledger.get(taskId)?.status?.state ??
      TaskState.TASK_STATE_UNSPECIFIED;
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
  async #enqueueDelivery(taskId: string, key: string): Promise<void> {
    await this.queue<DeliveryJob>(
      "deliverTask",
      { taskId, key },
      { id: `deliver:${taskId}:${key}`, retry: DELIVERY_RETRY }
    );
  }

  /** Hand one input to the durable queue, which relays it once. */
  async #queueInput(job: InputJob): Promise<void> {
    await this.queue<InputJob>("relayInput", job, {
      id: `input:${job.stepJobId}:${job.seq}`,
      retry: DELIVERY_RETRY
    });
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

/** The option ids a question takes: an `approval`'s are the protocol's pair. */
function offeredOptions(question: HitlQuestion): string[] {
  switch (question.kind) {
    case "choice":
      return question.options.map((o) => o.id);
    case "approval":
      return [HITL_APPROVE_OPTION_ID, HITL_REJECT_OPTION_ID];
    case "text":
      return [];
  }
}

/**
 * Why `answers` does not answer `request`, or `undefined` when it does: every
 * question answered, nothing answered that was not asked, every option picked
 * one the question offered, and more than one only where it allows that.
 */
function answersMismatch(
  request: HitlRequestData,
  answers: Record<string, HitlAnswer>
): string | undefined {
  for (const question of request.questions) {
    // Own keys only: `step.ask` takes a caller's ids, and `constructor` would
    // otherwise find `Object.prototype`'s and read as answered.
    const answer = Object.hasOwn(answers, question.id)
      ? answers[question.id]
      : undefined;
    if (!answer) return `question "${question.id}" has no answer`;
    const picked = answer.optionIds ?? [];
    const offered = offeredOptions(question);
    const stray = picked.find((id) => !offered.includes(id));
    if (stray !== undefined) {
      return `question "${question.id}" offers no option "${stray}"`;
    }
    const many = question.kind === "choice" && question.multiple === true;
    if (picked.length > 1 && !many) {
      return `question "${question.id}" takes one option`;
    }
  }
  const asked = new Set(request.questions.map((q) => q.id));
  const extra = Object.keys(answers).find((id) => !asked.has(id));
  return extra === undefined ? undefined : `no question "${extra}" was asked`;
}
