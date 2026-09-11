import type {
  AssistantContent,
  LanguageModel,
  ModelMessage,
  ToolSet
} from "ai";
import {
  generateText,
  hasToolCall,
  isStepCount,
  ToolChoiceViolationError
} from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { MAX_TOOL_CALL_MS, TOOL_CALL_GRACE_MS } from "../platform.js";
import type { AgentLimits } from "../config.js";
import type { SubtaskTypeRegistry } from "../subtasks/subtask-types.js";
import { appendOnce, type SessionLike } from "../agent/session.js";
import {
  deterministicSessionMessage,
  finalReplyMessageId,
  parseRoundAckMessageId,
  roundAckMessageId,
  sessionText,
  taskUserMessageId
} from "../agent/history.js";
import {
  buildIntermediateContentHandler,
  isTransientAiError,
  nonRecoverableKind,
  type OnContent,
  type RoundFailureKind
} from "../agent/inference.js";
import {
  controlTools,
  controlToolSet,
  type ControlTool,
  type TurnDecision
} from "../agent/control.js";
import { FINAL_REPLY_TOOL_NAME } from "../agent/final-reply.js";
import { stepAllowance, type TurnBudget } from "../agent/budget.js";
import { withFallback } from "../agent/fallback.js";
import type { ModelPair } from "../agent/model.js";
import {
  DELEGATE_TOOL_NAME,
  delegateCallInput,
  delegateCallOutput,
  delegateToolCallId
} from "../subtasks/delegate.js";
import {
  isCatalogEligible,
  type ReferenceCatalogEntry
} from "../subtasks/catalog.js";
import type { CompositionBranch, SubtaskDraft } from "../subtasks/types.js";
import type { FinalRoundReason, RoundPolicy } from "./policy.js";
import {
  captureObservations,
  renderObservations,
  type RoundObservations
} from "./observations.js";

/**
 * One **round** of the main agent: a single inference over the agent's continuous
 * Session that ends in one of two decisions — answer the user, or delegate.
 *
 * This is the whole task pipeline's control point. The Workflow runs rounds in a
 * loop: a round that delegates gets its Subtasks executed and is followed by
 * another round; a round that answers ends the Task. So "compose" is not a
 * separate phase with its own rules — it is simply the round in which the model
 * decides it has enough to answer.
 *
 * Two layers of tools, and the difference is the design:
 *
 * - **Work tools** (whatever the installed plugins offer the main agent, plus the
 *   Session's own `set_context`) carry an `execute` and run *inside* the round's
 *   tool loop. They never end a round; the model keeps reasoning over their
 *   results. Every round gets them except the one the budget forced — looking
 *   something up before answering is ordinary work, not a special phase, right up
 *   until there is nothing left to spend on it (see {@link RoundMode}).
 * - **Control tools** — `delegate` and `final_reply` — have no `execute`. The call
 *   *is* the round's output: the loop halts on it, and for `delegate` the Workflow
 *   performs it durably. Because the loop halts, the SDK never validates their
 *   input either, so each one checks its own and the round repairs what it rejects
 *   — see `agent/control.ts`. A future `escalate` (ask the human) is the same
 *   shape: another entry there, another variant of {@link TurnDecision}, another
 *   `case` in the Workflow's switch.
 *
 * Nothing forces the *choice*, and that is deliberate. An earlier design pinned
 * `toolChoice` to a specific tool to force delegation in one phase and forbid it in
 * another, which meant a request the main agent was best placed to answer got
 * shipped to a memoryless subagent, and material that came back could only ever be
 * turned into prose. That is still rejected: the model picks its own ending, and
 * delegating twice is allowed.
 *
 * What *is* forced is that the round end in a control call at all —
 * `toolChoice: "required"`, with both endings declared as tools. Prose is not an
 * outcome: see {@link file://../agent/final-reply.ts final-reply.ts} for why not.
 *
 * Narration survived that fix by moving house. A round whose results have just come
 * back can still announce its next step *inside* a `final_reply` — "now sending the
 * second one" — and that ends the Task as surely as prose did, having done nothing,
 * while telling the user the opposite. No mechanism can catch it: `final_reply` is a
 * legitimate ending for exactly this round, and only the model knows whether the
 * request is finished. So it is the **round contract** that has to close it — which
 * is why that text is a {@link RoundPolicy} the agent writes, not something core
 * ships.
 *
 * The model reasons over the whole conversation but references it by **catalog
 * index only** — see {@link renderTurnMessages}.
 */

/**
 * The prompt copy for one configured agent, built once per Durable Object
 * instance.
 *
 * A builder rather than a module-level `const`, because the type enum is a
 * function of the plugins this agent installed, which is a function of `env`,
 * which does not exist at module scope on Workers. The DO memoizes the result.
 */
export interface TurnInstructions {
  /** Contract + per-type delegation guidance. Appended to soul + caller context. */
  open: string;
  /**
   * The same, plus the note for a round that was forced to answer — one per
   * {@link FinalRoundReason}, because a round stopped by a wall and a round
   * stopped by a ceiling are told different things.
   *
   * A `Record` rather than a lookup, so a reason added to the union fails the
   * build here, where the words are, instead of silently falling back to the
   * wrong ones at runtime.
   */
  final: Record<FinalRoundReason, string>;
}

