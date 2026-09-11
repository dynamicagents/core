import type { ModelMessage, ToolApprovalStatus, ToolSet } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import type { SessionLike } from "../agent/session.js";
import type { PluginStore } from "../db/db.js";
import type {
  WorkspaceBacking,
  WorkspaceHandle
} from "../subagent/workspace.js";
import type {
  ProgressEvent,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskRuntime
} from "../subtasks/types.js";
import type { SubtaskParams, SubtaskTypeSpec } from "./recipe.js";

/**
 * The plugin contract — everything an independently-packaged capability may
 * contribute to an agent, and the only thing core knows about one.
 *
 * Nothing in core imports a plugin. A plugin imports core (type-only wherever it
 * can) and is registered by the *host* at DO start. That direction is what makes
 * bundle growth proportional to what an agent actually installs, and it is
 * structural rather than a tree-shaker's opinion.
 */

/**
 * The contract version a plugin was built against.
 *
 * Three separate repos means a contract change is a three-repo publish train, and
 * the failure mode of a skew is a structural-type mismatch several frames from
 * its cause. `createAgentRuntime` asserts this instead, so a mismatched plugin
 * fails at DO start with a sentence naming the plugin and both versions.
 *
 * The contract is **additive-only** within a major: new capabilities arrive as
 * optional fields on {@link AgentPlugin}. Removing or re-typing an existing field
 * requires a major and a bump here.
 */
export const PLUGIN_CONTRACT_VERSION = 1;

/**
 * Emit a user-facing progress note from inside a tool (e.g. a level-up in a
 * game, a milestone in a long scrape). The resumable runner collects these and
 * ends the current chunk so the parent can post them promptly. Best-effort — the
 * runner never lets a progress note affect generation.
 */
export type EmitProgress = (event: ProgressEvent) => void;

/**
 * Everything a tool family needs to build its tools, closed over so none of it
 * is ever model input.
 *
 * Note what is **not** here: the Worker `env`. The predecessor passed it, which
 * a published package cannot do — `Env` is the ambient interface `wrangler
 * types` generates into a consumer's `worker-configuration.d.ts` and does not
 * exist outside their app. A plugin takes its secrets and bindings as *config at
 * instantiation* instead, which is also the only thing that works on Workers,
 * where `env` does not exist at module scope.
 */
export interface ToolFamilyContext<TRuntime = SubtaskRuntime> {
  /** The execution's durable file store. */
  workspace: WorkspaceHandle;
  emitProgress: EmitProgress;
  /**
   * The subtask's validated params — the ids its type declared it needs. Chosen
   * by the delegating main agent and checked against its type's contract before
   * this execution began, so a family may read them directly; they are not this
   * model's input.
   */
  params: SubtaskParams;
  /**
   * Session state the parent resolved for this execution — what no model could
   * supply and none should be asked to. Opaque to core; a plugin narrows it to
   * whatever its own {@link AgentPlugin.resolveRuntime} wrote.
   */
  runtime: TRuntime;
  /**
   * Aborts when this execution is cancelled, and belongs to the chunk these tools
   * are built for — a tool must not be kept past it.
   *
   * Not needed to bound a call: core stops waiting on every plugin tool at
   * {@link file://../platform.ts MAX_TOOL_CALL_MS} on its own. Read it to stop work
   * that would outlive a cancel — a process to kill, a write not yet sent. A tool
   * that must also stop at its call's deadline reads `execute`'s `abortSignal`
   * instead, which carries both.
   *
   * Absent when families are rebuilt only to run their `abort` hooks.
   */
  signal?: AbortSignal;
}

/**
 * A tool family's contribution: its tools, plus an optional `abort` hook the
 * facet runs on cancellation to release external state the family acquired.
 *
 * Anything the hook needs must be reconstructible from the workspace, so it is
 * safe to run on a fresh isolate after eviction.
 */
export interface RecipeToolSet<TRuntime = SubtaskRuntime> {
  tools: ToolSet;
  abort?: (ctx: ToolFamilyContext<TRuntime>) => Promise<void>;
}

