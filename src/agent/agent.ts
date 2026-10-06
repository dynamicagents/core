import {
  Think,
  defaultContextOverflowClassifier,
  type ThinkModel,
  type ThinkScheduledTasks,
  type ThinkSession,
  type ThinkSubmissionInspection,
  type ToolCallContext,
  type ToolCallDecision,
  type TurnConfig,
  type TurnContext,
  type Action
} from "@cloudflare/think";
import {
  getAgentByName,
  type Agent,
  type AgentToolLifecycleResult,
  type AgentToolMilestone,
  type AgentToolProgressSnapshot,
  type AgentToolRunInfo
} from "agents";
import type { ContextConfig } from "agents/context";
import {
  hasToolCall,
  tool,
  type LanguageModel,
  type Tool,
  type ToolSet,
  type UIMessage
} from "ai";
import type { TaskState } from "@a2a-js/sdk";
import {
  HITL_APPROVE_OPTION_ID,
  HITL_REQUEST_TYPE,
  type HitlRequestData
} from "@dynamicagents/g2a-protocol";
import { SelfOrigin } from "../a2a/self-origin.js";
import { fileApproval } from "../artifacts/approval.js";
import {
  assertArtifactsBound,
  requireArtifactsStub
} from "../artifacts/binding.js";
import { readEntryDetail } from "../artifacts/detail.js";
import { artifactViewerUrl } from "../artifacts/path.js";
import { transcribeNote } from "../artifacts/transcript.js";
import {
  PluginSetupError,
  assemblePlugins,
  type AssembledPlugins
} from "../contract/assemble.js";
import type { AgentPlugin, PluginContext } from "../contract/plugin.js";
import type { CoreEnv } from "../env.js";
import { isTerminalState, TASK_RETENTION_MS } from "../ledger.js";
import { reportEventType } from "../workflow/keys.js";
import type { StepAnswer, StepJob } from "../workflow/types.js";
import { compaction, SEND_REASONING } from "./history.js";
import { latestStepJobId, readTurn } from "./outcome.js";
import { StepJobs, type JobRow } from "./step-jobs.js";
import type {
  SubAgentSettleContext,
  SubAgentSpec
} from "../contract/subagent.js";
import {
  NOTE_MILESTONE,
  type NoteData,
  type SubAgentClass,
  type SubAgentEnvelope
} from "../subagent/subagent.js";
import {
  ASK_USER_TOOL_NAME,
  CHECK_BACK_DESCRIPTION,
  CHECK_BACK_TOOL_NAME,
  approvalAnswerText,
  askedUser,
  askUserToolFor,
  checkBackInputSchema,
  searchHistoryTool,
  unrecordedApprovalText,
  SEARCH_HISTORY_TOOL_NAME
} from "./tools.js";

/** What `onCheckBack` is handed by the schedule `check_back` created. */
export interface CheckBackWake {
  stepJobId: string;
  workId: string;
  seconds: number;
  why: string;
}

/** How a queued job that must land is retried. */
const DELIVERY_RETRY = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000
};

/** Who wrote a note: the sub-agent class and its per-parent ordinal. */
interface NoteSource {
  type: string;
  ordinal: number;
}

/** A note replay the queue retries. */
interface NotesJob {
  runId: string;
  source: NoteSource;
}

/** Per-agent `getConfig()` shape. */
interface A2AConfig {
  caller?: string;
}

/**
 * The per-caller step agent: a Think agent that runs the jobs a task workflow
 * starts, one Durable Object per verified `identity.key`. It speaks no A2A: the
 * task is its host's (`/task`), and a job reports to the workflow that started
 * it (`/workflow`).
 *
 * What it adds to Think is the step job, and these rules hold it:
 *
 *  - **A job can outlive the turn that started it.** Work that may run past a
 *    turn is dispatched detached or scheduled; the job stays `working` while
 *    the ledger holds open work for it, and the turn that ends with none is the
 *    one that answers.
 *  - **`onSubmissionStatus` is not a delivery channel.** It fires inside the
 *    turn slot and its errors are only logged, so it does the guarded write —
 *    which owes the report in the same write — and hands the report to a durable
 *    queue.
 *  - **Cancellation is decided by the guarded write, never by a probe.**
 *  - **A turn the runtime cuts is continued while its job is open,** under
 *    its own submission, at the cost of the step in flight.
 *  - **A turn for a job that has ended does nothing.** It is not recovered,
 *    its tools are refused, and it stops at its next step.
 *
 * A subclass supplies the model and the compaction values; core ships no
 * prompt copy. A subclass that overrides a Think hook this class implements
 * calls `super`.
 *
 * Every method a caller reaches over RPC is a native `async` method, and an
 * override keeps it one: agents starts the lifecycle — Think's session, and
 * the submission ledger under it — before such a method entered from outside
 * the agent, and never before a synchronous one.
 */
export abstract class StepAgent<
  Env extends Cloudflare.Env & CoreEnv = Cloudflare.Env & CoreEnv