/**
 * Build both prompt suffixes for one configured agent.
 *
 * The agent's contract, then whatever the delegable types have to say about being
 * delegated — each declared by the type that owns it (`SubtaskTypeSpec`) and
 * collected by the runtime's registry, so no domain is named by the policy. That
 * is the rule the two prompt fields on a subtask type exist to hold: everything
 * the main agent is told about a domain is declared by the plugin that owns it,
 * never written inside the loop.
 */
export function buildTurnInstructions(
  policy: RoundPolicy,
  types: SubtaskTypeRegistry,
  maxSubtasks: number,
  limits: AgentLimits
): TurnInstructions {
  const guidance = types.renderDelegationGuidance({
    delegateTool: DELEGATE_TOOL_NAME,
    finalReplyTool: FINAL_REPLY_TOOL_NAME
  });
  const open =
    policy.roundContract({ typeKeys: types.keys, maxSubtasks }) +
    (guidance ? `\n\n${guidance}` : "");
  return {
    open,
    final: {
      budget: open + policy.finalRoundNote(limits, "budget"),
      "no-progress": open + policy.finalRoundNote(limits, "no-progress")
    }
  };
}

/** Join one branch's parts into its text block. */
function branchText(branch: CompositionBranch): string {
  return (branch.resultParts ?? []).map((p) => p.text).join("\n");
}

/** Group every branch by the round that delegated it, preserving ordinal order. */
function byRound(
  branches: CompositionBranch[]
): Map<number, CompositionBranch[]> {
  const rounds = new Map<number, CompositionBranch[]>();
  for (const branch of branches) {
    const existing = rounds.get(branch.round);
    if (existing) existing.push(branch);
    else rounds.set(branch.round, [branch]);
  }
  return rounds;
}

/**
 * Rebuild one round's `delegate` call and pair it with its result.
 *
 * Both halves are real. That round's model genuinely emitted this call; the
 * subagents genuinely produced these outcomes. All that separates them is a
 * Workflow boundary and, often, hours — so the pair is reconstructed here rather
 * than carried, from the durable rows that are the record of what happened.
 *
 * Failed and skipped branches are included so the model can disclose them rather
 * than quietly answering as if the work had been done — and, since a failed
 * branch carries its reason in `output`, so it can tell a wall it should stop
 * at from a hiccup worth retrying (see `delegateCallOutput`).
 */
function delegationPair(
  taskId: string,
  round: number,
  replyText: string | null,
  branches: CompositionBranch[]
): ModelMessage[] {
  const toolCallId = delegateToolCallId(taskId, round);
  const content: AssistantContent = [];
  // The acknowledgment the user already saw, if it is still in history.
  if (replyText) content.push({ type: "text", text: replyText });
  content.push({
    type: "tool-call",
    toolCallId,
    toolName: DELEGATE_TOOL_NAME,
    input: delegateCallInput(replyText ?? "", branches)
  });
  return [
    { role: "assistant", content },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: DELEGATE_TOOL_NAME,
          output: { type: "json", value: delegateCallOutput(branches) }
        }
      ]
    }
  ];
}

/**
 * Render the model's view for one round: the conversation, with every earlier
 * round's delegation restored as the call-and-result it actually was, and every
 * referenceable turn marked with the catalog index the model selects it by.
 *
 * One pass, two jobs, because they have to agree. The `[ref N]` markers use
 * `isCatalogEligible` — the same predicate the catalog is numbered with — so a
 * marker and its entry can never drift: compaction summaries (`assistant` role,
 * generated) stay in the messages unmarked, readable for context but structurally
 * uncitable as conversation evidence, which is exactly the intent.
 *
 * A round's acknowledgment is stored as plain assistant text (history is
 * text-only, and stays that way — `sessionText`, the catalog, compaction, and
 * recall all read text parts). So its `delegate` call is re-attached to that
 * message here, and the result appended after it, for this one inference call. The
 * pair is emitted together, anchored on the ack's deterministic id, so a `tool`
 * message can never be orphaned from its call — and an ack that has been compacted
 * away still gets its pair, appended at the end minus the acknowledgment text: a
 * result the model cannot place beats a malformed history.
 *
 * Acks are deliberately **not** catalog-eligible: they are the agent's own
 * scaffolding, and a subtask referencing "I'm on it" as verbatim conversation
 * evidence would be noise. That holds for every ack in the Session, not only the
 * ones this render can pair with branches — see `parseRoundAckMessageId`.
 *
 * A round's **observations** are restored the same way and for the same reason,
 * immediately before its delegation pair — which is where they happened. The
 * order a round reads back is therefore the order it ran in: the tools it used,
 * then the acknowledgment it gave, then what its branches came back with. Without
 * them a round inherits only its predecessors' claims, which is how thirteen
 * rounds each re-discovered that an SSH clone URL is refused.
 *
 * Everything here is ephemeral — scaffolding for this call only. Reference text is
 * snapshotted from the catalog, so no `[ref N]` prefix ever reaches a Subtask, and
 * the Session never sees any of this markup.
 */