/** Builds one tool family's contribution for a single execution. */
export type ToolFamilyBuilder<TRuntime = SubtaskRuntime> = (
  ctx: ToolFamilyContext<TRuntime>
) => RecipeToolSet<TRuntime>;

/** What the parent knows when resolving an execution's runtime state. */
export interface ResolveRuntimeContext {
  taskId: string;
  subtaskId: number;
  type: string;
  params: SubtaskParams;
  toolFamilies: readonly string[];
}

/** What the parent knows when a plugin gets to enrich a terminal result. */
export interface EnrichResultContext<TRuntime = SubtaskRuntime> {
  request: RecipeExecutionRequest;
  runtime: TRuntime;
}

/**
 * What a plugin knows when it builds the *main* agent's tools.
 *
 * Deliberately not the caller's identity. A plugin that needs a per-caller value
 * takes it as config at instantiation, like every other config value — the
 * Durable Object is keyed 1:1 by the verified caller, so that value is constant
 * for its life. Putting it here as well would give a plugin two ways to reach one
 * fact, and the *other* hook that needs it
 * ({@link AgentPlugin.onMessagesDisplaced}) has no context to read it from
 * anyway.
 *
 * What the session gives that config cannot is **durable state the tool surface
 * depends on** — whether history has ever been compacted, how many contexts are
 * set. That is a question only the session can answer, and only at call time.
 */
export interface MainAgentToolContext {
  session: SessionLike;
  /**
   * Aborts when this round's Task is cancelled. The main-agent side of
   * {@link ToolFamilyContext.signal}, read for the same reasons, and belonging to
   * one round the same way: tools are built again for the next.
   */
  signal?: AbortSignal;
}

/** What a plugin knows when deciding whether a turn should run at all. */
export interface TurnGateContext {
  /**
   * The conversation so far, **including the message being judged** — which is
   * already appended when a gate runs, so the agent reads a message it declines.
   * A bare message is frequently unclassifiable ("yes", "thanks", "and the
   * second one?"), so the tail is what makes the judgement possible at all.
   */
  history: SessionMessage[];
}

/**
 * Approval rules for main-agent tools, by tool name. See
 * {@link AgentPlugin.mainAgentToolApproval}.
 */
export type MainAgentToolApproval = Record<
  string,
  ToolApprovalStatus | MainAgentToolApprovalRule
>;

/**
 * A rule decided per call, from what the call was asked to do: its validated
 * input, and the conversation it came out of.
 */
export type MainAgentToolApprovalRule = (
  input: unknown,
  options: { toolCallId: string; messages: ModelMessage[] }
) => ToolApprovalStatus | PromiseLike<ToolApprovalStatus>;

/** Bindings and secrets a plugin needs the *host* to provide in `wrangler.jsonc`. */
export interface PluginRequirements {
  /** Secret names, e.g. `["ARC_API_KEY"]`. */
  secrets?: readonly string[];
  /** Binding names, e.g. `["BROWSER"]`. */
  bindings?: readonly string[];
}

export interface AgentPlugin<TRuntime = SubtaskRuntime> {
  /** Stable identifier, unique across installed plugins. */
  key: string;
  /**
   * The {@link PLUGIN_CONTRACT_VERSION} this plugin was built against. Set it
   * from the imported constant, never as a literal — the point is that it moves
   * with the core the plugin compiled against.
   */
  contractVersion: number;

  // --- subagent side ---

  /**
   * The subtask type this plugin makes delegable, and the recipe it runs under.
   * A plugin that only contributes main-agent tools declares none.
   */
  subtaskType?: SubtaskTypeSpec;
  /**
   * Tool families this plugin registers, keyed by family name. A recipe selects
   * families by name; a name no installed plugin registers is dropped by
   * `validateRecipe`, so the legal set is exactly what is installed.
   */
  toolFamilies?: Record<string, ToolFamilyBuilder<TRuntime>>;

  // --- main-agent side ---