> extends Think<Env> {
  /**
   * A re-attaching parent gives up on a silent awaited child after this. The
   * gatekeeper's hour is the only bound wanted: a child quiet for minutes while
   * a tool runs is normal.
   */
  static override options = { agentToolReattachNoProgressTimeoutMs: Infinity };

  /**
   * Whether a turn cut short is continued is the job ledger's to say — an open
   * job's is, and an ended one's is declined in `onChatRecovery` — not the age
   * of its fiber. Think's default errors a running submission whose fiber is
   * older than fifteen minutes, which every turn the runtime cuts at its
   * ceiling is, and then continues the turn without it: the job fails, and its
   * retry runs beside the old turn.
   */
  protected static override submissionRecoveryStaleMs = Infinity;

  override maxSteps = Infinity;
  override chatRecovery = { maxRecoveryWork: Infinity };
  override contextOverflow = { reactive: true };
  /** A turn's reasoning is not stored — see `./history.ts`. */
  override sendReasoning = SEND_REASONING;

  /**
   * The job ledger. Not `tasks`: every `Agent` already has `this.tasks`, the
   * agents SDK's durable task capability.
   */
  readonly ledger = new StepJobs(
    (strings, ...values) => this.sql(strings, ...values),
    (fn) => this.ctx.storage.transactionSync(fn)
  );

  abstract override getModel(): ThinkModel;
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

  /** Learned from the `jku` each job carries; never configured. */
  readonly #origin = new SelfOrigin();
  /** Each task's transcript writes, chained — see {@link StepAgent.#note}. */
  readonly #transcribing = new Map<string, Promise<void>>();
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
    this.plugins.check(this.pluginContext(), this.#reservedToolNames());
    await super.onStart();
    // The origin is held in memory, and a detached run's note after an
    // eviction would otherwise carry no link.
    for (const job of this.ledger.openJobs()) this.#origin.note(job.jku);
    // Every side effect a transition owes is recorded with it, so an object
    // evicted between the two finds the debt here. Queued rather than run:
    // each is retried, and none of them belongs in a start.
    for (const workId of this.ledger.pendingFollowUps()) {
      await this.queue(
        "submitFollowUp",
        { workId },
        { id: `follow-up:${workId}` }
      );
    }
    for (const stepJobId of this.ledger.pendingAnswers()) {
      await this.queue(
        "submitAnswer",
        { stepJobId },
        { id: `answer:${stepJobId}` }
      );
    }
    for (const stepJobId of this.ledger.unstopped()) {
      await this.#queueStopWork(stepJobId);
    }
    for (const { stepJobId, n } of this.ledger.unsent()) {
      await this.#queueReport(stepJobId, n);
    }
    if (this.ledger.dueTaskHooks().length > 0) {
      await this.queue("runTaskHooks", {}, { id: "task-hooks" });
    }
  }

  override classifyChatError(error: unknown) {
    return defaultContextOverflowClassifier(error);
  }

  override configureSession(session: ThinkSession): ThinkSession {
    return session
      .onCompaction(
        compaction(() => this.compactionModel(), this.keepRecentTokens)
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
    tools[ASK_USER_TOOL_NAME] = askUserToolFor((id) => this.mayAskApproval(id));
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
   * The names {@link getTools} sets over the plugins', by owner. A plugin
   * offering one would be silently replaced, and two sub-agents sharing one
   * would route to whichever came last, so the start check refuses both.
   */
  #reservedToolNames(): Map<string, string> {
    const owners = new Map<string, string>();
    const claim = (name: string, owner: string) => {
      const other = owners.get(name);
      if (other) {
        throw new PluginSetupError(
          `${other} and ${owner} both offer the tool "${name}"`
        );
      }
      owners.set(name, owner);
    };
    for (const Cls of this.getSubAgents()) {
      claim(Cls.spec.name, `sub-agent ${Cls.name}`);
    }
    claim(ASK_USER_TOOL_NAME, "core");
    claim(SEARCH_HISTORY_TOOL_NAME, "core");
    return owners;
  }

  /**
   * A turn ends on `ask_user` — it waits for a person — and on `check_back`,
   * which has scheduled its own wake. Without them the loop would run another
   * step on a turn that is finished. It ends too once its job has ended.
   *
   * A turn for a job that has ended is offered no tools. A subclass that sets
   * `activeTools` keeps that empty list; {@link beforeToolCall} refuses the
   * calls either way.
   */
  override beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {
    const stepJobId = this.turnStepJobId();
    const closed = stepJobId !== undefined && this.ledger.closed(stepJobId);
    return {
      stopWhen: [
        askedUser,
        hasToolCall(CHECK_BACK_TOOL_NAME),
        ...(stepJobId === undefined
          ? []
          : [() => this.ledger.closed(stepJobId)])
      ],
      ...(closed ? { activeTools: [] } : {}),
      ...(this.maxOutputTokens !== undefined
        ? { maxOutputTokens: this.maxOutputTokens }
        : {})
    };
  }

  /**
   * Refuse every tool call once the turn's job has ended. The guard a turn
   * already running when its job ended meets — `beforeTurn` has passed for it —
   * and the one a subclass's `activeTools` cannot undo.
   */
  override beforeToolCall(
    _ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {
    const stepJobId = this.turnStepJobId();
    if (stepJobId !== undefined && this.ledger.closed(stepJobId)) {
      return { action: "block", reason: TASK_ENDED };
    }
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
    const stepJobId = this.turnStepJobId();
    if (text && stepJobId) await this.#push(stepJobId, text, "step");
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

  /**
   * An interrupted turn is continued while its job is open, and not once the
   * job has ended — canceled, failed or completed alike. A failed job's retry
   * is already running, and the old turn would run on beside it.
   *
   * Nor is a turn that names no job: every message this class submits names
   * one, so such a turn — an `A2AAgent` turn still running when its class
   * became a `StepAgent` — has nothing to settle or report it.
   */
  protected override async onChatRecovery(ctx: {
    messages: UIMessage[];
  }): Promise<{ continue: boolean } | void> {
    const stepJobId = latestStepJobId(ctx.messages);
    if (!stepJobId || this.ledger.closed(stepJobId)) {
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

  // --- step jobs: the surface a task workflow calls ----------------------------

  /**
   * Start a job and submit its first turn. Idempotent on the job id: a re-run
   * start step finds the job and starts nothing. A job that already settled
   * sends its reports again — a restarted instance waits for them from the
   * first, and would otherwise wait for good — save one still waiting on the
   * job's stop, which goes once the stop holds. A job stopped before it started
   * left a canceled row, and starts nothing.
   */
  async startStepJob(job: StepJob): Promise<void> {
    this.#origin.note(job.jku);
    const existing = this.ledger.row(job.stepJobId);
    if (existing && isTerminalState(existing.state)) {
      if (existing.state !== "canceled") {
        for (const n of this.ledger.resendable(job.stepJobId)) {
          await this.#queueReport(job.stepJobId, n, true);
        }
      }
      return;
    }
    if (existing?.submissionId) return;
    const row = this.ledger.accept(job);
    if (this.getConfig<A2AConfig>()?.caller !== job.caller) {
      this.configure<A2AConfig>({
        ...this.getConfig<A2AConfig>(),
        caller: job.caller
      });
    }
    const id = `stepjob:${job.stepJobId}`;
    const keys = keysOf(row);
    const submission = await this.runTurn({
      mode: "submit",
      input: userMessage(id, this.formatStepJobInput(job), keys),
      idempotencyKey: id,
      metadata: metadataOf(keys)
    });
    this.ledger.bindSubmission(job.stepJobId, submission.submissionId);
  }

  /**
   * A job's first message. The workflow sends the input; what the job's `role`
   * asks of this agent, and what a retry (`job.attempt > 1`) should look at,
   * are the agent's to say, so a subclass briefs them here.
   */
  protected formatStepJobInput(job: StepJob): string {
    return job.input;
  }

  /**
   * The answer to a question the job asked, relayed by the workflow: its next
   * turn. A repeat finds the question already taken and does nothing.
   */
  async answerStepJob(stepJobId: string, answer: StepAnswer): Promise<void> {
    const request = this.ledger.row(stepJobId)?.request;
    if (!request) return;
    let text: string;
    if (request.artifact) {
      // Filed before the job resumes, so an answer the workflow delivers again
      // finds its note by the key and reads as filed, and a throw here leaves
      // the answer to be delivered again.
      text = approvalAnswerText(answer);
      const filed = await fileApproval(this.env, request.artifact.id, {
        key: request.requestId,
        text,
        approved: answer.optionId === HITL_APPROVE_OPTION_ID
      });
      if (!filed) text = unrecordedApprovalText(text);
    } else {
      const option = request.options?.find((o) => o.id === answer.optionId);
      text = [option?.label ?? answer.optionId, answer.text]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
    }
    if (
      this.ledger.resume(stepJobId, { id: `answer:${request.requestId}`, text })
    ) {
      await this.submitAnswer({ stepJobId });
    }
  }

  /**
   * Submit the answer's turn a resumed job owes, then clear it. A repeat
   * submits again under the same idempotency key, or finds it cleared.
   */
  async submitAnswer(payload: { stepJobId: string }): Promise<void> {
    const row = this.ledger.row(payload.stepJobId);
    if (!row?.answer) return;
    if (!isTerminalState(row.state)) {
      const keys = keysOf(row);
      await this.runTurn({
        mode: "submit",
        input: userMessage(row.answer.id, row.answer.text, keys),
        idempotencyKey: row.answer.id,
        metadata: metadataOf(keys)
      });
    }
    this.ledger.answered(payload.stepJobId, row.answer.id);
  }

  /**
   * Stop a job: its turn, its background runs, its wakes. It reports nothing —
   * the host that stopped it has settled the task — and it resets nothing: the
   * agent that picks the task up again decides what becomes of the work.
   */
  async cancelStepJob(stepJobId: string): Promise<void> {
    if (!this.ledger.row(stepJobId)) {
      this.ledger.tombstone(stepJobId);
      return;
    }
    await this.#cancel(stepJobId);
  }

  /**
   * The host's end-of-task notice: the task a job of this agent ran for ended.
   * A job of it still open has nobody left to report to — a pipeline that threw
   * while a parallel step still worked leaves one — so it is stopped, keeping
   * its work. The hook is owed, and runs once no job of the task has work
   * open: a stop that failed runs it when its retry holds.
   */
  async stepTaskSettled(taskId: string, state: TaskState): Promise<void> {
    for (const stepJobId of this.ledger.openJobsOf(taskId)) {
      await this.#cancel(stepJobId);
    }
    this.ledger.oweTaskHook(taskId, state);
    await this.#runDueTaskHooks();
  }

  /** Owed settle hooks whose work has stopped, run from the queue. */
  async runTaskHooks(): Promise<void> {
    await this.#runDueTaskHooks();
  }

  /** At least once: an eviction before the record reruns a hook. */
  async #runDueTaskHooks(): Promise<void> {
    for (const { taskId, state } of this.ledger.dueTaskHooks()) {
      try {
        await this.onTaskSettled(taskId, state as TaskState);
      } catch (err) {
        console.warn("[agent] task settle hook failed", {
          taskId,
          state,
          err: String(err)
        });
      }
      this.ledger.taskHookRan(taskId);
    }
  }

  /**
   * A task a job of this agent ran for reached a state it never leaves —
   * release what was held for it. Fires for every terminal state, `canceled`
   * included, at least once per agent, once none of the task's jobs has work
   * still running. A throw is logged and swallowed.
   */
  protected async onTaskSettled(
    _taskId: string,
    _state: TaskState
  ): Promise<void> {}

  /**
   * Send one report to the job's workflow. An instance no longer running takes
   * nothing more — `sendEvent` refuses it — so the report is dropped rather
   * than retried for as long as the queue would.
   */
  async deliverStepJobReport(payload: {
    stepJobId: string;
    n: number;
    resend?: boolean;
  }): Promise<void> {
    const { stepJobId, n } = payload;
    const owed = this.ledger.report(stepJobId, n);
    const job = this.ledger.job(stepJobId);
    if (!owed || !job || (owed.sent && !payload.resend)) return;
    try {
      await this.sendWorkflowEvent(job.workflow.name, job.workflow.id, {
        type: await reportEventType(stepJobId, n),
        payload: owed.report
      });
    } catch (err) {
      if (!(await this.#instanceGone(job))) throw err;
      console.warn("[agent] a report's instance has ended; dropped", {
        stepJobId,
        n
      });
    }
    this.ledger.sent(stepJobId, n);
  }

  // --- settlement ------------------------------------------------------------

  /**
   * The submission ledger's view of a turn, turned into the job lifecycle.
   * Keyed on `metadata.stepJobId`; a submission without one is not a job's
   * turn.
   */
  protected override async onSubmissionStatus(
    submission: ThinkSubmissionInspection
  ): Promise<void> {
    const stepJobId = submission.metadata?.stepJobId;
    if (typeof stepJobId !== "string") return;
    // A follow-up's turn has ended, so its work no longer holds the job open.
    const workId = submission.metadata?.workId;
    if (
      typeof workId === "string" &&
      submission.status !== "pending" &&
      submission.status !== "running"
    ) {
      this.ledger.endFollowUp(workId);
    }
    switch (submission.status) {
      case "running":
        if (this.ledger.markWorking(stepJobId) === "closed") {
          await this.cancelSubmission(submission.submissionId, TASK_ENDED);
        }
        return;
      case "completed":
        await this.#settleCompleted(stepJobId);
        return;
      case "error":
      case "skipped":
        await this.#fail(stepJobId, submission.error ?? "the turn failed");
        return;
      default:
      // `pending` needs nothing, and `aborted` is a guarded no-op: the cancel
      // that caused it already settled the row.
    }
  }

  /**
   * What a completed turn means for the job, in this order:
   *
   *  1. a question is pending → park, and the workflow relays it;
   *  2. work is still open → an interim turn: push its closing words and stay
   *     `working`;
   *  3. otherwise the turn is the job's reply.
   *
   * Without (2), a detached dispatch would settle the job the moment the
   * parent turn ended, and the child's result would land on a closed one.
   */
  async #settleCompleted(stepJobId: string): Promise<void> {
    if (this.ledger.closed(stepJobId)) return;
    // The async read: the `messages` getter is empty on a cold object, and a
    // turn recovered after an eviction is exactly when this runs on one.
    const outcome = readTurn(await this.getMessages(), stepJobId);

    if (outcome.ask) {
      const requestId = `${stepJobId}:${outcome.ask.toolCallId}`;
      const request: HitlRequestData =
        outcome.ask.artifact !== undefined
          ? this.#approval(
              requestId,
              outcome.ask.question,
              outcome.ask.artifact
            )
          : {
              type: HITL_REQUEST_TYPE,
              requestId,
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
      const n = this.ledger.park(stepJobId, request);
      if (n !== null) await this.#queueReport(stepJobId, n);
      return;
    }

    if (this.ledger.openWork(stepJobId) > 0) {
      if (outcome.reply) await this.#push(stepJobId, outcome.reply, "turn");
      return;
    }

    const n = this.ledger.settle(stepJobId, {
      state: "completed",
      reply: outcome.reply
    });
    if (n !== null) await this.#queueReport(stepJobId, n);
  }

  /**
   * An approval of an artifact: Approve, Reject, or a comment typed out. The
   * prompt carries the link too, for a gatekeeper that renders no link of its
   * own.
   *
   * The artifact was checked when the model named it — see
   * {@link mayAskApproval} — and the origin is known while a job is open:
   * `onStart` notes each open job's.
   */
  #approval(
    requestId: string,
    question: string,
    artifact: string
  ): HitlRequestData {
    const url = artifactViewerUrl(this.#origin.require(), artifact);
    return {
      type: HITL_REQUEST_TYPE,
      requestId,
      requestKind: "approval",
      prompt: `${question}\n\n${url}`,
      allowFreeform: true,
      artifact: { id: artifact, url }
    };
  }

  /**
   * Whether the model may ask the person to approve the artifact `id`. It is
   * asked when the model calls `ask_user`, and a `false` fails that call.
   *
   * By default, any artifact this deployment holds that is still open: the id is
   * the only authority an artifact has, and a model holding one was handed it.
   * Open rather than unlocked, because a settled artifact's link has stopped
   * streaming — an answer filed on it would not reach a page already showing it
   * — and a lock settles. An agent that should ask only about what it made
   * narrows this.
   */
  protected async mayAskApproval(id: string): Promise<boolean> {
    const artifact = await requireArtifactsStub(this.env).artifactState(id);
    return artifact !== null && artifact.status === null;
  }

  /**
   * A turn that errored fails its job. Its background runs and wakes are
   * stopped, keeping their work, and the report is sent once the stop held.
   */
  async #fail(stepJobId: string, error: string): Promise<void> {
    if (this.ledger.settle(stepJobId, { state: "failed", error }) === null) {
      return;
    }
    await this.#stopWork(stepJobId);
  }

  async #queueReport(
    stepJobId: string,
    n: number,
    resend = false
  ): Promise<void> {
    await this.queue(
      "deliverStepJobReport",
      { stepJobId, n, ...(resend ? { resend } : {}) },
      { id: `report:${stepJobId}:${n}`, retry: DELIVERY_RETRY }
    );
  }

  async #instanceGone(job: StepJob): Promise<boolean> {
    try {
      const binding = (this.env as Record<string, unknown>)[job.workflow.name];
      const status = await (
        await (binding as Workflow).get(job.workflow.id)
      ).status();
      return ["complete", "errored", "terminated"].includes(status.status);
    } catch {
      return false;
    }
  }

  // --- cancellation ----------------------------------------------------------

  /**
   * The guarded flip first — terminal, so every later write is refused, and
   * any unsent report dropped with it — then everything still running for the
   * job is stopped. The stop runs whether or not this call flipped it, and is
   * safe to repeat: a job that failed can still have a background run going.
   */
  async #cancel(stepJobId: string): Promise<void> {
    this.ledger.cancel(stepJobId);
    const submissionId = this.ledger.row(stepJobId)?.submissionId;
    if (submissionId) {
      await this.cancelSubmission(submissionId, TASK_ENDED).catch(
        (err: unknown) =>
          console.warn("[agent] submission not canceled", {
            stepJobId,
            err: String(err)
          })
      );
    }
    // `cancelSubmission` misses a recovered continuation, which runs under a
    // new request id, and a follow-up turn has a submission of its own.
    if (this.turnStepJobId() === stepJobId) this.abortAllRequests();
    await this.#stopWork(stepJobId);
  }

  /**
   * Stop a job's background runs and wakes, keeping what they did, then send
   * the reports that waited for it (see `StepJobs`). A row is closed only once
   * its stop held: the job has ended, so nothing else would revisit it, and
   * one that failed is retried from the queue.
   */
  async #stopWork(stepJobId: string): Promise<void> {
    if (await this.#tryStopWork(stepJobId)) {
      await this.#stopped(stepJobId);
    } else {
      await this.#queueStopWork(stepJobId);
    }
  }

  async #queueStopWork(stepJobId: string): Promise<void> {
    await this.queue(
      "finishStopWork",
      { stepJobId },
      { id: `stop-work:${stepJobId}`, retry: DELIVERY_RETRY }
    );
  }

  /** A stop of a job's work that failed, tried again. Throws, so it retries. */
  async finishStopWork(payload: { stepJobId: string }): Promise<void> {
    if (!this.ledger.closed(payload.stepJobId)) return;
    if (!(await this.#tryStopWork(payload.stepJobId))) {
      throw new Error(
        `the work of job ${payload.stepJobId} is not stopped yet`
      );
    }
    await this.#stopped(payload.stepJobId);
  }

  /** What waited for a job's work to stop: its reports, its task's hook. */
  async #stopped(stepJobId: string): Promise<void> {
    for (const n of this.ledger.unsentOf(stepJobId)) {
      await this.#queueReport(stepJobId, n);
    }
    await this.#runDueTaskHooks();
  }

  async #tryStopWork(stepJobId: string): Promise<boolean> {
    let stopped = true;
    for (const work of this.ledger.openWorkRows(stepJobId)) {
      try {
        if (work.kind === "detached") {
          await this.cancelAgentTool(work.workId, TASK_ENDED);
        } else if (work.kind === "wait" && work.scheduleId) {
          await this.cancelSchedule(work.scheduleId);
        }
        this.ledger.closeWork(work.workId);
      } catch (err) {
        stopped = false;
        console.warn("[agent] work not stopped", {
          stepJobId,
          workId: work.workId,
          err: String(err)
        });
      }
    }
    return stopped;
  }

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
        // The work is the job's; the run belongs to the A2A task.
        const stepJobId = this.#requireTurnStepJobId();
        const taskId = this.requireTurnTaskId();
        const runId = `${spec.detached ? "detached" : "agent-tool"}:${toolCallId}`;
        const runtime = await spec.prepare?.({
          input,
          taskId,
          runId,
          parent: this.pluginContext()
        });
        // A cancel landing while `prepare` ran found no work to stop. Checked
        // and recorded with no await between, so none lands in the gap.
        if (this.ledger.closed(stepJobId)) {
          await this.#release(spec, {
            runId,
            taskId,
            runtime,
            result: { status: "aborted", error: TASK_ENDED }
          });
          return failure("aborted", TASK_ENDED);
        }
        this.ledger.addWork({
          workId: runId,
          stepJobId,
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
            // close this row, and the job would stay `working` for ever.
            const error = dispatch.error ?? "the background run did not start";
            await this.#settleRefused(spec, runId, taskId, runtime, error);
            return failure("error", error);
          }
          // One landing during the dispatch found the run not yet registered,
          // and `cancelAgentTool` ignores a run it does not know.
          if (this.ledger.closed(stepJobId)) await this.cancelAgentTool(runId);
          return { started: runId };
        }

        const result = await this.runAgentTool(Cls, {
          input: envelope,
          runId,
          parentToolCallId: toolCallId,
          signal: abortSignal
        });
        if (result.status === "error") {
          await this.#settleRefused(
            spec,
            runId,
            taskId,
            runtime,
            result.error ?? "the run failed"
          );
        }
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
    await this.#replayNotes(run);
    if (work.kind === "awaited") this.ledger.closeWork(run.runId);
    if (!this.ledger.claimSettle(run.runId)) return;
    await this.#release(
      this.#subAgent(work.name)?.spec as SubAgentSpec<unknown, Env> | undefined,
      {
        runId: run.runId,
        taskId: this.ledger.row(work.stepJobId)?.taskId ?? work.stepJobId,
        runtime: work.runtime,
        result
      }
    );
  }

  /**
   * A run refused before it started — over `maxConcurrentAgentTools`, say —
   * gets no `onAgentToolFinish`, so its work is closed and what `prepare`
   * acquired is settled here. Claimed, so a run that did start and failed is
   * settled once, whichever side gets there first.
   */
  async #settleRefused(
    spec: SubAgentSpec<unknown, Env>,
    runId: string,
    taskId: string,
    runtime: Record<string, unknown> | undefined,
    error: string
  ): Promise<void> {
    this.ledger.closeWork(runId);
    if (!this.ledger.claimSettle(runId)) return;
    await this.#release(spec, {
      runId,
      taskId,
      runtime,
      result: { status: "error", error }
    });
  }

  /** A spec's `settle`, best-effort: a release that fails is logged. */
  async #release(
    spec: SubAgentSpec<unknown, Env> | undefined,
    context: Omit<SubAgentSettleContext<Env>, "parent">
  ): Promise<void> {
    try {
      await spec?.settle?.({ ...context, parent: this.pluginContext() });
    } catch (err) {
      console.warn("[agent] sub-agent settle failed", {
        runId: context.runId,
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
    if (result.status === "interrupted" && result.childStillRunning) return;
    const work = this.ledger.work(run.runId);
    if (!work || this.ledger.closed(work.stepJobId)) return;
    this.ledger.beginFollowUp(run.runId, {
      id: `finish:${run.runId}`,
      text: this.formatDetachedCompletion(run, result)
    });
    await this.submitFollowUp({ workId: run.runId });
  }

  /**
   * Submit the follow-up a closed work row owes. It stays owed until its turn
   * ends (see {@link onSubmissionStatus}), so a repeat — a redelivered finish,
   * the start-up sweep — submits again under the same idempotency key, which
   * is a no-op. A job that closed meanwhile owes it nothing.
   */
  async submitFollowUp(payload: { workId: string }): Promise<void> {
    const work = this.ledger.work(payload.workId);
    const followUp = this.ledger.followUp(payload.workId);
    if (!work || !followUp) return;
    const row = this.ledger.row(work.stepJobId);
    if (!row || isTerminalState(row.state)) {
      this.ledger.endFollowUp(payload.workId);
      return;
    }
    const keys = keysOf(row);
    await this.runTurn({
      mode: "submit",
      input: userMessage(followUp.id, followUp.text, keys),
      idempotencyKey: followUp.id,
      metadata: { ...metadataOf(keys), workId: payload.workId }
    });
  }

  /**
   * `check_back`: put the job down and pick it up later, as a scheduled wake
   * rather than a wait inside the turn, which the runtime cuts at fifteen
   * minutes. Opt-in: `check_back: this.checkBackTool()` in `getTools()`.
   */
  protected checkBackTool(): Tool {
    return tool({
      description: CHECK_BACK_DESCRIPTION,
      inputSchema: checkBackInputSchema,
      execute: async ({ seconds, why }, { toolCallId }) => {
        const stepJobId = this.#requireTurnStepJobId();
        const workId = `wait:${toolCallId}`;
        // The wait first, so the job cannot settle before its wake.
        this.ledger.addWork({
          workId,
          stepJobId,
          kind: "wait",
          name: CHECK_BACK_TOOL_NAME
        });
        const schedule = await this.schedule<CheckBackWake>(
          seconds,
          "onCheckBack",
          { stepJobId, workId, seconds, why }
        );
        // A cancel while `schedule` ran closed the wait with no schedule to
        // cancel: this wake is an orphan, so cancel it here.
        if (!this.ledger.setWorkSchedule(workId, schedule.id)) {
          await this.cancelSchedule(schedule.id);
        }
        return { waiting: seconds };
      }
    });
  }

  /** The wake `check_back` scheduled: the same follow-up as a finished run. */
  async onCheckBack(wake: CheckBackWake): Promise<void> {
    if (this.ledger.closed(wake.stepJobId)) return;
    this.ledger.beginFollowUp(wake.workId, {
      id: `wake:${wake.workId}`,
      text: `Waited ${wake.seconds}s: ${wake.why}`
    });
    await this.submitFollowUp({ workId: wake.workId });
  }

  // --- the transcript --------------------------------------------------------

  /**
   * A child's live note. Best-effort and not replayed after an eviction, which
   * is why the finish hook replays the persisted copy. The job comes from the
   * work row: a detached run reports while no turn of this agent is running.
   */
  override async onProgress(
    run: AgentToolRunInfo,
    progress: AgentToolProgressSnapshot
  ): Promise<void> {
    if (progress.milestone !== NOTE_MILESTONE) return;
    const note = readNote(progress.data);
    const stepJobId = this.ledger.work(run.runId)?.stepJobId;
    if (note && stepJobId) await this.#note(stepJobId, sourceOf(run), note);
  }

  /**
   * The finish hook's replay, inline so the notes land before the job can
   * settle. The transcript relies on it as the retry of a live note, so one
   * that fails is not dropped: it goes to the queue, which retries it.
   */
  async #replayNotes(run: AgentToolRunInfo): Promise<void> {
    const job: NotesJob = { runId: run.runId, source: sourceOf(run) };
    try {
      await this.replayNotes(job);
    } catch (err) {
      console.warn("[agent] notes not replayed; retrying from the queue", {
        runId: run.runId,
        err: String(err)
      });
      await this.queue("replayNotes", job, {
        id: `notes:${run.runId}`,
        retry: DELIVERY_RETRY
      });
    }
  }

  /**
   * Every note a run's child persisted, filed again. Safe to repeat: the
   * transcript dedupes on the note's key. Throws, so the queue retries.
   */
  async replayNotes(job: NotesJob): Promise<void> {
    const work = this.ledger.work(job.runId);
    const Cls = work && this.#subAgent(work.name);
    if (!work || !Cls) return;
    const child = await this.dynamicAgents.get(Cls, job.runId);
    const inspection = (await child.inspectAgentToolRun(job.runId)) as {
      milestones?: AgentToolMilestone[];
    } | null;
    for (const milestone of inspection?.milestones ?? []) {
      if (milestone.name !== NOTE_MILESTONE) continue;
      const note = readNote(milestone.data);
      if (note) await this.#note(work.stepJobId, job.source, note);
    }
  }

  /**
   * A job's notes go on its task's transcript, and their lines to the host —
   * one at a time per task, in the order they arrived.
   *
   * The SDK calls `onProgress` without awaiting the call before it, so a child
   * that files two notes back to back — its narration and its first tool call
   * — has them interleave at every await here. Both then read the link as
   * unannounced and the thread gets it twice, and a tool's result can land on
   * the transcript before its call. The chain is in memory because that is
   * where the interleaving is: an object that loses it loses the calls with
   * it, and the finish replay files whatever they had not.
   */
  async #note(
    stepJobId: string,
    source: NoteSource,
    note: NoteData
  ): Promise<void> {
    const job = this.ledger.job(stepJobId);
    if (!job) return;
    const { taskId } = job;
    const write = (this.#transcribing.get(taskId) ?? Promise.resolve()).then(
      () =>
        transcribeNote(
          this.env,
          {
            taskId,
            origin: this.#origin.peek(),
            source,
            text: note.text,
            key: note.key,
            ...(note.detail ? { detail: note.detail } : {})
          },
          (line) => this.#hostProgress(job, line, note.key)
        )
    );
    // The next note waits for this one, not on its outcome: a failure is this
    // note's, and is thrown to whoever filed it.
    const settled = write.then(
      () => {},
      () => {}
    );
    this.#transcribing.set(taskId, settled);
    try {
      await write;
    } finally {
      if (this.#transcribing.get(taskId) === settled)
        this.#transcribing.delete(taskId);
    }
  }

  // --- identity and helpers --------------------------------------------------

  /**
   * The verified caller this object serves. The object is addressed by it, so
   * its name is the key — durable, and correct by construction.
   */
  callerKey(): string {
    return this.name;
  }

  /** This deployment's own origin, once a job has carried it here. */
  protected selfOrigin(): string | undefined {
    return this.#origin.peek();
  }

  /** The same, for a caller that cannot go on without it. */
  protected requireSelfOrigin(): string {
    return this.#origin.require();
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

  /**
   * The A2A task the running turn's job belongs to, from the message that
   * started the turn: what gateway attribution, the transcript and a
   * sub-agent's `prepare` and `settle` name.
   */
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
          "turn submitted for a step job"
      );
    }
    return taskId;
  }

  /** The step job the running turn belongs to: the ledger row it settles. */
  protected turnStepJobId(): string | undefined {
    const id = (this.activeTurnMetadata as { stepJobId?: unknown } | undefined)
      ?.stepJobId;
    return typeof id === "string" ? id : undefined;
  }

  /** The same job, whole — its `role` above all. */
  protected turnStepJob(): StepJob | undefined {
    const id = this.turnStepJobId();
    return id ? (this.ledger.job(id) ?? undefined) : undefined;
  }

  #requireTurnStepJobId(): string {
    const id = this.turnStepJobId();
    if (!id) {
      throw new Error(
        "this turn carries no step job id: a tool that records work runs " +
          "inside a turn submitted for a step job"
      );
    }
    return id;
  }

  #subAgent(name: string): SubAgentClass | undefined {
    return this.getSubAgents().find((Cls) => Cls.name === name);
  }

  /**
   * Best-effort progress, through the host, which owns the task's push
   * channel. Keyed by the job, so two jobs of one task never share a key.
   */
  async #push(stepJobId: string, text: string, prefix: string): Promise<void> {
    const job = this.ledger.job(stepJobId);
    if (!job) return;
    const key = `${stepJobId}:${this.ledger.nextPushKey(stepJobId, prefix)}`;
    await this.#hostProgress(job, text, key);
  }

  /** A post that does not arrive never fails a turn. */
  async #hostProgress(
    job: StepJob,
    text: string,
    key: string
  ): Promise<boolean> {
    try {
      const ns = (this.env as Record<string, unknown>)[job.host.binding];
      const host = (await getAgentByName(
        ns as DurableObjectNamespace<Agent>,
        job.host.name
      )) as unknown as {
        progress(taskId: string, text: string, key: string): Promise<void>;
      };
      await host.progress(job.taskId, text, key);
      return true;
    } catch (err) {
      console.warn("[agent] progress did not reach the host", {
        stepJobId: job.stepJobId,
        err: String(err)
      });
      return false;
    }
  }
}