export function renderTurnMessages(
  history: SessionMessage[],
  taskId: string,
  branches: CompositionBranch[],
  /**
   * Each carried round's exchanges, keyed by round — already elided against one
   * another by {@link renderObservations}. A round with no entry renders exactly
   * as it did before observations existed.
   */
  observations: Map<number, ModelMessage[]> = new Map()
): { messages: ModelMessage[]; catalog: ReferenceCatalogEntry[] } {
  const rounds = byRound(branches);
  // Anchored on either half. A round is normally in both — it delegated, so it
  // has branches, and it worked, so it has observations — but the two are written
  // in separate steps and aged out on separate clocks, and evidence that lost its
  // delegation is still evidence. Dropping it silently is the failure class this
  // is here to end, not one to reproduce in the renderer.
  const carried = new Set([...rounds.keys(), ...observations.keys()]);
  const ackIds = new Map(
    [...carried].map((round) => [roundAckMessageId(taskId, round), round])
  );

  const catalog: ReferenceCatalogEntry[] = [];
  const messages: ModelMessage[] = [];
  const anchored = new Set<number>();

  for (const message of history) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const role = message.role;
    const text = sessionText(message);

    const round = ackIds.get(message.id);
    if (round !== undefined) {
      anchored.add(round);
      // Before the pair, never after: these calls are what the acknowledgment
      // was written from.
      messages.push(...(observations.get(round) ?? []));
      const roundBranches = rounds.get(round);
      if (roundBranches) {
        messages.push(...delegationPair(taskId, round, text, roundBranches));
        continue;
      }
      // Observations but no rows: the crash window described below, reached from
      // the other side. The evidence stands and the acknowledgment does not —
      // this render belongs to the retry that will decide the round again, and it
      // should see what the first attempt saw without being told it already
      // answered.
      continue;
    }

    // An acknowledgment with no branches behind it — recognized by id, since
    // nothing in the message body distinguishes an ack from ordinary assistant
    // prose. This Task's own is the crash-window leftover: the ack landed, the
    // rows did not, and this render belongs to the retry that will decide the
    // round again. Dropping it is what makes that retry a clean re-decision —
    // left in, it reads as "already delegated" and invites the model to answer
    // instead of delegating, ending the Task with no work done. Another Task's
    // ack is real history the user saw, so it stays as context, but uncitable:
    // no round of *this* Task can hold it up as conversation evidence.
    const ack = parseRoundAckMessageId(message.id);
    if (ack) {
      if (ack.taskId !== taskId) messages.push({ role, content: text });
      continue;
    }

    if (!isCatalogEligible(message)) {
      // Not referenceable (a compaction summary): still context for reasoning.
      messages.push({ role, content: text });
      continue;
    }
    const index = catalog.length + 1;
    catalog.push({ index, role, text });
    messages.push({ role, content: `[ref ${index}] ${text}` });
  }

  // Rounds whose acknowledgment is no longer in history (compacted away by a
  // concurrent task), in round order so the results still read chronologically.
  const orphaned = [...carried]
    .filter((round) => !anchored.has(round))
    .sort((a, b) => a - b);
  for (const round of orphaned) {
    messages.push(...(observations.get(round) ?? []));
    const roundBranches = rounds.get(round);
    if (roundBranches)
      messages.push(...delegationPair(taskId, round, null, roundBranches));
  }

  return { messages, catalog };
}

/**
 * Deterministic fallback reply: the successful branches' text in ordinal order,
 * plus the policy's short note when some branches did not succeed.
 *
 * Used when a round's inference is unavailable but its predecessors' work is
 * durable. Failing the whole Task because the answering model is down would throw
 * away good results the user asked for.
 */
export function joinSuccessfulBranches(
  branches: CompositionBranch[],
  partialNote: string
): string {
  const successes = branches.filter((b) => b.status === "completed");
  const body = successes.map(branchText).join("\n\n");
  const incomplete = branches.length > successes.length;
  return incomplete ? `${body}\n\n${partialNote}` : body;
}

/**
 * How much rope this round gets, decided by the Workflow.
 *
 * - `open` — the normal round: `delegate`, `final_reply`, and every work tool.
 *   It may spend whatever is left of the turn budget.
 * - `final` — the round has to answer. **No work tools and no `delegate`**: the
 *   only thing on the table is the answer. This is not a punishment but the shape
 *   of a ceiling — one that ends in a forced answer returns the work, where one
 *   that simply stopped would discard it. Costs one turn, or two if the primary
 *   model fails and the fallback has to produce the answer instead; a fallback
 *   with no step to spend could not answer at all.
 *
 * The Workflow forces the second for more than one reason — a spent budget, and a
 * run of rounds that got nowhere — and the round is told which, because they read
 * to the user completely differently. See {@link FinalRoundReason}.
 */
export type RoundMode = "open" | "final";

