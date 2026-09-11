import type { ResolvedRecipe, SubtaskParams } from "../contract/recipe.js";
import type { RoundFailureKind } from "../agent/inference.js";

export type SubtaskStatus =
  "pending" | "running" | "completed" | "failed" | "canceled";

/** A per-caller, SQLite-assigned, monotonically increasing Subtask identifier. */
export type SubtaskId = number;

/**
 * An exact, verbatim snapshot of one selected Session history message, copied
 * onto the Subtask at decomposition time. The decomposition model selects which
 * messages to reference; it never rewrites their content. User-turn provenance
 * (author/channel) is already inline in the message text's `<turn>` wrapper.
 */
export interface SubtaskReference {
  role: "user" | "assistant";
  text: string;
}

/**
 * One part of a Subtask's result. Text-only today; file/data kinds are additive
 * later. Internal to the agent — the terminal A2A Task collapses these to a
 * single text reply for the gatekeeper/human.
 */
export interface SubtaskResultPart {
  kind: "text";
  text: string;
}

/**
 * Creation input for one Subtask, before it is persisted. `ordinal` is derived
 * from the draft's position in the decomposition array, which is the only thing
 * that distinguishes one draft of a decomposition from another — they carry no
 * identity of their own until the data layer assigns a {@link SubtaskId}.
 */
export interface SubtaskDraft {
  type: string;
  prompt: string;
  references: SubtaskReference[];
  /** The type's required inputs, already validated for shape. */
  params: SubtaskParams;
}

/**
 * Session state the parent resolved *from* a Subtask's params at execution
 * start — the part of an execution's context the model can never supply.
 *
 * Deliberately outside {@link RecipeExecutionRequest}: it is not part of an
 * execution's identity and it can change under us, so fingerprinting it would
 * make a retry look like a different request. It travels as a separate argument,
 * the same discipline as the chunk number.
 */
export type SubtaskRuntime = Record<string, unknown>;

/**
 * Narrow a {@link SubtaskRuntime} to the shape a plugin resolved for itself.
 *
 * Runtime is an open bag because core cannot know what a domain needs — the
 * predecessor repo declared ARC's four fields (`cardId`, `cookies`, `guid`,
 * `frame`) right here in the delegation types, which meant core imported a
 * domain's types and every unrelated agent carried them. A plugin now writes and
 * reads its own slice, and the only thing core does with the bag is carry it.
 *
 * The unchecked cast is the point: the plugin that wrote the slice is the plugin
 * reading it, so the assertion is local and its blast radius is one module.
 */
export function runtimeAs<T>(runtime: SubtaskRuntime): T {
  return runtime as T;
}

/**
 * A user-facing progress note a tool emits mid-execution (e.g. a game level-up).
 * The resumable runner collects these and ends the current chunk so the parent
 * DO can post them promptly; `key` is a stable dedupe id the gatekeeper keys on.
 */
export interface ProgressEvent {
  key: string;
  text: string;
}

/**
 * One durable chunk's outcome as the facet reports it to the parent DO. `done`
 * false means the run yielded a chunk boundary and the Workflow must run another
 * chunk; `done` true carries the terminal {@link RecipeExecutionResult}. Progress
 * events accumulated during the chunk ride along either way.
 */
export type RecipeChunkResult =
  | { done: false; progress: ProgressEvent[] }
  | { done: true; result: RecipeExecutionResult; progress: ProgressEvent[] };

/**
 * The parent DO's projection of a chunk outcome for the Workflow (RPC-safe, no
 * result parts — those are persisted on the row). `status` is `running` until the
 * run is `done`, then the terminal Subtask status.
 */
export interface SubtaskChunkOutcome {
  done: boolean;
  status: SubtaskStatus;
  progress: ProgressEvent[];
}