/**
 * What a turn is for. `taskId` is the A2A task — gateway attribution and the
 * transcript name it — and `stepJobId` is the ledger row the turn settles.
 */
interface TurnKeys {
  taskId: string;
  stepJobId: string;
  contextId: string;
}

function keysOf(row: JobRow): TurnKeys {
  return {
    taskId: row.taskId,
    stepJobId: row.stepJobId,
    contextId: row.contextId
  };
}

/**
 * One submitted user message, with the job riding in `turnMetadata`: only the
 * message's copy is visible during the turn (`activeTurnMetadata`) and
 * survives into a recovered one. The submission carries it too, for
 * `onSubmissionStatus`, which sees that copy alone.
 */
function userMessage(id: string, text: string, keys: TurnKeys): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { turnMetadata: keys }
  };
}

/** The submission's copy of the keys, which `onSubmissionStatus` reads. */
function metadataOf(keys: TurnKeys): Record<string, string> {
  return { taskId: keys.taskId, stepJobId: keys.stepJobId };
}

/**
 * What a turn of a job that has ended is told: a sub-agent's refusal, a tool
 * call refused, a canceled submission's reason.
 */
const TASK_ENDED = "the task has ended";

function failure(
  status: "error" | "aborted" | "interrupted",
  error: string,
  retryable = false
) {
  return { ok: false as const, status, error, retryable };
}

function sourceOf(run: AgentToolRunInfo): NoteSource {
  return { type: run.agentType, ordinal: run.displayOrder };
}

/** A milestone's note, or `null`. A malformed card is dropped, not the note. */
function readNote(data: unknown): NoteData | null {
  const note = data as Partial<NoteData> | undefined;
  if (
    typeof note?.key !== "string" ||
    typeof note.text !== "string" ||
    !note.text
  )
    return null;
  const detail = readEntryDetail(note.detail);
  return { key: note.key, text: note.text, ...(detail ? { detail } : {}) };
}