export interface RunTurnArgs {
  /** The DO's one continuous Session. */
  session: SessionLike;
  /** Parent Task id — derives the deterministic Session message ids. */
  taskId: string;
  /** 0-based round within this Task. */
  round: number;
  /** The inbound user text (keeps its `<turn>` provenance wrapper verbatim). Appended on round 0 only. */
  text: string;
  /** What this round may do — see {@link RoundMode}. */
  mode: RoundMode;
  /**
   * Why a `final` round is final, which decides only which note it is given.
   * Absent means `budget` — the reason core had until a no-progress guard existed,
   * and the only one a caller who names none can mean. Ignored on an `open` round,
   * which has no note.
   */
  finalReason?: FinalRoundReason;
  /**
   * The Task's unspent turns, and the tally this round writes back into them.
   * Mutated in place as the model works, so the primary and the fallback draw on
   * one allowance rather than one each — see `TurnBudget`.
   *
   * There is no per-round allowance beyond what the Task has left: an early round
   * that dithers spends what a later one would have had, and is then handed a
   * `final` round to answer in. The caller reads `spent` when the round returns.
   */
  budget: TurnBudget;
  /** Per-request system-prompt suffix (verified caller context). */
  systemSuffix: string;
  /** The main agent's gated **work** tools, merged over the session's own tools. */
  tools: ToolSet;
  /** Primary + fallback model pair. */
  models: ModelPair;
  /** Every earlier round's branches, all rounds, in stable ordinal order. */
  branches: CompositionBranch[];
  /**
   * What earlier rounds saw — their work-tool exchanges, already narrowed to the
   * rounds this one should still be able to read (`roundObservationWindow`) by
   * whoever loaded them.
   *
   * Optional, and absent means the round is rendered exactly as it was before
   * any of this existed: an agent that carries nothing loses nothing but the
   * evidence.
   */
  observations?: RoundObservations[];
  /**
   * `CoreConfig.toolOutputWindow` — how many recent turns of the carried
   * exchanges keep their tool *results* in full. Defaults to keeping them all,
   * which is what a caller who passes no `observations` gets either way.
   */
  toolOutputWindow?: number;
  /** The installed subtask types — what `delegate` may name. */
  types: SubtaskTypeRegistry;
  /** `CoreConfig.maxSubtasks`, the per-round fan-out bound. */
  maxSubtasks: number;
  /** `CoreConfig.model.maxOutputTokens`. */
  maxOutputTokens: number;
  /** The prompt suffixes, memoized by the DO. See {@link buildTurnInstructions}. */
  instructions: TurnInstructions;
  /** The note a deterministic join appends when it has to disclose gaps. */
  partialNote: string;
  /** Streams intermediate content while the model reasons. Best-effort. */
  onContent?: OnContent;
  /**
   * Cancellation for the round's own inference, so a cancel lands on the model
   * call in flight rather than after it — the widest window a round has.
   *
   * The SDK hands this to every work tool's `execute` as well, merged with the
   * per-tool deadline, so a tool that reads its `abortSignal` stops on both. One
   * that ignores it keeps running either way: {@link MAX_TOOL_CALL_MS} bounds
   * what the loop *waits* for, not what the tool does.
   *
   * Optional, and absent means the round cannot be interrupted, which is what a
   * caller with nothing to interrupt it from already had.
   */
  abortSignal?: AbortSignal;
}

/**
 * Terminal outcome of one round. `failed` means the round produced no answer and
 * there was no durable work to fall back on — the parent Task fails rather than
 * running a synthesized subtask nobody asked for. Transient faults throw instead
 * (the Workflow step retries).
 *
 * `kind` is *why*, not a second outcome. The round is over either way and the
 * Task it delivers has the same shape; what the kind decides is what a human is
 * told — `exhausted` is "the models could not do it", a credential kind is "a
 * human must fix the deployment". Both were once separate statuses, and every
 * consumer promptly bundled them back together to do the same three things. See
 * {@link RoundFailureKind}.
 *
 * What the round cost is not here: it is in the caller's `TurnBudget`, which every
 * exit has already charged — including the ones that failed. A round that burned
 * the primary and recovered on the fallback spent both, and there is no variant
 * that could quietly forgive the expensive half of a bad round.
 */
export type RunTurnOutcome =
  | { status: "replied"; reply: string }
  | {
      status: "delegated";
      reply: string;
      drafts: SubtaskDraft[];
      /**
       * The work-tool exchanges this round ended on, for the caller to persist
       * beside the Subtask rows. Only a delegating round produces them: a round
       * that replied has ended the Task, and there is no later round to carry
       * anything to.
       */
      observations: ModelMessage[];
    }
  | { status: "failed"; kind: RoundFailureKind; error: string }
  /**
   * The round was cancelled while a model call was in flight. Separate from
   * `failed` because the models did nothing wrong and a human is owed no
   * explanation about them — the caller asked for this to stop.
   *
   * The budget is still charged, as every other exit charges it: the model ran,
   * whatever became of its output.
   */
  | { status: "canceled" };

/**
 * A control call the round refused, kept so it can be handed back to the model
 * verbatim. `input` is whatever the model actually sent — unvalidated by
 * definition, since failing validation is why it is here.
 */
interface RejectedCall {
  toolName: string;
  input: unknown;
}

/**
 * What one attempt produced.
 *
 * The two failure shapes are the whole point of the split. `rejected` present means
 * the model reached an ending and got its *shape* wrong — repairable, and by the
 * same model, which now has something specific to fix. `rejected` absent means the
 * attempt produced no ending at all, which no amount of feedback can address and
 * which is what the fallback slot exists for.
 */
type Attempt =
  | { ok: true; decision: TurnDecision }
  /**
   * Cancelled mid-call. Distinct from a failure because it is not evidence about
   * the model: repairing it asks a cancelled round to try again, and falling
   * through spends the second slot on work nobody is waiting for any more.
   */
  | { ok: false; aborted: true }
  | {
      ok: false;
      aborted?: false;
      error: unknown;
      rejected?: RejectedCall;
      /**
       * The **call** failed, rather than coming back with something the round
       * could not use.
       *
       * The model a slot is handed carries its own fallback (see
       * {@link file://../agent/fallback.ts withFallback}), so a call that threw
       * has already been offered to both models and the second slot has nothing
       * left to add. A call that came back without an ending has been seen by
       * one model only, and that is what the slot below is for.
       */
      thrown?: boolean;
    };