/**
 * RPC-safe input for one isolated `RecipeSubagent` execution, assembled by the
 * parent at execution start: the already-resolved (and code-validated) Recipe,
 * the Subtask's non-session prompt, and its verbatim reference snapshots. The
 * child re-validates the Recipe defensively but never resolves one itself.
 */
export interface RecipeExecutionRequest {
  taskId: string;
  subtaskId: SubtaskId;
  /**
   * The Subtask's semantic type — what the work *is*, and what owns the params
   * contract. Distinct from `recipe.key`, which names the execution
   * configuration it runs under: several types may share one Recipe.
   */
  type: string;
  recipe: ResolvedRecipe;
  prompt: string;
  references: SubtaskReference[];
  /**
   * The Subtask's validated params. Part of the execution's identity — two plays
   * of different games are different work — so this IS fingerprinted, unlike
   * {@link SubtaskRuntime}, which is deliberately excluded: the leased scorecard
   * can legitimately differ between two chunks of one run, and must not make a
   * retry look like a different execution.
   */
  params: SubtaskParams;
}

/**
 * Terminal outcome of one `RecipeSubagent` execution (RPC-safe). `modelId` is a
 * diagnostic only — which model produced the outcome (null when validation
 * failed before any model call); it is never persisted on the Subtask row.
 * Transient platform faults are not results: they throw so the enclosing
 * Workflow step can retry.
 */
export type RecipeExecutionResult =
  | { status: "completed"; resultParts: SubtaskResultPart[]; modelId: string }
  | { status: "failed"; error: string; modelId: string | null };

/**
 * One Subtask as the delegating model emits it. The model selects references
 * by **catalog index only** — it never emits reference text, and application code
 * snapshots the catalog entry's exact role+text onto the Subtask (see
 * `agent/subtasks/decomposition.ts`).
 */
export interface SubtaskProposal {
  type: string;
  prompt: string;
  /**
   * 1-based indices into the ephemeral, per-round reference catalog. Optional:
   * omitted when the subtask needs no verbatim history, and always absent from a
   * *reconstructed* historical call, whose references were resolved rounds ago.
   */
  referenceIndexes?: number[];
  /** The type's required inputs; omitted for a type that takes none. */
  params?: SubtaskParams;
}

/**
 * The model's complete `delegate` call: the acknowledgment the user sees while
 * the work runs, plus one through eight Subtask proposals. Validated against the
 * round's ephemeral catalog before anything is persisted; invalid output fails
 * the attempt (and, with both models exhausted, the round) rather than being
 * silently repaired.
 */
export interface DecompositionProposal {
  reply: string;
  subtasks: SubtaskProposal[];
}

/**
 * Terminal outcome of one main-agent round (RPC-safe).
 *
 * `replied` is the terminal answer — the round chose to answer the user rather
 * than delegate, and the Workflow delivers it. `delegated` means the round's
 * Subtask rows are durable and the Workflow should execute them, after which
 * another round begins. `failed` means the round produced no answer, with
 * {@link RoundFailureKind} carrying why; no Subtask is ever synthesized to cover
 * for it. `canceled` means the caller cancelled during the round: nothing was
 * persisted and nothing was published. `parked` means it asked the person
 * something and ended there; the round after it reads the answer. Transient platform faults are not
 * results: they throw so the enclosing Workflow step can retry (mirrors
 * {@link RecipeExecutionResult}).
 *
 * `turns` is what this round cost, which the Workflow meters against the Task's
 * budget. This is the **only** type that carries it, and it carries it because the
 * count has to cross an RPC boundary to reach a Workflow in another isolate;
 * everything inside the DO shares one mutable
 * {@link file://../agent/budget.ts TurnBudget} instead. The field is attached in a single place — see `runTaskTurn` — so no
 * branch can drop it and no branch can invent it.
 *
 * The idempotent recovery paths — a round replayed from durable rows rather than
 * re-inferred — therefore report **0** structurally: they return before any model
 * runs, so the budget they hand back is untouched. That is exact on a clean
 * replay, where the Workflow's own cached step return already carries the original
 * number, and under-counts by one round when a step crashed mid-flight and re-ran.
 * Accepted rather than fixed: a replying round writes no durable row at all, so
 * nothing exists to hang a per-round count on, and the wall clock bounds the
 * crash-loop case anyway.
 */