  /**
   * Tools offered to the *main* agent (e.g. a catalogue lookup before
   * delegating).
   *
   * May return a promise, so a plugin can shape its tool surface from durable
   * state — offering a search tool only once there is something to search, say.
   * A tool that can only ever return "nothing here yet" costs the model a call to
   * find that out, and costs every round the tokens to describe it.
   */
  mainAgentTools?: (ctx: MainAgentToolContext) => ToolSet | Promise<ToolSet>;
  /**
   * Which of this plugin's main-agent tools need a person's say before they run,
   * by tool name.
   *
   * A rule is a status, or a function of the call returning one.
   * `"user-approval"` stops the round and asks the person, and its object form's
   * `reason` is the words they read about the call; `"denied"`, `"approved"` and
   * `undefined` decide without asking anyone. See `RoundPolicy.human` for what a
   * round does with a call that waits.
   *
   * **The main agent's calls only.** A subagent runs unattended, so a recipe
   * naming this plugin's tool family gets these tools with no rules at all.
   *
   * A rule is never a way around its tool: an agent with nobody to ask has every
   * call a rule would have held refused, not run. An agent that wants a tool to
   * run without asking removes the rule — see {@link withoutToolApproval}.
   */
  mainAgentToolApproval?: (
    ctx: MainAgentToolContext
  ) => MainAgentToolApproval | Promise<MainAgentToolApproval>;
  /**
   * What the main agent is told it can do with this domain, rendered into its
   * soul alongside the other capability blocks.
   *
   * A plugin that declares a {@link subtaskType} should put its capability block
   * on the *type* instead ({@link SubtaskTypeSpec.capability}) and leave this
   * unset. Both are rendered, so declaring both makes the main agent read the
   * same advice twice per round — the exact failure the type's own prompt
   * fields were introduced to end.
   */
  capability?: string;

  // --- parent-side lifecycle hooks ---

  /**
   * Resolve the session state an execution needs and no model can supply — a
   * leased external resource, a session handle, a cookie jar.
   *
   * Called by the parent before each chunk, and deliberately outside the
   * execution's fingerprint: what it returns can legitimately change between two
   * chunks of one run, and must not make a retry look like different work.
   */
  resolveRuntime?: (ctx: ResolveRuntimeContext) => Promise<TRuntime>;
  /**
   * Amend a terminal result before it is persisted — e.g. append a score the
   * subagent had no way to read. Returning the result unchanged is always valid.
   */
  enrichResult?: (
    ctx: EnrichResultContext<TRuntime>,
    result: RecipeExecutionResult
  ) => Promise<RecipeExecutionResult>;
  /** Release anything {@link resolveRuntime} acquired, when an execution is canceled. */
  onAbort?: (ctx: ResolveRuntimeContext) => Promise<void>;

  // --- session lifecycle ---

  /**
   * Decide whether a turn should run at all, before the loop builds or calls
   * anything.
   *
   * An agent that sees every message in its channels is mostly seeing messages
   * that are not for it. Left to the main loop that judgement is made by a model
   * simultaneously trying to be helpful, with history and half a dozen tools in
   * view, and it degrades exactly there — *invisibly*, because failing to call a
   * decline-tool looks identical to deciding not to. A gate moves the decision
   * somewhere it cannot be skipped.
   *
   * **Fails open, and the asymmetry is the whole design.** A gate that throws is
   * counted as `true`, so an outage degrades to the previous behaviour (run the
   * turn) and never to a silent agent: a wrong reply is noise the user can see
   * and ignore, while a wrong silence is invisible — the person who needed the
   * agent simply never hears back. Failing *synchronously* is as safe as
   * rejecting.
   *
   * Every declaring plugin is consulted and the results are AND-ed: any one gate
   * may decline the turn. Returning `true` is always valid.
   */
  shouldHandleTurn?: (ctx: TurnGateContext) => Promise<boolean>;

  /**
   * The raw messages a compaction is about to fold into a summary, handed over
   * before they stop being readable as history.
   *
   * This is core being honest about a **lossy operation it performs**, not a
   * write path for any one plugin: compaction is destructive, core is what
   * destroys, and anything that wants the originals — an archive, an audit log,
   * a cold-storage dump — needs to be told at exactly this moment. What a plugin
   * does with them is entirely its own business; core neither knows nor cares.
   *
   * Best-effort in both directions. A throw here never aborts compaction —
   * history must still shorten when a side store is briefly unavailable — and
   * the runtime fans out with `Promise.allSettled`, so one plugin's failure can
   * neither abort another plugin's write nor leave it unawaited. Failing
   * *synchronously* is as safe as rejecting: this need not be an `async`
   * function, and the runtime handles either.
   */
  onMessagesDisplaced?: (messages: SessionMessage[]) => Promise<void>;