/**
 * One attempt against a single model: let it work, and take whichever ending it
 * lands on.
 *
 * Takes the model **factory**, not a model: resolving it can throw (a missing
 * binding, a bad id), and that has to count as this attempt failing so the other
 * model still gets its turn.
 *
 * The model uses its work tools freely — answering well can genuinely need a
 * lookup or a recall — and the loop ends by calling a control tool. None has an
 * `execute`, so there is nothing to continue from and the loop halts on the call.
 * Two endings in one step are resolved by `ControlTool.precedence`.
 *
 * Every control call is then parsed by the tool that owns it, because nothing else
 * has: an execute-less tool's input never passes through the SDK's validation. A
 * parse failure comes back as `rejected` — a repairable failure, not a dead
 * attempt.
 *
 * Charges the budget as it goes, whether it succeeds or not: a failed attempt cost
 * exactly as much as a successful one, and a call that died on its fourth step
 * still spent four turns.
 */
async function attempt(
  args: RunTurnArgs,
  control: ControlTool[],
  model: () => LanguageModel,
  instructions: string,
  messages: ModelMessage[],
  /**
   * The **round's** record of what it saw, appended to as this attempt works.
   *
   * Owned by the round rather than the attempt, and that is the whole of it: a
   * tool call is a thing that *happened*, and it does not un-happen because the
   * attempt that made it went on to run out of steps or emit a `delegate` the
   * round refused. A primary that cloned a repository and then failed has
   * genuinely cloned it — so a fallback's successful round that carried only its
   * own calls would hand the next round a history missing the very work already
   * done, and the next round would do it again. Which is this feature's own
   * failure mode, reintroduced one level down.
   *
   * The invalid *ending* still goes: `captureObservations` drops any message
   * reaching for a control tool, so a rejected `delegate` never survives while
   * the work in front of it does.
   */
  seen: ModelMessage[]
): Promise<Attempt> {
  const final = args.mode === "final";
  // One step per attempt for a `final` round: it exists to produce the answer, and
  // that answer is deliberately spent *beyond* the budget rather than out of it.
  //
  // An `open` round gets whatever the shared budget still holds, read here rather
  // than at the top of the round — so the fallback sees what the primary spent
  // without anyone having to subtract it. See `stepAllowance` for the floor.
  const stepBudget = final
    ? 1
    : stepAllowance(args.budget.allowance, args.budget.spent);
  // A `final` round is handed nothing to work with, only the way out. Leaving the
  // work tools on would invite it to spend a budget it has already spent — and
  // the composing round has every branch result in its messages already, so the
  // thing it needs is not a lookup but an ending.
  //
  // **And so is any attempt down to its last step**, whatever the round's mode.
  // The loop halts on the step count as readily as on a control call, so an
  // attempt with one step to spend either spends it on an ending or produces
  // none at all — and a work tool is the invitation to do the latter. That is not
  // a hypothetical either: `stepAllowance`'s floor hands the fallback exactly one
  // step whenever the primary drained the allowance, and a fallback that answered
  // a `repo_clone` with it is how a recoverable round became a failed task.
  // `delegate` and `final_reply` stay on either way — they *are* endings.
  const workTools: ToolSet = final || stepBudget <= 1 ? {} : args.tools;
  const content = args.onContent
    ? buildIntermediateContentHandler(args.onContent, [
        DELEGATE_TOOL_NAME,
        FINAL_REPLY_TOOL_NAME
      ])
    : undefined;

  try {
    const result = await generateText({
      model: model(),
      instructions,
      messages,
      // Control tools are declared *first*: tool order is part of the prompt, and
      // the two endings are the thing every round has to reach. Work tool names
      // are compile-time constants and none collides with a control name, so the
      // spread order costs nothing.
      tools: { ...controlToolSet(control), ...workTools },
      // Every ending is a control call, so the model must always call something.
      // Work tools stay freely available — `required` constrains the *shape* of a
      // step's output, not which tool is chosen.
      toolChoice: "required",
      maxOutputTokens: args.maxOutputTokens,
      stopWhen: [
        isStepCount(stepBudget),
        // Halt on any ending this round declares, so a new control tool needs no
        // change here.
        ...control.map((c) => hasToolCall(c.name))
      ],
      abortSignal: args.abortSignal,
      // When a single tool call's signal fires: a grace ahead of
      // {@link file://../platform.ts MAX_TOOL_CALL_MS}, so a tool that honours it
      // can stop its work and still answer inside the bound. Every plugin tool is
      // abandoned at the bound itself, listening or not — see `boundToolCalls`.
      //
      // A call stopped either way ends as a result or a `tool-error` the next
      // step reads, and the loop continues, so the model can route around a
      // wedged tool instead of the round dying with it. That is why only `toolMs`
      // is set here. `stepMs` and `totalMs` abort the whole call, which arrives
      // indistinguishable from a real fault and would spend the fallback slot on
      // work that was merely slow.
      timeout: { toolMs: MAX_TOOL_CALL_MS - TOOL_CALL_GRACE_MS },
      // Charged here rather than from `result.steps` so a throw mid-loop still
      // bills the steps already spent — the `catch` below has no `result` to read.
      onStepEnd: async (step) => {
        args.budget.spent += 1;
        seen.push(...step.response.messages);
        if (content) await content(step);
      }
    });

    // Before the result is read, for the same reason the `catch` checks first: a
    // cancel that lands as the call returns is still a cancel, and acting on the
    // decision would persist rows for a Task nobody is waiting on.
    if (args.abortSignal?.aborted) return { ok: false, aborted: true };

    // The most committal ending the model reached, and every call it made to that
    // tool. Ranking by precedence rather than by position keeps "which ending
    // wins" a property the tools declare, not a chain of ifs here.
    const reached = control
      .map((c) => ({
        control: c,
        inputs: result.toolCalls
          .filter((call) => call.toolName === c.name)
          .map((call) => call.input as unknown)
      }))
      .filter((c) => c.inputs.length > 0)
      .sort((a, b) => b.control.precedence - a.control.precedence)[0];

    if (reached) {
      // The call that counts, per the tool — a repeated `final_reply` means its
      // last one. Held outside the `try` so a rejection shows the model *that*
      // call and not whichever came first, which it may already have moved past.
      // Only a `select` that throws leaves it unresolved, and that error is about
      // the repeats themselves, so the first call represents them as well as any.
      let subject: unknown = reached.inputs[0];
      try {
        subject = reached.control.select(reached.inputs);
        return { ok: true, decision: reached.control.parse(subject) };
      } catch (error) {
        // The model ended the round but the call cannot be used. Repairable: it is
        // handed this error and asked again, rather than costing the whole slot.
        return {
          ok: false,
          error,
          rejected: {
            toolName: reached.control.name,
            input: subject
          }
        };
      }
    }

    // No control call, and no violation thrown: the model ran out of steps
    // mid-tool-use. A model that narrated instead of calling anything does not
    // reach here — the SDK enforces `toolChoice` and throws, which the `catch`
    // below turns into this same failure. Both roads hand the round to the
    // fallback rather than shipping the narration to the user as an answer.
    if (result.finishReason === "length") {
      console.warn("[turn] model output truncated", {
        taskId: args.taskId,
        round: args.round,
        maxOutputTokens: args.maxOutputTokens
      });
    }
    return {
      ok: false,
      error: new Error(
        `round produced no decision (finishReason=${result.finishReason}, textLength=${result.text.trim().length})`
      )
    };
  } catch (error) {
    // Check the signal before the error: an abort surfaces as a rejection, and
    // reading it as bad model output would walk the repair ladder and spend the
    // fallback on a round that was cancelled on purpose.
    if (args.abortSignal?.aborted) return { ok: false, aborted: true };

    // The model narrated instead of calling a tool — the failure this whole
    // design exists to catch. The SDK enforces `toolChoice` itself and throws
    // before the step ends, so this arrives as a throw rather than as a result
    // with no control call, and `onStepEnd` never ran for it.
    //
    // Charge it anyway. The step happened: a provider was called and answered,
    // and the round's rule is that a failed attempt costs exactly what a
    // successful one does. Leaving it free would let a model that never calls a
    // tool burn both slots and every repair without the budget moving.
    if (ToolChoiceViolationError.isInstance(error)) {
      args.budget.spent += 1;
      // Joined before trimming, not trimmed per part: `StepResult.text` on the
      // other road concatenates the parts first, and the two roads emit the
      // same diagnostic. Summing trimmed parts drops the whitespace between
      // them and reports a shorter text than the same content would elsewhere.
      const text = error.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim().length;
      return {
        ok: false,
        error: new Error(
          `round produced no decision (finishReason=${error.finishReason}, textLength=${text})`
        )
      };
    }
    return { ok: false, error, thrown: true };
  }
}

