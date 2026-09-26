import {
  Think,
  defaultContextOverflowClassifier,
  type ThinkModel,
  type ThinkScheduledTasks,
  type ThinkSession,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type WorkspaceLike
} from "@cloudflare/think";
import { createCompactFunction } from "agents/sessions";
import type { ContextConfig } from "agents/context";
import type {
  AgentToolLifecycleResult,
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInfo
} from "agents";
import {
  generateText,
  hasToolCall,
  tool,
  type Tool,
  type ToolSet,
  type UIMessage
} from "ai";
import { z } from "zod";
import { Task, TaskState } from "@a2a-js/sdk";
import {
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import {
  buildCompletedTask,
  buildFailedTask
} from "../a2a/notify.js";
import { buildInputRequiredTask } from "../a2a/hitl.js";
import type { HumanReply } from "../a2a/hitl.js";
import { callerContext } from "../a2a/caller.js";
import { createPushChannel, type PushChannel } from "../a2a/push.js";
import { SelfOrigin } from "../a2a/self-origin.js";
import { taskStateLabel, type PlainTask } from "../a2a/task.js";
import type { AcceptedTurn } from "../a2a/executor.js";
import type { TaskListPage, TaskListQuery } from "../a2a/agent-stub.js";
import type { A2ASecretsEnv, ArtifactsEnv } from "../env.js";
import {
  assertArtifactsBound,
  settleTranscript,
  transcribeNote
} from "../artifacts/index.js";
import type { AgentPlugin, PluginContext } from "../contract/plugin.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/index.js";
import { ensureStarted } from "./lifecycle.js";
import { readTurn } from "./outcome.js";
import { A2ATasks, isTerminalState } from "./tasks.js";
import { subAgentTool, type SubAgentClass, type SubAgentHost } from "./sub-agent.js";
import { askUserTool, searchHistoryTool } from "./tools.js";

/**
 * The agent behind core's A2A edge: one Durable Object per verified caller,
 * keyed by the gatekeeper `identity.key`.
 *
 * Think owns the conversation — durable turns, recovery, compaction, sub-agents,
 * tools. What core owns is the half Think has no opinion about: **an A2A task,
 * and how it ends.** Three rules hold that together, and each is a thing that
 * broke first.
 *
 *  - **A raw Durable Object RPC does not start Think's lifecycle.** Every method
 *    the executor or the task store calls begins by starting it — see
 *    {@link file://./lifecycle.ts ensureStarted}.
 *  - **`onSubmissionStatus` is not a delivery channel.** It fires inside the
 *    turn slot and its errors are only logged, so it does the guarded write and
 *    hands the callback to a durable queue.
 *  - **Cancellation is decided by the guarded write, never by a probe.** A read
 *    then an act reopens the window where a cancel lands and the gatekeeper
 *    still gets a `completed`.
 *
 * And one that is the whole shape of the thing: **a task outlives its turn.** A
 * turn ends when the model stops calling tools, but the task stays `working`
 * while the work ledger says it has open work — a detached sub-agent run, a
 * scheduled wake — and is settled by whichever follow-up turn finds none left.
 */

/** The strings a person reads when the agent cannot answer. */
export interface A2ACopy {
  /** The turn errored. */
  failed: string;
  /** The turn ended having said nothing. */
  emptyReply: string;
  /** Nobody answered the question the task asked. */
  questionExpired: string;
}

/** What `onCheckBack` is handed by the schedule that created it. */
interface CheckBackWake {
  taskId: string;
  workId: string;
  seconds: number;
  why: string;
}

/** What the delivery outbox carries. Strings and JSON — it crosses a queue. */
interface DeliveryJob {
  taskId: string;
  state: string;
  task: unknown;
}

/** What the queue hands `expireTask`. */
interface ExpiryJob {
  taskId: string;
  requestId: string;
}

/** How long a settled task and its work survive before the weekly sweep. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The bounds a `check_back` wake is held to: ten seconds to an hour. */
const CHECK_BACK_SECONDS = { min: 10, max: 3600 } as const;

/** What the caller's context block is labelled in the system prompt. */
const CALLER_BLOCK = "caller";

/** The persisted per-instance config: what `configureContext` reads back. */
interface A2AConfig {
  caller?: string;
}

export abstract class A2AAgent<
  Env extends Cloudflare.Env & A2ASecretsEnv & ArtifactsEnv
> extends Think<Env> {
  /**
   * A re-attaching parent gives up on a silent child after this. `Infinity`,
   * because the gatekeeper's own hour is the only bound this design wants: a
   * detached child that says nothing for two minutes is normal.
   */
  static options = { agentToolReattachNoProgressTimeoutMs: Infinity };

  /**
   * No step or recovery budget, and `submissionRecoveryStaleMs` is left at
   * Think's fifteen minutes — it is not a budget but the measured point past
   * which a recovered submission's messages can no longer be trusted, and
   * raising it would seal a turn that had already half-applied.
   */
  maxSteps = Infinity;
  chatRecovery = { maxRecoveryWork: Infinity };
  contextOverflow = { reactive: true };
  classifyChatError = defaultContextOverflowClassifier;

  /** The A2A task and work ledger. Not `this.tasks`: `Agent` already has one. */
  protected readonly ledger = new A2ATasks((strings, ...values) =>
    this.sql(strings, ...values)
  );

  /** Learned from the `jku` every turn carries; never configured. */
  private readonly origin = new SelfOrigin();

  /** Built in `onStart`, from {@link getPlugins}. */
  protected plugins!: AgentRuntime<Env>;

  /** What `prepare` resolved per run, so `settle` can be handed it. */
  private readonly runtimes = new Map<string, Record<string, unknown>>();

  /** Assistant text seen this step, flushed when the step's first tool starts. */
  private buffered = "";
  private flushedThisStep = false;

  // --- what the agent supplies ----------------------------------------------

  /** The model this agent runs on. One model; there is no fallback. */
  abstract override getModel(): ThinkModel;

  /**
   * The strings a person reads when the agent cannot answer.
   *
   * Abstract because core ships no prompt copy: what to say when a turn broke
   * is the agent's voice, and a sentence lent by a framework is the one sentence
   * every deployment sounds identical in.
   */
  protected abstract get copy(): A2ACopy;

  /** Compact the conversation once the stamped token estimate crosses this. */
  protected abstract get compactAfterTokens(): number;

  /** Token budget for the recent tail a compaction keeps verbatim. */
  protected abstract get keepRecentTokens(): number;

  /** The capabilities this agent installs. */
  getPlugins(): AgentPlugin<Env>[] {
    return [];
  }

  /** The sub-agents this agent may delegate to, one tool each. */
  getSubAgents(): SubAgentClass[] {
    return [];
  }

  /** The task was canceled. Keyed on the guarded write's verdict, so it fires once. */
  protected async onTaskCanceled(_taskId: string): Promise<void> {}

  /** The task reached a terminal state. Keyed on the guarded write's verdict. */
  protected async onTaskSettled(
    _taskId: string,
    _state: TaskState
  ): Promise<void> {}

  // --- Think ----------------------------------------------------------------

  override async onStart(): Promise<void> {
    await super.onStart();
    // A wiring fault with a name: every sub-agent note is filed on the task's
    // transcript, so the binding is required rather than optional.
    assertArtifactsBound(this.env);
    this.plugins = createAgentRuntime<Env>({
      plugins: this.getPlugins(),
      env: this.env
    });
    const workspace = this.plugins.workspace(this.pluginContext());
    if (workspace) this.workspace = workspace;
    // A crash between settling a task and queueing its callback leaves the row
    // flagged; the sweep is what turns that into a delivery.
    for (const pending of this.ledger.pendingDeliveries()) {
      const task = this.ledger.get(pending.taskId);
      if (task) await this.enqueueDelivery(pending.taskId, task as Task);
    }
  }

  override configureSession(session: ThinkSession): ThinkSession {
    return session
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.resolveModel(), prompt }).then(
              (r) => r.text
            ),
          keepRecentTokens: this.keepRecentTokens
        })
      )
      .compactAfter(this.compactAfterTokens);
  }

  /**
   * The context blocks the system prompt is built from.
   *
   * The plugins' blocks, plus a read-only rendering of who is calling — see
   * {@link file://../a2a/caller.ts callerContext}. An agent adds its soul and
   * its memory in front: `[soul, memory, ...super.configureContext()]`.
   */
  override configureContext(): ContextConfig[] {
    const caller = this.getConfig<A2AConfig>()?.caller ?? "";
    return [
      ...this.plugins.context(),
      { label: CALLER_BLOCK, provider: { get: async () => caller } }
    ];
  }

  override getTools(): ToolSet {
    const tools: ToolSet = {
      ...this.plugins.tools(this.pluginContext()),
      ask_user: askUserTool(),
      search_history: searchHistoryTool(() => this.session)
    };
    for (const Cls of this.getSubAgents()) {
      tools[Cls.spec.name] = subAgentTool(this.subAgentHost(), Cls);
    }
    return tools;
  }

  override getActions() {
    return this.plugins.actions(this.pluginContext());
  }

  /**
   * Both of these end the turn the moment the tool is called: `ask_user` has no
   * `execute` and is waiting for a person, and `check_back` has already
   * scheduled its own wake. Without them the loop runs another step on a turn
   * that is finished.
   */
  override beforeTurn(): TurnConfig {
    return {
      stopWhen: [hasToolCall("ask_user"), hasToolCall("check_back")]
    };
  }

  /**
   * Push the sentences the model wrote *before* a tool call, at the moment the
   * tool starts.
   *
   * `onStepEnd` fires after the step's tools have finished, which is too late
   * for a tool that takes minutes: the caller would watch an agent say nothing
   * and then answer. The first `tool-call` chunk is the earliest point at which
   * the text is known to be complete.
   */
  override async onChunk(ctx: {
    chunk: { type: string; text?: string };
  }): Promise<void> {
    const chunk = ctx.chunk;
    if (chunk.type === "text-delta") {
      this.buffered += chunk.text ?? "";
      return;
    }
    if (chunk.type !== "tool-call" || this.flushedThisStep) return;
    this.flushedThisStep = true;
    const text = this.buffered.trim();
    this.buffered = "";
    if (!text) return;
    const taskId = this.turnTaskId();
    if (!taskId) return;
    await this.push(taskId, text, "step");
  }

  override onStepEnd(): void {
    this.buffered = "";
    this.flushedThisStep = false;
  }

  /**
   * An interrupted `ask_user` becomes the question as plain text.
   *
   * The default repair flips a dangling call to an errored tool result, which
   * the model reads as a tool that broke. This one is not broken: it is a
   * question that was asked, and the next user message answers it.
   */
  protected override repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    if (part.type === "tool-ask_user") {
      const input = (part as { input?: { question?: unknown } }).input;
      if (typeof input?.question === "string") {
        return { type: "text", text: input.question };
      }
    }
    return super.repairInterruptedToolPart(part);
  }

  /** A canceled task's interrupted turn is not continued. */
  override async onChatRecovery(): Promise<{ continue: boolean } | void> {
    const taskId = this.turnTaskId();
    if (!taskId) return;
    if (this.ledger.row(taskId)?.state === "canceled") {
      return { continue: false };
    }
  }

  /**
   * Retention, declared rather than scheduled: Think reconciles this on every
   * start, so there is no cron to install and none to forget to remove.
   */
  override getScheduledTasks(): ThinkScheduledTasks {
    return {
      a2aRetention: {
        schedule: "every week on sunday at 01:00 in UTC",
        handler: () => this.sweepRetention()
      }
    };
  }

  /**
   * Drop everything older than the retention window: the task rows, Think's
   * submission ledger, and the agent-tool run rows.
   *
   * `deleteSubmissions` caps at 500 per call, so it runs until a call deletes
   * fewer than it asked for — a single call on a busy object would leave the
   * table growing a little every week.
   */
  protected async sweepRetention(): Promise<void> {
    const cutoff = Date.now() - RETENTION_MS;
    this.ledger.sweep(cutoff);
    const completedBefore = new Date(cutoff);
    for (;;) {
      const deleted = await this.deleteSubmissions({ completedBefore });
      if (deleted === 0) break;
    }
    await this.clearAgentToolRuns({ olderThan: cutoff });
  }

  // --- the A2A surface core calls -------------------------------------------

  /**
   * Record the task, start its turn, and answer with the task.
   *
   * Idempotent in the way that actually happens: a dispatch retry arrives with
   * the same `messageId`, finds the submission already bound, and starts
   * nothing. Think's own `idempotencyKey` closes the narrower race underneath.
   */
  async acceptTask(turn: AcceptedTurn): Promise<PlainTask> {
    await ensureStarted(this);
    this.origin.note(turn.jku);
    const { row, task } = this.ledger.accept(turn);
    if (row.state !== "submitted" || row.submissionId) return task;

    this.configure<A2AConfig>({ caller: callerContext(turn.identity) });
    const submission = await this.runTurn({
      mode: "submit",
      input: userMessage(turn.messageId, turn.text, {
        taskId: row.taskId,
        contextId: row.contextId
      }),
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
   * The a2a-js `TaskStore` write path. A `canceled` state routes to the same
   * interruption `cancelTask` takes — the SDK's own cancel branch writes the
   * canceled task through here rather than calling the executor, so the two
   * have to converge or a cancel from the wire stops nothing.
   */
  async saveTask(task: Task): Promise<boolean> {
    await ensureStarted(this);
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) {
      return (await this.markCanceled(task.id, task)) !== null;
    }
    return this.ledger.save(task);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    await ensureStarted(this);
    return this.markCanceled(taskId);
  }

  /**
   * Record a person's reply to a question this task asked, and submit it as the
   * next turn.
   *
   * There is no run to wake: the answer is a user message, and Think's turn
   * queue orders it behind anything still running.
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
    if (!row.request || row.request.requestId !== reply.requestId) {
      console.warn("[a2a] a reply names no question of this task", {
        taskId,
        requestId: reply.requestId
      });
      return this.ledger.get(taskId);
    }

    if (reply.kind === "timeout") {
      // From the queue, not inline. Failing the task here would make the SDK
      // refuse the very message reporting the expiry: it loads the task first
      // and a terminal one takes no messages.
      await this.queue<ExpiryJob>("expireTask", {
        taskId,
        requestId: reply.requestId
      });
      return this.ledger.get(taskId);
    }

    if (this.ledger.resume(taskId) === null) return this.ledger.get(taskId);

    // The label the person saw, not the id the wire carried: the option ids are
    // this agent's own, and the model wrote the labels.
    const answer =
      reply.answer.text ??
      row.request.options?.find((option) => option.id === reply.answer.optionId)
        ?.label ??
      reply.answer.optionId ??
      "";
    await this.runTurn({
      mode: "submit",
      input: userMessage(`answer:${messageId}`, answer, {
        taskId,
        contextId: row.contextId
      }),
      idempotencyKey: `answer:${messageId}`,
      metadata: { taskId }
    });
    return this.ledger.get(taskId);
  }

  // --- settlement ------------------------------------------------------------

  /**
   * The submission ledger's view of a turn, turned into the task lifecycle.
   *
   * Keyed on `metadata.taskId`: a submission without one is not a task's turn
   * and is none of this agent's business.
   */
  protected override async onSubmissionStatus(
    submission: ThinkSubmissionInspection
  ): Promise<void> {
    const taskId = submission.metadata?.taskId;
    if (typeof taskId !== "string") return;

    if (submission.status === "running") {
      if (this.ledger.markWorking(taskId) === "canceled") {
        await this.cancelSubmission(submission.submissionId, "task canceled");
      }
      return;
    }
    if (submission.status === "completed") {
      await this.settleCompleted(taskId);
      return;
    }
    if (submission.status === "error" || submission.status === "skipped") {
      await this.finish(
        taskId,
        buildFailedTask(taskId, this.contextOf(taskId), this.copy.failed)
      );
    }
    // `aborted` is a guarded no-op: the cancel that caused it already settled
    // the row, and anything written here would be written over it.
  }

  /**
   * What a completed turn means for the task, in this order:
   *
   *  1. a question is pending → park, and the caller is asked;
   *  2. work is still open → this was an interim turn; push what it said and
   *     leave the task `working`;
   *  3. otherwise the turn is the answer.
   *
   * The order is the whole design: without (2) a detached dispatch would settle
   * the task the moment the parent turn ended, and the child's result would
   * arrive on a task the gatekeeper had already closed.
   */
  private async settleCompleted(taskId: string): Promise<void> {
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;

    // The async read, not the synchronous `messages` getter: that one is empty
    // on a cold object, and a turn recovered after an eviction is exactly when
    // this runs on one.
    const outcome = readTurn(await this.getMessages(), taskId);

    if (outcome.ask) {
      const request: HitlRequestData = {
        type: HITL_REQUEST_TYPE,
        requestId: `${taskId}:${outcome.ask.toolCallId}`,
        requestKind: "choice",
        prompt: outcome.ask.question,
        options: outcome.ask.options,
        allowFreeform: true
      };
      const parked = buildInputRequiredTask(taskId, row.contextId, request);
      if (!this.ledger.park(parked, request)) return;
      await this.enqueueDelivery(taskId, parked);
      return;
    }

    if (this.ledger.openWork(taskId) > 0) {
      if (outcome.text) await this.push(taskId, outcome.text, "turn");
      return;
    }

    await this.finish(
      taskId,
      buildCompletedTask(
        taskId,
        row.contextId,
        outcome.reply || this.copy.emptyReply
      )
    );
  }

  /** The guarded terminal write, then the durable callback, then the hooks. */
  private async finish(taskId: string, task: PlainTask): Promise<void> {
    if (!this.ledger.settle(task as Task)) return;
    await this.enqueueDelivery(taskId, task as Task);
    await settleTranscript(this.env, taskId, task.status.state);
    await this.onTaskSettled(taskId, task.status.state);
  }

  /**
   * Hand one callback to the queue.
   *
   * `onSubmissionStatus` fires inside the turn slot and its errors are only
   * logged, so nothing there may be the thing that delivers. The stable id
   * makes a repeat replace the pending item instead of queueing a second one.
   */
  private async enqueueDelivery(taskId: string, task: Task): Promise<void> {
    const state = taskStateLabel(
      task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED
    );
    await this.queue<DeliveryJob>(
      "deliverTask",
      { taskId, state, task: Task.toJSON(task) },
      {
        id: `deliver:${taskId}:${state}`,
        retry: { maxAttempts: 8, baseDelayMs: 2_000, maxDelayMs: 300_000 }
      }
    );
  }

  /**
   * POST one callback. Throws on a non-2xx so the queue retries — this is the
   * delivery the whole task exists for.
   */
  async deliverTask(job: DeliveryJob): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(job.taskId);
    if (!row?.push) return;
    await createPushChannel(this.env.A2A_SIGNING_KEY, row.push).deliver(
      Task.fromJSON(job.task)
    );
    this.ledger.clearPendingDelivery(job.taskId);
  }

  /** A question nobody answered. Guarded, so a late answer still wins. */
  async expireTask(job: ExpiryJob): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(job.taskId);
    if (!row || row.request?.requestId !== job.requestId) return;
    await this.finish(
      job.taskId,
      buildFailedTask(job.taskId, row.contextId, this.copy.questionExpired)
    );
  }

  // --- cancellation ----------------------------------------------------------

  /**
   * The one place a task becomes canceled: flip the row — terminal, so every
   * non-canceled write is refused afterwards — then stop what is still running
   * for it.
   *
   * The flip's verdict is what decides whether anything else happens. Reading
   * the state first and acting second is the race this closes.
   */
  private async markCanceled(
    taskId: string,
    task?: Task
  ): Promise<PlainTask | null> {
    const before = this.ledger.row(taskId);
    const canceled = task
      ? this.ledger.save(task)
        ? this.ledger.get(taskId)
        : null
      : this.ledger.cancel(taskId);
    if (!canceled) return null;

    const row = this.ledger.row(taskId);
    if (row?.submissionId) {
      await this.cancelSubmission(row.submissionId, "task canceled").catch(
        (err: unknown) => {
          console.warn("[a2a] submission not canceled", {
            taskId,
            err: String(err)
          });
        }
      );
    }
    // `cancelSubmission` misses a recovered continuation, which runs under a
    // new request id — so the running turn is aborted directly as well.
    if (this.turnTaskId() === taskId) this.abortAllRequests();

    for (const work of this.ledger.openWorkRows(taskId)) {
      if (work.kind === "detached") {
        await this.cancelAgentTool(work.workId, "task canceled").catch(
          (err: unknown) => {
            console.warn("[a2a] detached run not canceled", {
              runId: work.workId,
              err: String(err)
            });
          }
        );
      } else if (work.scheduleId) {
        await this.cancelSchedule(work.scheduleId);
      }
      this.ledger.closeWork(work.workId);
    }

    if (!before || !isTerminalState(before.state)) {
      await settleTranscript(this.env, taskId, TaskState.TASK_STATE_CANCELED);
      await this.onTaskCanceled(taskId);
    }
    return canceled;
  }

  // --- delegation ------------------------------------------------------------

  /**
   * Stop working and come back to this task later.
   *
   * Not in {@link getTools} by default: an agent whose turns are answered in one
   * pass has nothing to come back to, and offering the tool anyway teaches the
   * model to stall. An agent that wants it writes
   * `check_back: this.checkBackTool()`.
   *
   * The turn ends on the `stopWhen`; the wait row is what keeps the task
   * `working` in the meantime, and `onCheckBack` is what starts the next turn.
   */
  protected checkBackTool(): Tool {
    return tool({
      description:
        "Stop working on this task and come back to it later. The turn ends " +
        "here; you are woken with the reason you gave.",
      inputSchema: z.object({
        seconds: z
          .number()
          .int()
          .min(CHECK_BACK_SECONDS.min)
          .max(CHECK_BACK_SECONDS.max),
        why: z.string().min(1)
      }),
      execute: async ({ seconds, why }) => {
        const taskId = this.turnTaskId();
        if (!taskId) {
          throw new Error(
            "check_back ran outside a task's turn: a tool that records work " +
              "has to run inside a turn submitted with " +
              "`metadata.turnMetadata.taskId`"
          );
        }
        const workId = `wait:${taskId}:${crypto.randomUUID()}`;
        // The schedule first, the row second: a crash between them leaves a
        // wake that finds no open row and does nothing, while the other order
        // leaves a row nothing will ever close and a task stuck `working`.
        const schedule = await this.schedule<CheckBackWake>(
          seconds,
          "onCheckBack",
          { taskId, workId, seconds, why }
        );
        this.ledger.addWork(workId, taskId, "wait", "check_back", schedule.id);
        return { waiting: seconds, why };
      }
    });
  }

  /** The wake a `check_back` scheduled. Same follow-up shape as a finished run. */
  async onCheckBack(wake: CheckBackWake): Promise<void> {
    await ensureStarted(this);
    const row = this.ledger.row(wake.taskId);
    if (!row || isTerminalState(row.state)) return;
    if (!this.ledger.closeWork(wake.workId)) return;
    await this.runTurn({
      mode: "submit",
      input: userMessage(
        `wake:${wake.workId}`,
        `Waited ${wake.seconds}s: ${wake.why}`,
        { taskId: wake.taskId, contextId: row.contextId }
      ),
      idempotencyKey: `wake:${wake.workId}`,
      metadata: { taskId: wake.taskId }
    });
  }

  /**
   * An awaited run finished, inside the turn that dispatched it.
   *
   * `replayNotes` first, so the transcript holds everything the child said
   * before the turn that reads its result can settle the task.
   */
  override async onAgentToolFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    const taskId = this.ledger.taskOfWork(run.runId);
    if (taskId) await this.replayNotes(run, taskId);
    await this.settleRun(run, result);
  }

  /**
   * The `onFinish` every detached run is dispatched with.
   *
   * Delivery is exactly-once on the happy path and at-least-once under a crash,
   * so this has to be idempotent — which is what the guarded `closeWork` buys:
   * the first delivery closes the row and submits the follow-up turn, and a
   * repeat finds it closed and does nothing.
   */
  async onSubAgentFinish(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    await ensureStarted(this);
    // A soft give-up. The child is still working and will fire this hook again
    // with its real result, so treating it as the answer would lose that.
    if (result.status === "interrupted" && result.childStillRunning) return;

    const taskId = this.ledger.taskOfWork(run.runId);
    if (!taskId) return;
    const row = this.ledger.row(taskId);
    if (!row || isTerminalState(row.state)) return;
    if (!this.ledger.closeWork(run.runId)) return;

    await this.replayNotes(run, taskId);
    await this.settleRun(run, result);
    await this.runTurn({
      mode: "submit",
      input: userMessage(
        `finish:${run.runId}`,
        this.formatDetachedCompletion(run, result),
        { taskId, contextId: row.contextId }
      ),
      idempotencyKey: `finish:${run.runId}`,
      metadata: { taskId }
    });
  }

  /** Let the sub-agent's spec release whatever its `prepare` acquired. */
  private async settleRun(
    run: AgentToolRunInfo,
    result: AgentToolLifecycleResult
  ): Promise<void> {
    const spec = this.getSubAgents().find(
      (Cls) => Cls.name === run.agentType
    )?.spec;
    const runtime = this.runtimes.get(run.runId);
    this.runtimes.delete(run.runId);
    if (!spec?.settle) return;
    try {
      await spec.settle({ runId: run.runId, runtime, result });
    } catch (err) {
      // The run is already terminal, so a release that throws must not be what
      // fails the turn that is about to read its result.
      console.warn("[a2a] sub-agent settle hook failed", {
        runId: run.runId,
        err: String(err)
      });
    }
  }

  // --- the transcript --------------------------------------------------------

  /**
   * A child's live progress, while no turn of this agent is running.
   *
   * The task cannot come from `activeTurnMetadata` here — a detached run reports
   * with nothing active — so it comes from the work row the dispatch wrote.
   */
  override async onProgress(
    run: AgentToolRunInfo,
    progress: AgentToolProgressSnapshot
  ): Promise<void> {
    if (progress.milestone !== "note") return;
    const taskId = this.ledger.taskOfWork(run.runId);
    if (!taskId) return;
    const data = progress.data as { key?: unknown; text?: unknown } | undefined;
    if (typeof data?.key !== "string") return;
    await this.note(
      taskId,
      run,
      String(data.text ?? progress.message ?? ""),
      data.key
    );
  }

  /**
   * Every note the child persisted, delivered again when the run finishes.
   *
   * {@link onProgress} is best-effort and is not replayed after an eviction, so
   * the live path can silently miss notes. The replay is safe because the
   * artifact dedupes on the note key — a note that did land is recorded once —
   * and it runs before the task settles its transcript.
   */
  private async replayNotes(
    run: AgentToolRunInfo,
    taskId: string
  ): Promise<void> {
    const Cls = this.getSubAgents().find((c) => c.name === run.agentType);
    if (!Cls) return;
    try {
      const child = await this.dynamicAgents.get(Cls, run.runId);
      for (const milestone of await milestonesOf(child, run.runId)) {
        if (milestone.name !== "note") continue;
        const data = milestone.data as
          | { key?: unknown; text?: unknown }
          | undefined;
        if (typeof data?.key !== "string") continue;
        await this.note(taskId, run, String(data.text ?? ""), data.key);
      }
    } catch (err) {
      console.warn("[a2a] milestones not replayed", {
        runId: run.runId,
        err: String(err)
      });
    }
  }

  private async note(
    taskId: string,
    run: AgentToolRunInfo,
    text: string,
    key: string
  ): Promise<void> {
    const channel = this.channel(taskId);
    if (!channel || !text) return;
    await transcribeNote(
      this.env,
      {
        taskId,
        origin: this.origin.peek(),
        source: { type: run.agentType, ordinal: run.displayOrder },
        text,
        key
      },
      (line) => channel.working(line, key)
    );
  }

  // --- identity + context ----------------------------------------------------

  /** The verified caller this object belongs to — the name it is keyed by. */
  protected callerKey(): string {
    return this.name;
  }

  /** This deployment's own origin, or `undefined` before the first turn. */
  protected selfOrigin(): string | undefined {
    return this.origin.peek();
  }

  /** This deployment's own origin, for a caller that cannot proceed without it. */
  protected requireSelfOrigin(): string {
    return this.origin.require();
  }

  protected pluginContext(): PluginContext<Env> {
    return {
      env: this.env,
      storage: this.ctx.storage,
      agentName: this.name,
      callerKey: () => this.callerKey(),
      workspace: (): WorkspaceLike => this.workspace,
      // The parent runs no dispatch of its own, so there is nothing a `prepare`
      // could have resolved for it.
      runtime: () => undefined
    };
  }

  /** What a sub-agent tool needs of this agent, and nothing more. */
  private subAgentHost(): SubAgentHost {
    return {
      turnTaskId: () => this.turnTaskId(),
      pluginContext: () => this.pluginContext() as PluginContext,
      addWork: (workId, taskId, kind, name) =>
        this.ledger.addWork(workId, taskId, kind, name),
      closeWork: (workId) => this.ledger.closeWork(workId),
      rememberRuntime: (runId, runtime) => this.runtimes.set(runId, runtime),
      runAgentTool: this.runAgentTool.bind(this)
    };
  }

  // --- small helpers ---------------------------------------------------------

  /** Best-effort progress. A post that does not arrive never fails a turn. */
  private async push(
    taskId: string,
    text: string,
    prefix: string
  ): Promise<void> {
    const channel = this.channel(taskId);
    if (!channel) return;
    await channel.working(text, this.ledger.nextPushKey(taskId, prefix));
  }

  private channel(taskId: string): PushChannel | null {
    const push = this.ledger.row(taskId)?.push ?? null;
    return push ? createPushChannel(this.env.A2A_SIGNING_KEY, push) : null;
  }

  private contextOf(taskId: string): string {
    return this.ledger.row(taskId)?.contextId ?? "";
  }

  /** The task the running turn belongs to, from the message that started it. */
  protected turnTaskId(): string | undefined {
    const metadata = this.activeTurnMetadata as
      | { taskId?: unknown }
      | undefined;
    return typeof metadata?.taskId === "string" ? metadata.taskId : undefined;
  }
}

/**
 * The milestones a child persisted for one run.
 *
 * `inspectAgentToolRun` returns them — the child's row carries the milestone
 * table — but Think's own `AgentToolRunInspection` type omits the field that
 * `agents`' copy declares. Narrowed here rather than at every call site, so the
 * gap has one home.
 */
async function milestonesOf(
  child: { inspectAgentToolRun(runId: string): Promise<unknown> },
  runId: string
): Promise<AgentToolMilestone[]> {
  const inspection = (await child.inspectAgentToolRun(runId)) as {
    milestones?: AgentToolMilestone[];
  } | null;
  return inspection?.milestones ?? [];
}

/**
 * One submitted user message.
 *
 * The task id rides in `metadata.turnMetadata` rather than on the submission's
 * own `metadata`, because only the message's copy is visible during the turn
 * (`activeTurnMetadata`) and survives into a recovered one. The submission
 * metadata carries it too, for `onSubmissionStatus`, which sees that one alone.
 */
function userMessage(
  id: string,
  text: string,
  turnMetadata: { taskId: string; contextId: string }
): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { turnMetadata }
  };
}
