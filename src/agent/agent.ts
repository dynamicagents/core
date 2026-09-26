import {
  Think,
  defaultContextOverflowClassifier,
  type ThinkModel,
  type ThinkScheduledTasks,
  type ThinkSession,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
  type Action
} from "@cloudflare/think";
import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInfo
} from "agents";
import type { ContextConfig } from "agents/context";
import { createCompactFunction } from "agents/sessions";
import {
  generateText,
  hasToolCall,
  tool,
  type LanguageModel,
  type Tool,
  type ToolSet,
  type UIMessage
} from "ai";
import { Task, TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import type { AcceptedTurn } from "../a2a/executor.js";
import type { TaskListPage, TaskListQuery } from "../a2a/agent-stub.js";
import { callerContext } from "../a2a/caller.js";
import type { HumanReply } from "../a2a/hitl.js";
import { buildInputRequiredTask } from "../a2a/hitl.js";
import { buildCompletedTask, buildFailedTask } from "../a2a/notify.js";
import { createPushChannel, type PushChannel } from "../a2a/push.js";
import { SelfOrigin } from "../a2a/self-origin.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";
import type { GatekeeperIdentity } from "../a2a/verify.js";
import { assertArtifactsBound } from "../artifacts/binding.js";
import { settleTranscript, transcribeNote } from "../artifacts/transcript.js";
import {
  assemblePlugins,
  type AssembledPlugins
} from "../contract/assemble.js";
import type { AgentPlugin, PluginContext } from "../contract/plugin.js";
import type { CoreEnv } from "../env.js";
import { ensureStarted } from "./lifecycle.js";
import { latestTaskId, readTurn } from "./outcome.js";
import type { SubAgentSpec } from "../contract/subagent.js";
import {
  NOTE_MILESTONE,
  type NoteData,
  type SubAgentClass,
  type SubAgentEnvelope
} from "../subagent/subagent.js";
import {
  A2ATasks,
  TASK_RETENTION_MS,
  isTerminalState,
  questionKey,
  type WorkRow
} from "./tasks.js";
import {
  ASK_USER_TOOL_NAME,
  CHECK_BACK_DESCRIPTION,
  CHECK_BACK_TOOL_NAME,
  askUserTool,
  checkBackInputSchema,
  searchHistoryTool,
  SEARCH_HISTORY_TOOL_NAME
} from "./tools.js";

/** The user-facing strings core needs and never writes. */
export interface A2ACopy {
  /** A turn that errored. */
  failed: string;
  /** A turn that ended with nothing to say. */
  emptyReply: string;
  /** A question nobody answered before the gatekeeper gave up on it. */
  questionExpired: string;
}

/** What `onCheckBack` is handed by the schedule `check_back` created. */
export interface CheckBackWake {
  taskId: string;
  workId: string;
  seconds: number;
  why: string;
}

/** What the delivery outbox carries. Strings and JSON: it crosses a queue. */
interface DeliveryJob {
  taskId: string;
  /** The ledger's `deliveryKey` for the event this callback reports. */
  key: string;
  task: unknown;
}

/** Per-agent `getConfig()` shape. */
interface A2AConfig {
  caller?: string;
}

/**
 * The per-caller agent: a Think agent behind core's zero-trust A2A edge, one
 * Durable Object per verified `identity.key`.
 *
 * What it adds to Think is the A2A task lifecycle, and three rules hold it:
 *
 *  - **A task can outlive the turn that started it.** Work that may run past
 *    Think's fifteen-minute turn is dispatched detached or scheduled; the task
 *    stays `working` while the ledger holds open work for it, and the turn that
 *    ends with none is the one that answers.
 *  - **`onSubmissionStatus` is not a delivery channel.** It fires inside the
 *    turn slot and its errors are only logged, so it does the guarded write and
 *    hands the callback to a durable queue.
 *  - **Cancellation is decided by the guarded write, never by a probe.** A read
 *    then an act reopens the window where a cancel lands and the gatekeeper
 *    still gets a `completed`.
 *
 * A subclass supplies the model, the copy and the compaction values; core ships
 * no numbers and no prompt copy. A subclass that overrides a Think hook this
 * class implements calls `super`.
 */
export abstract class A2AAgent<
  Env extends Cloudflare.Env & CoreEnv = Cloudflare.Env & CoreEnv
> extends Think<Env> {
  /**
   * A re-attaching parent gives up on a silent awaited child after this. The
   * gatekeeper's hour is the only bound wanted: a child quiet for minutes while
   * a tool runs is normal.
   */
  static override options = { agentToolReattachNoProgressTimeoutMs: Infinity };

  override maxSteps = Infinity;
  override chatRecovery = { maxRecoveryWork: Infinity };
  override contextOverflow = { reactive: true };

  /**
   * The task ledger. Not `tasks`: every `Agent` already has `this.tasks`, the
   * agents SDK's durable task capability.
   */
  readonly ledger = new A2ATasks((strings, ...values) =>
    this.sql(strings, ...values)
  );

  abstract override getModel(): ThinkModel;
  protected abstract readonly copy: A2ACopy;
  /** Compact once the stamped history estimate crosses this. */
  protected abstract readonly compactAfterTokens: number;
  /** The recent tail compaction keeps verbatim. */
  protected abstract readonly keepRecentTokens: number;
  /** Output ceiling per step. Unset, the provider's default applies. */
  protected readonly maxOutputTokens?: number;

  /** This agent's plugins. Default: none. */
  getPlugins(): AgentPlugin<Env>[] {
    return [];
  }

  /** The sub-agents this agent may dispatch, one tool each. Default: none. */
  getSubAgents(): SubAgentClass[] {
    return [];
  }

  /** Learned from the `jku` each accepted turn carries; never configured. */
  readonly #origin = new SelfOrigin();
  #plugins?: AssembledPlugins<Env>;
  #buffered = "";
  #flushed = false;

  protected get plugins(): AssembledPlugins<Env> {
    return (this.#plugins ??= assemblePlugins(this.getPlugins(), this.env));
  }

  // --- Think -----------------------------------------------------------------

  override async onStart(): Promise<void> {
    // A wiring fault with a name: every sub-agent note is filed on the task's
    // transcript, so the binding is required, and this is the cheap place to
    // say so. The plugins are checked here for the same reason.
    assertArtifactsBound(this.env);
    this.plugins.check(this.pluginContext());
    await super.onStart();
    // Every side effect a transition owes is recorded with it, so an object
    // evicted between the two finds the debt here. Queued rather than run:
    // each is retried, and none of them belongs in a start.
    for (const { taskId, key } of this.ledger.pendingDeliveries()) {
      const task = this.ledger.get(taskId);
      if (task) await this.#enqueueDelivery(taskId, key, task);
    }
    for (const taskId of this.ledger.pendingHooks()) {
      await this.queue("runSettleHooks", { taskId }, { id: `hooks:${taskId}` });
    }
    for (const workId of this.ledger.pendingFollowUps()) {
      await this.queue(
        "submitFollowUp",
        { workId },
        { id: `follow-up:${workId}` }
      );
    }
    for (const taskId of this.ledger.pendingAnswers()) {
      await this.queue("submitAnswer", { taskId }, { id: `answer:${taskId}` });
    }
  }

  override classifyChatError(error: unknown) {
    return defaultContextOverflowClassifier(error);
  }

  override configureSession(session: ThinkSession): ThinkSession {
    return session
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.compactionModel(), prompt }).then(
              (r) => r.text
            ),
          keepRecentTokens: this.keepRecentTokens
        })
      )
      .compactAfter(this.compactAfterTokens);
  }

  /** The model compaction summarizes with. Defaults to the turn's model. */
  protected compactionModel(): LanguageModel {
    return this.resolveModel(this.getModel());
  }

  /**
   * The plugins' blocks, and the verified caller. A subclass puts its own
   * blocks first: `[soul, memory, ...super.configureContext()]`.
   */
  override configureContext(): ContextConfig[] {
    return [
      ...this.plugins.context(),
      {
        label: "caller",
        description: "the verified agent instance calling you — not the person",
        provider: {
          get: async () => this.getConfig<A2AConfig>()?.caller ?? null
        }
      }
    ];
  }

  override getTools(): ToolSet {
    const tools: ToolSet = { ...this.plugins.tools(this.pluginContext()) };
    for (const Cls of this.getSubAgents()) {
      tools[Cls.spec.name] = this.subAgentTool(Cls);
    }
    // Last, so a plugin cannot shadow the tools the lifecycle reads.
    tools[ASK_USER_TOOL_NAME] = askUserTool;
    tools[SEARCH_HISTORY_TOOL_NAME] = searchHistoryTool(async (query, limit) =>
      (await this.session.search(query, { limit })).map((hit) => ({
        role: hit.role,
        content: hit.content,
        ...(hit.createdAt ? { createdAt: hit.createdAt } : {})
      }))
    );
    return tools;
  }

  override getActions(): Record<string, Action> {
    return this.plugins.actions(this.pluginContext());
  }

  /**
   * Both of these end the turn on the call: `ask_user` waits for a person and
   * `check_back` has scheduled its own wake. Without them the loop would run
   * another step on a turn that is finished.
   */
  override beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {
    return {
      stopWhen: [
        hasToolCall(ASK_USER_TOOL_NAME),
        hasToolCall(CHECK_BACK_TOOL_NAME)
      ],
      ...(this.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.maxOutputTokens }
        : {})
    };
  }

  /**
   * Push what the model wrote before a tool call, the moment the call starts.
   * `onStepEnd` fires after the step's tools finish, which for a tool that
   * takes minutes leaves the caller watching an agent say nothing.
   */
  override async onChunk(ctx: {
    chunk: { type: string; text?: string };
  }): Promise<void> {
    const { chunk } = ctx;
    if (chunk.type === "text-delta") {
      this.#buffered += chunk.text ?? "";
      return;
    }
    if (chunk.type !== "tool-call" || this.#flushed) return;
    this.#flushed = true;
    const text = this.#buffered.trim();
    this.#buffered = "";
    const taskId = this.turnTaskId();
    if (text && taskId) await this.#push(taskId, text, "step");
  }

  override onStepEnd(): void {
    this.#buffered = "";
    this.#flushed = false;
  }

  /**
   * An interrupted `ask_user` becomes its question as text. The default repair
   * reads as a tool that broke; this was a question, and the next user message
   * answers it.
   */
  protected override repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    if (part.type === `tool-${ASK_USER_TOOL_NAME}`) {
      const input = (
        part as { input?: { question?: unknown; options?: unknown } }
      ).input;
      if (typeof input?.question === "string") {
        const options = Array.isArray(input.options)
          ? `\n\n${input.options.map((o) => `- ${String(o)}`).join("\n")}`
          : "";
        return { type: "text", text: `${input.question}${options}` };
      }
    }
    return super.repairInterruptedToolPart(part);
  }

  /** A canceled task's interrupted turn is not continued. */
  protected override async onChatRecovery(ctx: {
    messages: UIMessage[];
  }): Promise<{ continue: boolean } | void> {
    const taskId = latestTaskId(ctx.messages);
    if (taskId && this.ledger.row(taskId)?.state === "canceled") {
      return { continue: false };
    }
  }

  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      a2aRetention: {
        schedule: "every week on sunday at 01:00 in UTC",
        handler: () => this.#retain()
      }
    };
  }

  async #retain(): Promise<void> {
    const before = Date.now() - TASK_RETENTION_MS;
    this.ledger.sweep(before);
    // `deleteSubmissions` caps how many it removes per call.
    while (
      (await this.deleteSubmissions({
        status: ["completed", "aborted", "skipped", "error"],
        completedBefore: new Date(before)
      })) > 0
    );
    await this.clearAgentToolRuns({
      olderThan: before,
      status: ["completed", "error", "aborted", "interrupted"]
    });
  }

  // --- the A2A surface core's executor and task store call -------------------

  /**
   * Record the task and submit its turn. Idempotent on `messageId`: a dispatch
   * retry finds the submission bound and does nothing, and Think's own
   * `idempotencyKey` closes the narrower race underneath.
   */
  async acceptTask(turn: AcceptedTurn): Promise<PlainTask> {
    await ensureStarted(this);
    this.#origin.note(turn.jku);
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
    if (row.state !== "submitted" || row.submissionId) return task;

    const caller = this.callerContext(turn.identity);
    if (this.getConfig<A2AConfig>()?.caller !== caller) {
      this.configure<A2AConfig>({ ...this.getConfig<A2AConfig>(), caller });
    }
    const submission = await this.runTurn({
      mode: "submit",
      input: userMessage(turn.messageId, turn.text, row.taskId, row.contextId),
      idempotencyKey: turn.messageId,
      metadata: { taskId: row.taskId }
    });
    this.ledger.bindSubmission(row.taskId, submission.submissionId);
    return task;
  }

  async getTask(taskId: string): Promise<PlainTask | null> {
    await ensureStarted(this);
    return this.ledger.get(taskId);
  }

  async listTasks(query: TaskListQuery): Promise<TaskListPage> {
    await ensureStarted(this);
    return this.ledger.list(query);
  }

  /**
   * The a2a-js `TaskStore` write. A `canceled` state takes the same path
   * `cancelTask` does: the SDK's cancel branch writes the canceled task here
   * rather than calling the executor, and a cancel from the wire has to stop
   * the work either way.
   */
  async saveTask(task: Task): Promise<boolean> {
    await ensureStarted(this);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      return (await this.#cancel(task.id, task)) !== null;
    }
    return this.ledger.save(task);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    await ensureStarted(this);
    return this.#cancel(taskId);
  }

  /**
   * Record a person's reply to the question a task asked, and submit it as the
   * task's next turn. Nothing is woken: Think's first-in-first-out turn queue
   * orders the answer behind anything still running.
   *
   * A reply naming no question of this task, an option the question never
   * offered, or a typed answer to a question that takes only its options,
   * changes nothing. A timeout is settled from the queue, not here: the request
   * handler loads the task before it takes the message, and a task failed
   * inline would make it refuse the very message reporting the expiry.
   *
   * The resume owes the answer's turn, so a retry — or the start-up sweep —
   * submits one a failed or evicted call left owed.
   */
  async answerTask(input: {
    taskId: string;
    messageId: string;
    reply: HumanReply;
  }): Promise<PlainTask | null> {
    await ensureStarted(this);
    const { taskId, messageId, reply } = input;
    const row = this.ledger.row(taskId);
    if (!row) return null;
    // An answer an earlier call resumed on and never submitted goes first.
    if (row.answer) await this.submitAnswer({ taskId });
    const request = row.request;
    if (!request || request.requestId !== reply.requestId) {
      console.warn("[agent] a reply names no question of this task", {
        taskId,
        requestId: reply.requestId
      });
      return this.ledger.get(taskId);
    }
    if (reply.kind === "timeout") {
      await this.queue("expireTask", { taskId, requestId: reply.requestId });
      return this.ledger.get(taskId);
    }
    const { optionId } = reply.answer;
    const option = request.options?.find((o) => o.id === optionId);
    if (optionId !== undefined && !option) {
      console.warn(
        "[agent] a reply picks an option the question never offered",
        {
          taskId,
          requestId: reply.requestId,
          optionId
        }
      );
      return this.ledger.get(taskId);
    }
    if (!option && request.options && !request.allowFreeform) {
      console.warn(
        "[agent] a typed reply to a question that takes only its options",
        { taskId, requestId: reply.requestId }
      );
      return this.ledger.get(taskId);
    }

    const text = [option?.label, reply.answer.text]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    if (this.ledger.resume(taskId, { id: `answer:${messageId}`, text })) {
      await this.submitAnswer({ taskId });
    }
    return this.ledger.get(taskId);
  }

  /**
   * Submit the answer's turn a resumed task owes, then clear it. A repeat
   * submits again under the same idempotency key, or finds it cleared.
   */
  async submitAnswer(payload: { taskId: string }): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(payload.taskId);
    if (!row?.answer) return;
    if (!isTerminalState(row.state)) {
      await this.runTurn({
        mode: "submit",
        input: userMessage(
          row.answer.id,
          row.answer.text,
          payload.taskId,
          row.contextId
        ),
        idempotencyKey: row.answer.id,
        metadata: { taskId: payload.taskId }
      });
    }
    this.ledger.answered(payload.taskId, row.answer.id);
  }

  /** A question nobody answered. Guarded, so an answer that won stays won. */
  async expireTask(payload: {
    taskId: string;
    requestId: string;
  }): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(payload.taskId);
    if (!row || row.request?.requestId !== payload.requestId) return;
    await this.#finish(
      payload.taskId,
      buildFailedTask(payload.taskId, row.contextId, this.copy.questionExpired)
    );
  }

  // --- settlement ------------------------------------------------------------

  /**
   * The submission ledger's view of a turn, turned into the task lifecycle.
   * Keyed on `metadata.taskId`; a submission without one is not a task's turn.
   */
  protected override async onSubmissionStatus(
    submission: ThinkSubmissionInspection
  ): Promise<void> {
    const taskId = submission.metadata?.taskId;
    if (typeof taskId !== "string") return;
    switch (submission.status) {
      case "running":
        if (this.ledger.markWorking(taskId) === "canceled") {
          await this.cancelSubmission(submission.submissionId, "task canceled");
        }
        return;
      case "completed":
        await this.#settleCompleted(taskId);
        return;
      case "error":
      case "skipped":
        await this.#finish(
          taskId,
          buildFailedTask(taskId, this.#contextOf(taskId), this.copy.failed)
        );
        return;
      default:
      // `pending` needs nothing, and `aborted` is a guarded no-op: the cancel
      // that caused it already settled the row.
    }
  }

  /**
   * What a completed turn means for the task, in this order:
   *
   *  1. a question is pending → park, and the caller is asked;
   *  2. work is still open → an interim turn: push its closing words and stay
   *     `working`;
   *  3. otherwise the turn is the answer.
   *
   * Without (2), a detached dispatch would settle the task the moment the
   * parent turn ended, and the child's result would land on a closed task.
   */
  async #settleCompleted(taskId: string): Promise<void> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;
    // The async read: the `messages` getter is empty on a cold object, and a
    // turn recovered after an eviction is exactly when this runs on one.
    const outcome = readTurn(await this.getMessages(), taskId);

    if (outcome.ask) {
      const request: HitlRequestData = {
        type: HITL_REQUEST_TYPE,
        requestId: `${taskId}:${outcome.ask.toolCallId}`,
        requestKind: "choice",
        prompt: outcome.ask.question,
        ...(outcome.ask.options
          ? {
              options: outcome.ask.options.map((label, i) => ({
                id: `option_${i + 1}`,
                label
              }))
            }
          : { allowFreeform: true })
      };
      const parked = buildInputRequiredTask(taskId, row.contextId, request);
      if (this.ledger.park(parked, request)) {
        await this.#enqueueDelivery(
          taskId,
          questionKey(request.requestId),
          parked
        );
      }
      return;
    }

    if (this.ledger.openWork(taskId) > 0) {
      if (outcome.reply) await this.#push(taskId, outcome.reply, "turn");
      return;
    }

    await this.#finish(
      taskId,
      buildCompletedTask(
        taskId,
        row.contextId,
        outcome.reply || this.copy.emptyReply
      )
    );
  }

  /**
   * The guarded terminal write — which owes the callback and the hooks in the
   * same statement — then the callback, then the hooks.
   */
  async #finish(taskId: string, task: Task): Promise<void> {
    if (!this.ledger.settle(task)) return;
    const state = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    await this.#enqueueDelivery(taskId, state, task);
    await this.#settled(taskId);
  }

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
      {
        id: `deliver:${taskId}:${key}`,
        retry: { maxAttempts: 8, baseDelayMs: 2_000, maxDelayMs: 300_000 }
      }
    );
  }

  /**
   * POST one callback, if it is still the one the task owes. Throws on a
   * non-2xx so the queue retries. A question the task has moved past — to an
   * answer, or to another question — is neither sent nor acknowledged.
   */
  async deliverTask(job: DeliveryJob): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(job.taskId);
    if (!row?.push || row.deliveryKey !== job.key) return;
    this.#origin.note(row.push.jku);
    await createPushChannel(this.env.A2A_SIGNING_KEY, row.push).deliver(
      Task.fromJSON(job.task)
    );
    this.ledger.delivered(job.taskId, job.key);
  }

  /** The settle hooks a start-up sweep found owed. */
  async runSettleHooks(payload: { taskId: string }): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(payload.taskId);
    if (!row?.hooksPending) return;
    if (row.state === "canceled") await this.#stopCanceled(payload.taskId);
    else await this.#settled(payload.taskId);
  }

  // --- cancellation ----------------------------------------------------------

  /**
   * The one place a task becomes canceled: the guarded flip first — terminal,
   * so every later non-canceled write is refused — then stop everything still
   * running for it. The flip's verdict decides whether anything else happens:
   * a cancel replayed on a task already canceled answers with it and stops
   * nothing twice.
   */
  async #cancel(taskId: string, task?: Task): Promise<PlainTask | null> {
    const canceled = this.ledger.cancel(taskId, task);
    if (!canceled) {
      return this.ledger.row(taskId)?.state === "canceled"
        ? this.ledger.get(taskId)
        : null;
    }
    await this.#stopCanceled(taskId);
    return canceled;
  }

  /**
   * Everything a cancel stops, then the hooks. Runs after the flip, and again
   * from the start-up sweep if an eviction cut it short, so every step is safe
   * to repeat.
   */
  async #stopCanceled(taskId: string): Promise<void> {
    const submissionId = this.ledger.row(taskId)?.submissionId;
    if (submissionId) {
      await this.cancelSubmission(submissionId, "task canceled").catch(
        (err: unknown) =>
          console.warn("[agent] submission not canceled", {
            taskId,
            err: String(err)
          })
      );
    }
    // `cancelSubmission` misses a recovered continuation, which runs under a
    // new request id, and a follow-up turn has a submission of its own.
    if (this.turnTaskId() === taskId) this.abortAllRequests();

    for (const work of this.ledger.openWorkRows(taskId)) {
      try {
        if (work.kind === "detached") {
          await this.cancelAgentTool(work.workId, "task canceled");
        } else if (work.kind === "wait" && work.scheduleId) {
          await this.cancelSchedule(work.scheduleId);
        }
      } catch (err) {
        console.warn("[agent] work not stopped", {
          taskId,
          workId: work.workId,
          err: String(err)
        });
      }
      this.ledger.closeWork(work.workId);
    }

    try {
      await this.onTaskCanceled(taskId);
    } catch (err) {
      console.warn("[agent] task cancel hook failed", {
        taskId,
        err: String(err)
      });
    }
    await this.#settled(taskId);
  }

  /**
   * End the transcript, then the subclass hook, then record that both ran.
   * The transcript first, because the hook may take as long as a container
   * takes to stop, while somebody may be watching for the line that says it
   * finished. At least once: an eviction before the record reruns them.
   */
  async #settled(taskId: string): Promise<void> {
    const state =
      this.ledger.get(taskId)?.status?.state ??
      TaskState.TASK_STATE_UNSPECIFIED;
    await settleTranscript(this.env, taskId, state);
    try {
      await this.onTaskSettled(taskId, state);
    } catch (err) {
      console.warn("[agent] task settle hook failed", {
        taskId,
        state,
        err: String(err)
      });
    }
    this.ledger.hooksRan(taskId);
  }

  /**
   * Stop work still in flight for a task just canceled, beyond what core
   * stops itself (the turn, detached runs, scheduled wakes). Best-effort:
   * cancellation is already recorded. At least once, like the settle hook.
   */
  protected async onTaskCanceled(_taskId: string): Promise<void> {}

  /**
   * A task reached a state it never leaves — release what was held for its
   * lifetime. Fires for every terminal state, `canceled` included, at least
   * once. A throw is logged and swallowed: the row is already durable.
   */
  protected async onTaskSettled(
    _taskId: string,
    _state: TaskState
  ): Promise<void> {}

  // --- delegation ------------------------------------------------------------

  /**
   * The tool the parent's model calls a sub-agent by.
   *
   * Awaited unless the spec says `detached`, and an awaited run must finish
   * inside the parent's turn. A detached run returns at once; its result
   * arrives through {@link onSubAgentFinish} as a follow-up turn.
   */
  protected subAgentTool(Cls: SubAgentClass): Tool {
    const spec = Cls.spec as SubAgentSpec<unknown, Env>;
    if (!spec) {
      throw new Error(
        `sub-agent ${Cls.name} has no static \`spec\` — set one on the class`
      );
    }
    const description = spec.detached
      ? `${spec.description}\n\nThis runs in the background: the call only starts it, and its result arrives as a later message. Say what you started, and stop.`
      : spec.description;
    return tool({
      description,
      inputSchema: spec.inputSchema,
      execute: async (input: unknown, { toolCallId, abortSignal }) => {
        const taskId = this.requireTurnTaskId();
        const runId = `${spec.detached ? "detached" : "agent-tool"}:${toolCallId}`;
        const runtime = await spec.prepare?.({
          input,
          taskId,
          runId,
          parent: this.pluginContext()
        });
        this.ledger.addWork({
          workId: runId,
          taskId,
          kind: spec.detached ? "detached" : "awaited",
          name: Cls.name,
          ...(runtime ? { runtime } : {})
        });
        const envelope: SubAgentEnvelope = {
          input,
          taskId,
          callerKey: this.callerKey(),
          ...(runtime ? { runtime } : {})
        };

        if (spec.detached) {
          const dispatch = await this.runAgentTool(Cls, {
            input: envelope,
            runId,
            parentToolCallId: toolCallId,
            detached: { onFinish: "onSubAgentFinish" }
          });
          if (dispatch.status !== "running") {
            // A synchronous rejection wires no `onFinish`: nothing would ever
            // close this row, and the task would stay `working` for ever.
            this.ledger.closeWork(runId);
            return failure(
              "error",
              dispatch.error ?? "the background run did not start"
            );
          }
          return { started: runId };
        }

        const result = await this.runAgentTool(Cls, {
          input: envelope,
          runId,
          parentToolCallId: toolCallId,
          signal: abortSignal
        });
        if (result.status === "completed") return result.summary ?? "";
        if (result.status === "interrupted") {
          return failure(
            "interrupted",
            result.error ??
              "the run was interrupted before it finished; it can be retried",
            true
          );
        }
        return failure(
          result.status,
          result.error ??
            (result.status === "aborted"
              ? "the run was cancelled"
              : "the run failed")
        );
      }
    });
  }

  /**
   * Every run's terminal, awaited and detached alike: replay its notes, close
   * an awaited run's work, and run the spec's `settle` once.
   */
  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    // A soft give-up: the child is still working and will finish again.
    if (result.status === "interrupted" && result.childStillRunning) return;
    const work = this.ledger.work(run.runId);
    if (!work) return;
    await this.#replayNotes(run, work);
    if (work.kind === "awaited") this.ledger.closeWork(run.runId);
    if (!this.ledger.claimSettle(run.runId)) return;
    const spec = this.#subAgent(work.name)?.spec as
      SubAgentSpec<unknown, Env> | undefined;
    try {
      await spec?.settle?.({
        runId: run.runId,
        taskId: work.taskId,
        runtime: work.runtime,
        result
      });
    } catch (err) {
      console.warn("[agent] sub-agent settle failed", {
        runId: run.runId,
        err: String(err)
      });
    }
  }

  /**
   * The `onFinish` of every detached run: close its work and submit the
   * follow-up turn that carries its result. Delivery is at-least-once, and the
   * work row is what makes the follow-up fire once per run.
   */
  async onSubAgentFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    await ensureStarted(this);
    if (result.status === "interrupted" && result.childStillRunning) return;
    const work = this.ledger.work(run.runId);
    if (!work) return;
    const row = this.ledger.row(work.taskId);
    if (!row || isTerminalState(row.state)) return;
    this.ledger.beginFollowUp(run.runId, {
      id: `finish:${run.runId}`,
      text: this.formatDetachedCompletion(run, result)
    });
    await this.submitFollowUp({ workId: run.runId });
  }

  /**
   * Submit the follow-up a closed work row owes, then clear it. A repeat — a
   * redelivered finish, the start-up sweep — finds it owed and submits again
   * under the same idempotency key, or finds it cleared and does nothing.
   */
  async submitFollowUp(payload: { workId: string }): Promise<void> {
    await ensureStarted(this);
    const work = this.ledger.work(payload.workId);
    const followUp = this.ledger.followUp(payload.workId);
    if (!work || !followUp) return;
    const row = this.ledger.row(work.taskId);
    if (row && !isTerminalState(row.state)) {
      await this.runTurn({
        mode: "submit",
        input: userMessage(
          followUp.id,
          followUp.text,
          work.taskId,
          row.contextId
        ),
        idempotencyKey: followUp.id,
        metadata: { taskId: work.taskId }
      });
    }
    this.ledger.endFollowUp(payload.workId);
  }

  /**
   * `check_back`: put the task down and pick it up later, as a scheduled wake
   * rather than a wait inside the turn — a turn cannot outlive fifteen
   * minutes. Opt-in: `check_back: this.checkBackTool()` in `getTools()`.
   */
  protected checkBackTool(): Tool {
    return tool({
      description: CHECK_BACK_DESCRIPTION,
      inputSchema: checkBackInputSchema,
      execute: async ({ seconds, why }, { toolCallId }) => {
        const taskId = this.requireTurnTaskId();
        const workId = `wait:${toolCallId}`;
        this.ledger.addWork({
          workId,
          taskId,
          kind: "wait",
          name: CHECK_BACK_TOOL_NAME
        });
        const schedule = await this.schedule<CheckBackWake>(
          seconds,
          "onCheckBack",
          { taskId, workId, seconds, why }
        );
        this.ledger.setWorkSchedule(workId, schedule.id);
        return { waiting: seconds };
      }
    });
  }

  /** The wake `check_back` scheduled: the same follow-up as a finished run. */
  async onCheckBack(wake: CheckBackWake): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(wake.taskId);
    if (!row || isTerminalState(row.state)) return;
    this.ledger.beginFollowUp(wake.workId, {
      id: `wake:${wake.workId}`,
      text: `Waited ${wake.seconds}s: ${wake.why}`
    });
    await this.submitFollowUp({ workId: wake.workId });
  }

  // --- the transcript --------------------------------------------------------

  /**
   * A child's live note. Best-effort and not replayed after an eviction, which
   * is why the finish hook replays the persisted copy. The task comes from the
   * work row: a detached run reports while no turn of this agent is running.
   */
  override async onProgress(
    run: AgentToolRunInfo,
    progress: AgentToolProgressSnapshot
  ): Promise<void> {
    if (progress.milestone !== NOTE_MILESTONE) return;
    const note = readNote(progress.data);
    const taskId = this.ledger.work(run.runId)?.taskId;
    if (note && taskId) await this.#note(taskId, run, note);
  }

  /**
   * Every note the child persisted, delivered again. Safe because the
   * transcript dedupes on the note's key: a note that landed is kept once.
   */
  async #replayNotes(run: AgentToolRunInfo, work: WorkRow): Promise<void> {
    const Cls = this.#subAgent(work.name);
    if (!Cls) return;
    try {
      const child = await this.dynamicAgents.get(Cls, run.runId);
      const inspection = (await child.inspectAgentToolRun(run.runId)) as {
        milestones?: AgentToolMilestone[];
      } | null;
      for (const milestone of inspection?.milestones ?? []) {
        if (milestone.name !== NOTE_MILESTONE) continue;
        const note = readNote(milestone.data);
        if (note) await this.#note(work.taskId, run, note);
      }
    } catch (err) {
      console.warn("[agent] notes not replayed", {
        runId: run.runId,
        err: String(err)
      });
    }
  }

  async #note(
    taskId: string,
    run: AgentToolRunInfo,
    note: NoteData
  ): Promise<void> {
    const channel = this.#channel(taskId);
    if (!channel) return;
    await transcribeNote(
      this.env,
      {
        taskId,
        origin: this.#origin.peek(),
        source: { type: run.agentType, ordinal: run.displayOrder },
        text: note.text,
        key: note.key
      },
      (line) => channel.working(line, note.key)
    );
  }

  // --- identity and helpers --------------------------------------------------

  /**
   * The verified caller this object serves. The object is addressed by it, so
   * its name is the key — durable, and correct by construction.
   */
  callerKey(): string {
    return this.name;
  }

  /** This deployment's own origin, once a turn has carried it here. */
  protected selfOrigin(): string | undefined {
    return this.#origin.peek();
  }

  /** The same, for a caller that cannot go on without it. */
  protected requireSelfOrigin(): string {
    return this.#origin.require();
  }

  /**
   * The caller block's text. A rendering of a protocol fact, so core supplies
   * it; override to name what a workspace id means in a deployment.
   */
  protected callerContext(identity: GatekeeperIdentity): string {
    return callerContext(identity).trim();
  }

  protected pluginContext(): PluginContext<Env> {
    return {
      env: this.env,
      storage: this.ctx.storage,
      agentName: this.name,
      callerKey: () => this.callerKey(),
      workspace: () => this.workspace,
      runtime: () => undefined
    };
  }

  /** The task the running turn belongs to, from the message that started it. */
  protected turnTaskId(): string | undefined {
    const taskId = (this.activeTurnMetadata as { taskId?: unknown } | undefined)
      ?.taskId;
    return typeof taskId === "string" ? taskId : undefined;
  }

  protected requireTurnTaskId(): string {
    const taskId = this.turnTaskId();
    if (!taskId) {
      throw new Error(
        "this turn carries no task id: a tool that records work runs inside a " +
          "turn submitted for a task"
      );
    }
    return taskId;
  }

  #subAgent(name: string): SubAgentClass | undefined {
    return this.getSubAgents().find((Cls) => Cls.name === name);
  }

  /** Best-effort progress. A post that does not arrive never fails a turn. */
  async #push(taskId: string, text: string, prefix: string): Promise<void> {
    await this.#channel(taskId)?.working(
      text,
      this.ledger.nextPushKey(taskId, prefix)
    );
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
 * One submitted user message, with the task riding in `turnMetadata`: only
 * the message's copy is visible during the turn (`activeTurnMetadata`) and
 * survives into a recovered one. The submission carries it too, for
 * `onSubmissionStatus`, which sees that copy alone.
 */
function userMessage(
  id: string,
  text: string,
  taskId: string,
  contextId: string
): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { turnMetadata: { taskId, contextId } }
  };
}

/** The envelope `agentTool` returns for a run that did not complete. */
function failure(
  status: "error" | "aborted" | "interrupted",
  error: string,
  retryable = false
) {
  return { ok: false as const, status, error, retryable };
}

function readNote(data: unknown): NoteData | null {
  const note = data as Partial<NoteData> | undefined;
  return typeof note?.key === "string" &&
    typeof note.text === "string" &&
    note.text
    ? { key: note.key, text: note.text }
    : null;
}