/**
 * How many times one model may be shown its own rejected control call and asked
 * again, before the round gives up on that slot.
 *
 * Repair belongs to the **slot**, not the round. A rejected call is not evidence
 * that a model is unavailable — it is a model that understood the request and got
 * the shape wrong, which is the one failure it can actually fix once it is shown
 * the rejection. Falling straight through to the fallback instead spends a whole
 * second model on a fresh guess that has no idea the first one failed: that is how
 * two slots produced the identical missing-param error and killed a round either
 * of them could have repaired.
 *
 * The fallback keeps its real job — covering a primary that could not answer at
 * all — and is still reached once repairs run out, since a model that cannot get
 * the shape right in four tries has earned a second opinion.
 */
const MAX_REPAIR_ATTEMPTS = 3;

/**
 * The id a repaired exchange is anchored on, derived from the Task and round like
 * every other id here. Suffixed per repair, so several rejected calls can sit in
 * one attempt's messages without colliding.
 *
 * Underscore-separated for the same reason as
 * {@link file://../subtasks/delegate.ts delegateToolCallId}: this reaches a
 * provider as a `tool_use.id`, and Anthropic rejects anything outside
 * `^[a-zA-Z0-9_-]+$`. A repair exchange is exactly the moment a round is already
 * in trouble, so an id that 400s here turns a recoverable bad call into a dead
 * round.
 */
function controlCallId(taskId: string, round: number): string {
  return `task_${taskId}_round_${round}_control`;
}

/**
 * A rejected control call paired with its rejection, as the exchange the model has
 * to see in order to fix it.
 *
 * This is deliberately the same shape the SDK produces for a work tool that failed
 * — the call, then an `error-text` result carrying the reason. A work tool gets
 * this for free and models already know how to read it; a control tool halts the
 * loop before the SDK can, so the round builds it by hand. Nothing here is
 * specific to which control tool was refused.
 *
 * Shaped as a real tool exchange rather than a prose "that was wrong" user turn,
 * because that is what it is — and an assistant tool-call with no matching result
 * is a malformed message list to every provider.
 *
 * Entirely ephemeral. These messages exist for the next `generateText` call and are
 * never appended to the Session: the durable record of a round is the ending it
 * landed on, and a call that was thrown out is not something a later round should
 * be able to read back as history.
 */