  // --- storage + requirements ---

  /** Tables this plugin owns, outside core's migration journal. See {@link PluginStore}. */
  store?: PluginStore;
  /**
   * The durable file store a subagent execution's workspace is built over.
   *
   * Core declares the {@link WorkspaceBacking} shape and enforces the caps, but
   * ships no backend: the predecessor's was `@cloudflare/shell`, which is
   * experimental ("expect breaking changes"), and an agent that never delegates
   * file work should not carry it. So the backend arrives here, from a plugin,
   * and an agent that installs none falls back to an in-memory one.
   *
   * At most one installed plugin may declare this — two backends would mean two
   * answers to "where did that file go", and the file would be in whichever the
   * runtime happened to pick.
   *
   * `sql` is the executing facet's own SQLite, so isolation per execution is
   * free and deleting the child wipes the workspace with it. `name` is lazy
   * because a facet's name is set after construction.
   */
  workspaceBacking?: (
    sql: SqlStorage,
    name: () => string | undefined
  ) => WorkspaceBacking;
  /**
   * Bindings and secrets the host must declare in `wrangler.jsonc`. A plugin
   * cannot add its own binding, so declaring them lets startup fail with a
   * readable message instead of at the first tool call, in a request a user is
   * waiting on.
   */
  requires?: PluginRequirements;
}

/**
 * Identity helper that pins {@link AgentPlugin.contractVersion} for you and gives
 * a plugin author inference on `TRuntime`.
 *
 * ```ts
 * export function arcAgi(config: { apiKey: string }) {
 *   return definePlugin<ArcRuntime>({ key: "arc-agi", … });
 * }
 * ```
 */
export function definePlugin<TRuntime = SubtaskRuntime>(
  plugin: Omit<AgentPlugin<TRuntime>, "contractVersion"> & {
    contractVersion?: number;
  }
): AgentPlugin<TRuntime> {
  return {
    ...plugin,
    contractVersion: plugin.contractVersion ?? PLUGIN_CONTRACT_VERSION
  };
}

/** See {@link restrictMainAgentTools}. */
export interface RestrictMainAgentToolsOptions {
  /**
   * The tool names the main agent keeps. `[]` removes the hook entirely, which
   * is the "orchestrator with no hands" case.
   *
   * Names rather than a predicate, because the point is to state the surface
   * explicitly at the install site: a reader of `plugins.ts` should be able to
   * see what the main agent can do without opening the plugin.
   */
  allow: readonly string[];
  /**
   * What the main agent is told instead of the plugin's own
   * {@link AgentPlugin.capability}.
   *
   * Required in spirit whenever `allow` is non-empty: the plugin's block
   * describes its *whole* surface, so leaving it in place tells the model about
   * tools it no longer has — which it then tries to call. Omit it to say
   * nothing, which is right for `allow: []`.
   */
  capability?: string;
}

/**
 * A plugin whose tool families stay registered but whose main-agent surface is
 * narrowed, or removed.
 *
 * ## Why this has to exist
 *
 * `validateRecipe` runs on the **parent** and drops any tool family no installed
 * plugin registered. So an agent that wants "my subagents can run a shell, I
 * cannot" has a problem: uninstalling the sandbox plugin from the parent also
 * deletes `sandbox` from every recipe the parent validates, and the subagents
 * silently lose it. The parent has to install the plugin and decline its tools,
 * which is exactly what this expresses.
 *
 * ```ts
 * // The parent registers the family, and gets three read-only tools from it.
 * restrictMainAgentTools(sandbox(cfg), {
 *   allow: ["sb_read", "sb_ls", "sb_exists"],
 *   capability: "You can read the checkout, not change it."
 * })
 * ```
 *
 * ## What passes through untouched
 *
 * Everything else: `toolFamilies`, `subtaskType`, `resolveRuntime`, `store`,
 * `requires`, and the lifecycle hooks. In particular `requires` must survive, or
 * a parent that stops offering `sb_exec` also stops asserting that the `Sandbox`
 * binding exists — and the failure moves from DO start to a subagent's first
 * tool call.
 *
 * ## Why a missing name logs instead of throwing
 *
 * `mainAgentTools` is async and called per turn, so a throw here lands inside a
 * request someone is waiting on — a bad trade for what is always a typo. The
 * error names the plugin and the tool so it is greppable, and the honest place
 * to catch it is a test over the assembled surface, which is cheap to write and
 * fails the build instead.
 */