export type TurnTaskResult =
  | { status: "replied"; reply: string; turns: number }
  | { status: "delegated"; reply: string; subtasks: Subtask[]; turns: number }
  /**
   * `kind` distinguishes a round that spent both models and got nothing usable
   * (`exhausted`) from one that stopped on a fault no attempt could clear —
   * where the fallback was deliberately *not* tried, and the kind is what lets
   * the host say why in words an operator can act on. Same terminal Task either
   * way; only the words differ.
   */
  | { status: "failed"; kind: RoundFailureKind; error: string; turns: number }
  | { status: "canceled"; turns: number }
  /**
   * The round asked the person a question. The question is durable in the
   * Durable Object; the Workflow posts it and waits, and the next round reads
   * the answer.
   */
  | { status: "parked"; turns: number };

/**
 * Distributive `Omit` — applies per member, so the discriminated union survives.
 * A plain `Omit<TurnTaskResult, "turns">` collapses all four into one loose shape
 * whose `reply` and `subtasks` are independently optional.
 */
type WithoutTurns<T> = T extends unknown ? Omit<T, "turns"> : never;

/**
 * What a round decided, before its cost is attached. The DO's round logic returns
 * this and lets one wrapper bill the budget, rather than every branch remembering
 * to report a number it did not compute.
 */
export type TurnVerdict = WithoutTurns<TurnTaskResult>;

/**
 * One branch's outcome as a later round sees it — a plain, RPC-safe subset of the
 * durable {@link Subtask} row, loaded across **every** round in stable ordinal
 * order. Completed and failed branches are both included so the reply can use
 * available successes and disclose relevant failures.
 *
 * Carries `round` and `prompt` — not for composing, but for reconstructing the
 * per-round `delegate` call that produced these branches (see
 * `agent/subtasks/delegate.ts`). `references` stays out: it is unbounded history
 * text, and the call's shape does not need it.
 */
export interface CompositionBranch {
  subtaskId: SubtaskId;
  round: number;
  ordinal: number;
  type: string;
  prompt: string;
  params: SubtaskParams;
  status: SubtaskStatus;
  resultParts: SubtaskResultPart[] | null;
  error: string | null;
}

/**
 * The `scan:<round>` projection (RPC-safe): either the caller cancelled, or the
 * ids of the round's Subtasks that still owe an outcome, in ordinal order.
 * Returning the verdict with the ids is what lets the Workflow drop its separate
 * cancellation probe — one round trip, and no gap between asking and acting.
 *
 * Ids and nothing else, deliberately: a Workflow step return is capped at 1 MiB
 * and a Subtask carries verbatim history snapshots bounded only by
 * `MAX_INBOUND_TEXT_BYTES`, so a scan returning rows would overflow on a large
 * task. The durable rows are the source of truth; the Workflow carries
 * references to them and re-reads through the parent when it needs more.
 */
export type SubtaskScan =
  { canceled: true } | { canceled: false; ids: SubtaskId[] };

/** Durable state owned by the main agent for one delegated unit of work. */
export interface Subtask {
  id: SubtaskId;
  taskId: string;
  /** The main-agent round that delegated this Subtask (0-based). */
  round: number;
  /** Position within the parent Task, increasing across every round. */
  ordinal: number;
  type: string;
  recipeId: string | null;
  recipeVersion: number | null;
  prompt: string;
  references: SubtaskReference[];
  /** The type's required inputs, validated at delegation time. */
  params: SubtaskParams;
  status: SubtaskStatus;
  resultParts: SubtaskResultPart[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}