function repairExchange(
  toolCallId: string,
  rejected: RejectedCall,
  error: unknown
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: rejected.toolName,
          input: rejected.input
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: rejected.toolName,
          output: {
            type: "error-text",
            value:
              `${String(error)}\n\n` +
              `The round did not end and nothing was started. Call ${rejected.toolName} ` +
              `again, keeping the parts that were fine and fixing only what the error names.`
          }
        }
      ]
    }
  ];
}

/**
 * Run one round against the continuous Session: append the user turn (round 0),
 * let the model decide over the indexed history, validate any delegation against
 * this round's catalog, and persist what the user will see.
 *
 * Every append uses a deterministic id, so a Workflow-step re-run neither
 * duplicates the turn nor changes an already-delivered reply.
 *
 * Two nested recoveries, and they answer different failures. Within a slot, a
 * decomposition the catalog rejects is handed back to the *same* model as a failed
 * tool result, up to {@link MAX_REPAIR_ATTEMPTS} times — a shape error is the one
 * thing a model can fix once it sees it. Across slots, an attempt that produced no
 * decision at all moves to the fallback model, which is what that slot is for.
 *
 * Throws only on a transient platform fault (for the Workflow step to retry).
 * A deterministic failure that outlasts every repair on both slots, with durable
 * work behind it, degrades to {@link joinSuccessfulBranches} rather than discarding
 * completed branches; with nothing behind it, it resolves to
 * `{ status: "failed", kind: "exhausted" }`.
 *
 * The third failure is neither, and it short-circuits the *model* recoveries
 * above: a {@link nonRecoverableKind} error ends the round from wherever it
 * happens, carrying that kind — without repairing and **without reaching the
 * fallback slot**, both of which would only present the same dead credential
 * again. See that function for why the transient/deterministic split cannot
 * express it.
 *
 * It does **not** skip the deterministic join. That path needs no credential —
 * it is string concatenation over rows that are already durable — so completed
 * branches are still delivered, and the credential fault reaches the operator
 * through the log rather than by throwing away finished work.
 */