export function restrictMainAgentTools<TRuntime = SubtaskRuntime>(
  plugin: AgentPlugin<TRuntime>,
  options: RestrictMainAgentToolsOptions
): AgentPlugin<TRuntime> {
  const allow = new Set(options.allow);

  // Spread first so anything added to `AgentPlugin` later keeps flowing through
  // without an edit here — the failure mode of an explicit field list is a
  // capability that silently stops reaching the parent.
  const restricted: AgentPlugin<TRuntime> = { ...plugin };

  if (allow.size === 0) {
    delete restricted.mainAgentTools;
  } else {
    // Installed even when the plugin offers no `mainAgentTools` at all, rather
    // than left `undefined`. A plugin with no main-agent surface is not the
    // "nothing to narrow" case it looks like — it is an allowlist naming tools
    // that do not exist, which is precisely the typo this helper promises to
    // report, and the one shape of it that is hardest to spot: a whole surface
    // removed or renamed disappears without a word. The assembled tool set is
    // identical either way, because `runtime.mainAgentTools` merges each
    // plugin's result and an empty one contributes nothing.
    const inner = plugin.mainAgentTools;
    restricted.mainAgentTools = async (ctx) => {
      const all = inner ? await inner(ctx) : {};
      const kept: ToolSet = {};
      for (const name of allow) {
        if (name in all) kept[name] = all[name] as ToolSet[string];
        else
          console.error(
            `[plugin] "${plugin.key}" offers no main-agent tool "${name}" — ` +
              "the allowlist names a tool that does not exist, so the main " +
              "agent is quietly missing it. Check for a rename."
          );
      }
      return kept;
    };
  }

  if (options.capability === undefined) delete restricted.capability;
  else restricted.capability = options.capability;

  return restricted;
}

/** See {@link withoutToolApproval}. */
export interface WithoutToolApprovalOptions {
  /**
   * The tools whose rules go. Omit it to drop every rule the plugin declares.
   *
   * Names, for the reason {@link RestrictMainAgentToolsOptions.allow} gives: the
   * install site is where a reader should see which calls run without asking.
   */
  tools?: readonly string[];
}

/**
 * A plugin whose main-agent tools run without asking anyone — all of them, or
 * the ones named.
 *
 * For an agent that has decided nobody needs to approve these calls: one whose
 * gatekeeper cannot put a question to a person, or whose every Task is already a
 * person's instruction to make them. Everything else about the plugin passes
 * through untouched, as with {@link restrictMainAgentTools}, and a name that
 * matches no rule is logged rather than thrown, for the reason that helper gives.
 */
export function withoutToolApproval<TRuntime = SubtaskRuntime>(
  plugin: AgentPlugin<TRuntime>,
  options: WithoutToolApprovalOptions = {}
): AgentPlugin<TRuntime> {
  const released: AgentPlugin<TRuntime> = { ...plugin };
  const inner = plugin.mainAgentToolApproval;
  if (!inner || options.tools === undefined) {
    delete released.mainAgentToolApproval;
    return released;
  }

  const drop = new Set(options.tools);
  released.mainAgentToolApproval = async (ctx) => {
    const rules = { ...(await inner(ctx)) };
    for (const name of drop) {
      if (Object.hasOwn(rules, name)) delete rules[name];
      else
        console.error(
          `[plugin] "${plugin.key}" declares no approval rule for "${name}" — ` +
            "the name matches none of its rules, so nothing was released. " +
            "Check for a rename."
        );
    }
    return rules;
  };
  return released;
}