export async function runTurn(args: RunTurnArgs): Promise<RunTurnOutcome> {
  const { session, taskId, round, text, systemSuffix, models, branches } = args;

  if (round === 0) {
    await appendOnce(
      session,
      deterministicSessionMessage(taskUserMessageId(taskId), "user", text)
    );
  }

  const history = await session.getHistory();
  const { messages, catalog } = renderTurnMessages(
    history,
    taskId,
    branches,
    // Bounded across every carried round at once, so a tool called in three of
    // them keeps its latest answer and stubs the identical ones behind it.
    renderObservations(
      args.observations ?? [],
      args.toolOutputWindow ?? Number.POSITIVE_INFINITY
    )
  );
  const system =
    (await session.refreshSystemPrompt()) +
    systemSuffix +
    (args.mode === "final"
      ? args.instructions.final[args.finalReason ?? "budget"]
      : args.instructions.open);

  // This round's endings, built with the catalog a `delegate` is checked against.
  const control = controlTools({
    catalog,
    delegable: args.mode !== "final",
    types: args.types,
    maxSubtasks: args.maxSubtasks
  });

  const diagnostics: string[] = [];
  const errors: unknown[] = [];

  // Everything this round observed, across every slot and every repair. See the
  // `seen` parameter of `attempt` for why it is the round's and not an
  // attempt's — a call that ran is a call that ran, whichever attempt made it.
  const seen: ModelMessage[] = [];

  /**
   * Which model the first slot's failure belongs to. The fallback once it has
   * been reached mid-attempt, the primary until then — the only thing that
   * distinguishes them once the pair answers as one model.
   */
  let answering = models.primaryId();

  /**
   * The first slot is the pair as one model: a call the primary cannot take is
   * taken by the second at the **step**, so the round keeps the work it has
   * already done instead of starting over. What the slot loop is still for is
   * the failure that wrapper cannot see — a call that came back and reached no
   * ending, where a second model is worth asking.
   */
  const resilient = withFallback(models, {
    onFallback: ({ modelId, error }) => {
      answering = models.fallbackId();
      diagnostics.push(`${modelId}: ${String(error)}`);
      console.warn("[turn] model call failed, trying the other slot", {
        taskId,
        round,
        model: modelId,
        error: String(error)
      });
    },
    // Last word, and it can point back at the primary: the error a failed pair
    // reports is the one worth acting on, not the one that happened last.
    onFailure: ({ modelId }) => {
      answering = modelId;
    }
  });

  slots: for (const slot of ["primary", "fallback"] as const) {
    const model = slot === "primary" ? resilient : models.fallback;

    // This slot's own view: the round's messages plus whatever repair exchange it
    // accumulates. A fresh copy per slot, so a fallback that is reached is never
    // handed the primary's rejected calls to be confused by.
    const slotMessages = [...messages];

    for (let repair = 0; repair <= MAX_REPAIR_ATTEMPTS; repair += 1) {
      // Per attempt, not per slot: a repair is a fresh call, and which model
      // takes it is decided again from the top.
      if (slot === "primary") answering = models.primaryId();

      // Both slots draw on the one `args.budget`, which each attempt reads on entry
      // and charges as it works. A fallback attempt is spend, not a free retry —
      // and so is a repair.
      const outcome = await attempt(
        args,
        control,
        model,
        system,
        slotMessages,
        seen
      );
      const modelId = slot === "primary" ? answering : models.fallbackId();

      if (!outcome.ok) {
        // Ahead of every other exit, including the non-recoverable one: a
        // cancelled round has no second slot to spend and nothing to diagnose.
        // The caller re-reads cancellation itself, so returning here only saves
        // the work — it is not what makes the Task canceled.
        if (outcome.aborted) return { status: "canceled" };

        // Before anything else, and before the fallback slot exists as an
        // option: a failure nothing can clear ends the round here. Repairing
        // asks a dead credential to try again; falling through spends the
        // second slot presenting the *same* dead credential. Both are pure
        // cost, and both delay the only useful outcome — telling an operator
        // what to fix.
        const nonRecoverable = nonRecoverableKind(outcome.error);
        if (nonRecoverable) {
          console.error("[turn] non-recoverable model failure", {
            taskId,
            round,
            model: modelId,
            kind: nonRecoverable,
            error: String(outcome.error)
          });
          // What ends here is *inference*, not the round's ability to answer.
          // Branches that already completed are durable rows, and joining them
          // costs no credential — so the same rescue the exhausted path takes
          // applies, and the operator hears about the fault from the log above.
          const joined = await deterministicJoin(args);
          if (joined) return joined;
          return {
            status: "failed",
            kind: nonRecoverable,
            error: String(outcome.error)
          };
        }

        errors.push(outcome.error);
        const { rejected } = outcome;
        diagnostics.push(
          rejected
            ? `${slot} (${modelId}, attempt ${repair + 1}): ${String(outcome.error)}`
            : `${slot} (${modelId}): ${String(outcome.error)}`
        );
        console.warn(
          rejected
            ? "[turn] control call rejected"
            : "[turn] model attempt failed",
          {
            taskId,
            round,
            model: modelId,
            ...(rejected ? { tool: rejected.toolName, repair } : {}),
            error: String(outcome.error)
          }
        );

        // The call itself failed, so both models have already been asked and
        // there is no second opinion left to buy. Repairing is just as pointless
        // — there is no ending to correct.
        if (outcome.thrown) break slots;

        // No rejected call means no ending to correct — the attempt produced
        // nothing, which is the failure the fallback slot exists for.
        //
        // Otherwise repair, while this slot has both attempts and turns left. Past
        // the allowance every attempt gets `stepAllowance`'s one-step floor, which
        // is enough to reach an ending but not to reconsider one — so retrying
        // there buys a worse call at a real cost.
        if (
          rejected &&
          repair < MAX_REPAIR_ATTEMPTS &&
          args.budget.spent < args.budget.allowance
        ) {
          slotMessages.push(
            ...repairExchange(
              `${controlCallId(taskId, round)}_repair_${repair}`,
              rejected,
              outcome.error
            )
          );
          continue;
        }
        break;
      }

      if (outcome.decision.kind === "reply") {
        // A throw here is a storage fault: it propagates so the step retries.
        const reply = await appendOnce(
          session,
          deterministicSessionMessage(
            finalReplyMessageId(taskId),
            "assistant",
            outcome.decision.text
          )
        );
        return { status: "replied", reply };
      }

      const stored = await appendOnce(
        session,
        deterministicSessionMessage(
          roundAckMessageId(taskId, round),
          "assistant",
          outcome.decision.reply
        )
      );
      return {
        status: "delegated",
        reply: stored,
        drafts: outcome.decision.drafts,
        observations: captureObservations(seen, {
          round,
          controlNames: control.map((c) => c.name)
        })
      };
    }
  }

  // A transient fault is not a decision failure — let the step retry rather than
  // failing the user's Task over Workers-AI capacity.
  const transient = errors.find((e) => isTransientAiError(e));
  if (transient) throw transient;

  const detail = `round ${round} exhausted both models — ${diagnostics.join("; ")}`;

  // Both models failed deterministically. Any branch results behind us are durable
  // and useful; deliver them joined rather than failing a Task whose work is done.
  const joined = await deterministicJoin(args);
  if (joined) return joined;

  return { status: "failed", kind: "exhausted", error: detail };
}

/**
 * Deliver the branch results this round already has, when no model will produce
 * an answer over them.
 *
 * The one recovery on this file that needs **no** model: a filter, a join and a
 * durable append. That is why both failure paths reach it — a ladder that ran out
 * of attempts, and one that stopped on a fault no attempt could clear. Neither
 * has an answer to write; both have work worth returning.
 *
 * `undefined` when nothing completed, which is the caller's signal to fail with
 * its own kind. No branches means nothing to join, and a Task with no work behind
 * it should not report success.
 */
async function deterministicJoin(
  args: RunTurnArgs
): Promise<RunTurnOutcome | undefined> {
  const { session, taskId, round, branches } = args;
  if (!branches.some((b) => b.status === "completed")) return undefined;

  console.warn("[turn] falling back to deterministic join", { taskId, round });
  const reply = await appendOnce(
    session,
    deterministicSessionMessage(
      finalReplyMessageId(taskId),
      "assistant",
      joinSuccessfulBranches(branches, args.partialNote)
    )
  );
  return { status: "replied", reply };
}
