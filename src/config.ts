/**
 * The shapes of everything an agent tunes, plus a working set of defaults.
 *
 * In the predecessor repos this file held bare `export const`s that ~12 modules
 * imported directly. That is what this package cannot do: a module-level constant
 * read at import time is not overridable by a consumer, and it freezes the value
 * into the module graph before `env` exists. So core owns the *shapes* and a
 * baseline; a consuming agent passes overrides to {@link resolveConfig} once, at
 * DO start, and the resolved object is threaded through explicitly.
 *
 * The distinction against {@link file://./platform.ts} stays sharp: nothing here
 * is a platform fact, and nothing there is tunable.
 */
/** Model ids and per-call generation settings. */
export interface ModelConfig {
  /**
   * Workers AI model for the tool loop. Must support function calling.
   *
   * **Required — core ships no default.** Which model an agent runs on is the
   * single most consequential thing about it: it sets the cost of every turn,
   * the tool-calling reliability the whole control-tool design rests on, and the
   * failure modes the fallback exists to escape. A default here would be core
   * making that choice on a consumer's behalf, silently, and being wrong for
   * most of them — the same reason core ships no prompt copy.
   *
   * It is also the value most likely to age badly. A model id baked into a
   * published package survives every deprecation until someone bumps the
   * package; one written in the agent that uses it is read by whoever owns the
   * bill.
   */
  chatModelId: string;
  /**
   * Tried when the primary throws. **Required — core ships no default.**
   *
   * Should be a *different vendor and family* — a same-family fallback shares
   * the failure mode you are falling back from, which makes it a retry wearing
   * a costume. Core cannot pick this for you precisely because it depends on
   * what you chose as primary.
   */
  fallbackChatModelId: string;
  /** AI Gateway slug; `"default"` auto-provisions on first request. */
  aiGatewayId: string;
  /**
   * Output-token ceiling for every chat call. Left unset, the binding applies a
   * per-model default which a reasoning model spends on `reasoning_content`
   * before emitting the tool call — a truncated round that reads as a clean
   * answer. Generous on purpose: it bounds a runaway, it does not ration.
   */
  maxOutputTokens: number;
  /** Reasoning budget forwarded on the binding's `inputs` by workers-ai-provider. */
  reasoningEffort: "low" | "medium" | "high";
}

/**
 * An execution budget, in the only two currencies that mean anything: **turns**
 * (what it costs) and **wall clock** (how long it can run away for).
 *
 * Rounds, chunks and steps are *mechanics*, not budgets — a round is the
 * delegate/answer loop, a chunk is a durable slice sized by the Workers step
 * timeout. None of them is tunable and none belongs here. Conflating the two is
 * what once made an overnight runaway look healthy to every cap in the system.
 *
 * Reaching either ceiling does the same thing at either level: one final call
 * with **no tools** — "you have spent your budget, answer now from what you
 * have". A ceiling yields an answer; it never drops the work.
 */
export interface AgentLimits {
  /**
   * Tool-loop steps, summed across every round *and* across the
   * primary→fallback attempt within a round — a fallback attempt is real spend.
   *
   * As `mainAgentLimits`, the **last** of these is reserved: the round loop stops
   * opening working rounds one turn early and spends what is left on the forced
   * answer, because a round with a single step can only spend it on a tool call
   * or on an ending, and cannot be relied on to pick the ending. So a delegating
   * task needs at least two here to delegate at all. A subagent's budget has no
   * such reservation — its runner ends in a report rather than in a round.
   */
  maxTurns: number;
  /**
   * Measured from the first durable step, **less the time the Task spent waiting
   * on a person's answer**. That time is the person's: charged to the agent, a
   * Task that asks a question at minute 5 would be dead before the answer
   * arrived. Turns need no such care — waiting spends none. The subtraction is
   * in {@link file://./round/workflow.ts runHandleTask}.
   */
  maxWallMs: number;
}

/** Session memory + compaction tuning. */
export interface SessionConfig {
  /** Soft cap (tokens) for the self-edited `"memory"` scratchpad block. */
  memoryMaxTokens: number;
  /** Live-history token threshold that triggers automatic compaction. */
  compactAfterTokens: number;
  /**
   * Tokens of the most recent history compaction keeps **verbatim**.
   *
   * Read this together with {@link compactAfterTokens}; neither means anything
   * alone. After a compaction the floor is `system + protectHead + summary +
   * tail`, so the conversation that must accumulate before compaction fires
   * again is `Δ = compactAfterTokens − floor`, and the SDK sizes each summary at
   * 20% of the middle it folded, so at equilibrium `S ≈ 0.2Δ`.
   *
   * INVARIANT: `compactAfterTokens − compactTailTokens >= 10_000`, asserted in
   * `session.spec.ts`. Below it the fixed floor eats the gap and compaction
   * fires on nearly every append, each firing spending a summarizer call on a
   * near-empty middle. Never lower the threshold without lowering the tail too.
   */
  compactTailTokens: number;
  /** One-line description shown to the model for the writable `"memory"` block. */
  memoryDescription: string;
}

export interface CoreConfig {
  model: ModelConfig;
  /** What bounds the MAIN agent across every round of one task. */
  mainAgentLimits: AgentLimits;
  /**
   * The baseline every subagent branch runs under. A recipe may override either
   * field — to any positive integer, larger included — and inherits the baseline
   * for whatever it does not validly declare. A default, not a ceiling.
   */
  subagentLimits: AgentLimits;
  /**
   * How many of the most recent assistant turns keep their tool **results** in a
   * subagent's rolling window. Older results are stubbed; the tool *calls* and
   * the model's own text always survive the full `historyWindow`, because that
   * is where a recipe's model keeps whatever it wrote down for itself.
   *
   * A mechanic of the window, not a property of a domain — which is why it is
   * deliberately not a recipe field: recipe fields are fingerprinted, and
   * changing a fingerprint strands every in-flight run behind a mismatch that
   * costs it its whole history.
   */
  toolOutputWindow: number;
  /**
   * How many **earlier rounds** of a task keep the work-tool exchanges they made,
   * for the rounds that follow to read.
   *
   * A round is one `generateText` call, so the calls it makes and the results
   * they return end with it: what survives into the Session is the round's
   * *ending* — the acknowledgment the user saw. Carry nothing and each round
   * inherits its predecessors' claims and none of their evidence, which is a loop
   * that reinforces itself. A task on 2026-09-05 delegated thirteen times, and
   * every one of those rounds re-made an SSH clone URL that had already been
   * refused, because the refusal was a tool result and tool results were dropped.
   *
   * Two is enough for that: the wall a round just hit is the wall it is about to
   * hit again. Raising it buys a longer memory of what has already been tried, at
   * tokens that compete directly with `session.compactAfterTokens` — and the
   * carried rounds are elided against each other
   * (see {@link CoreConfig.toolOutputWindow}), so the cost grows slower than the
   * count. Zero opts out entirely: no rows are read and the round renders exactly
   * as it did before any of this existed.
   */
  roundObservationWindow: number;
  /**
   * Upper bound on subtasks per **round** — a core invariant: a delegating round
   * emits `1..maxSubtasks` subtasks, which is also what bounds its fan-out (they
   * all run concurrently, with no other concurrency cap).
   *
   * Not a budget but a shape: it is what the delegation schema offers the model,
   * and the data layer re-checks it as the durable guard.
   */
  maxSubtasks: number;
  session: SessionConfig;
}

/** The two ids an agent must choose for itself. Core has no opinion. */
export type RequiredModelIds = Pick<
  ModelConfig,
  "chatModelId" | "fallbackChatModelId"
>;

/**
 * The baseline, which is everything core *does* still have an opinion about.
 *
 * Note what is missing: the model pair. This type is `CoreConfig` minus those
 * two ids precisely so that no value of it can supply them — a default nobody
 * declared is how an agent ends up billing a model its author never chose.
 */
export type CoreConfigBaseline = Omit<CoreConfig, "model"> & {
  model: Omit<ModelConfig, keyof RequiredModelIds>;
};

/**
 * A working baseline. Every value is overridable; none is a ceiling. These are
 * the values both predecessor agents converged on in production, so they are a
 * reasonable place to start rather than an opinion about your domain.
 *
 * **It carries no model ids.** See {@link ModelConfig.chatModelId}.
 */
export const DEFAULT_CORE_CONFIG: CoreConfigBaseline = {
  model: {
    // Not a model: an AI Gateway slug, and `"default"` is Cloudflare's own
    // auto-provision behaviour rather than a choice core is making for anyone.
    aiGatewayId: "default",
    maxOutputTokens: 16_384,
    reasoningEffort: "medium"
  },
  mainAgentLimits: { maxTurns: 20, maxWallMs: 60 * 60_000 },
  subagentLimits: { maxTurns: 20, maxWallMs: 30 * 60_000 },
  toolOutputWindow: 4,
  roundObservationWindow: 2,
  maxSubtasks: 8,
  session: {
    memoryMaxTokens: 1200,
    compactAfterTokens: 16_000,
    compactTailTokens: 5_000,
    memoryDescription:
      "Durable facts worth remembering across all of this caller's conversations — " +
      "stable preferences, decisions, people, and context. Keep it concise."
  }
};

/**
 * One level of optionality per nested group — enough for a config this shallow.
 *
 * `model` is the exception, and deliberately not optional: an agent must name
 * its own primary and fallback. That is a compile error rather than a runtime
 * one, so the omission is found while writing the agent rather than on the first
 * request it serves.
 */
export type CoreConfigOverrides = {
  [K in Exclude<keyof CoreConfig, "model">]?: CoreConfig[K] extends object
    ? Partial<CoreConfig[K]>
    : CoreConfig[K];
} & {
  /** Required: the two model ids, plus any generation setting you want changed. */
  model: RequiredModelIds & Partial<Omit<ModelConfig, keyof RequiredModelIds>>;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Merge overrides onto {@link DEFAULT_CORE_CONFIG} and check the invariants that
 * are cheap to get wrong and expensive to notice.
 *
 * Called once, at DO start, and the result threaded explicitly from there. Do
 * not call it per-request: the point of resolving is that every module downstream
 * reads the same object.
 */
export function resolveConfig(overrides: CoreConfigOverrides): CoreConfig {
  const config: CoreConfig = {
    model: { ...DEFAULT_CORE_CONFIG.model, ...overrides.model },
    mainAgentLimits: {
      ...DEFAULT_CORE_CONFIG.mainAgentLimits,
      ...overrides.mainAgentLimits
    },
    subagentLimits: {
      ...DEFAULT_CORE_CONFIG.subagentLimits,
      ...overrides.subagentLimits
    },
    toolOutputWindow:
      overrides.toolOutputWindow ?? DEFAULT_CORE_CONFIG.toolOutputWindow,
    // `??`, not `||`: zero is a real choice here and means carry nothing.
    roundObservationWindow:
      overrides.roundObservationWindow ??
      DEFAULT_CORE_CONFIG.roundObservationWindow,
    maxSubtasks: overrides.maxSubtasks ?? DEFAULT_CORE_CONFIG.maxSubtasks,
    session: { ...DEFAULT_CORE_CONFIG.session, ...overrides.session }
  };

  const positive = (value: number, name: string): void => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${name} must be a positive number, got ${value}`);
    }
  };

  // The type already requires both ids; this catches the JavaScript consumer,
  // the `as CoreConfigOverrides` cast, and the empty string — which typechecks
  // and then reaches Workers AI as a model that does not exist, failing on the
  // first generation with a binding error that names nothing useful.
  const modelId = (value: string, name: string): void => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigError(
        `model.${name} is required and must be a non-empty model id — core ` +
          `ships no default, because which model an agent runs on is the agent's ` +
          `most consequential choice and cannot be made on its behalf`
      );
    }
  };

  modelId(config.model.chatModelId, "chatModelId");
  modelId(config.model.fallbackChatModelId, "fallbackChatModelId");

  // A fallback identical to the primary is a retry wearing a costume: it shares
  // the outage, the rate limit and the deprecation you are falling back from.
  if (config.model.chatModelId === config.model.fallbackChatModelId) {
    throw new ConfigError(
      `model.fallbackChatModelId must differ from model.chatModelId (both are ` +
        `'${config.model.chatModelId}') — a same-model fallback shares every ` +
        `failure mode you are falling back from`
    );
  }

  positive(config.mainAgentLimits.maxTurns, "mainAgentLimits.maxTurns");
  positive(config.mainAgentLimits.maxWallMs, "mainAgentLimits.maxWallMs");
  positive(config.subagentLimits.maxTurns, "subagentLimits.maxTurns");
  positive(config.subagentLimits.maxWallMs, "subagentLimits.maxWallMs");
  positive(config.toolOutputWindow, "toolOutputWindow");
  positive(config.maxSubtasks, "maxSubtasks");
  positive(config.model.maxOutputTokens, "model.maxOutputTokens");

  // Zero is legal here too, and means the same as it does above: carry nothing,
  // and a round renders exactly as it did before observations existed. So this is
  // not `positive` — but it *is* an integer count of rounds, and a fractional one
  // would silently read a different number of rows than it named.
  if (
    !Number.isInteger(config.roundObservationWindow) ||
    config.roundObservationWindow < 0
  ) {
    throw new ConfigError(
      `roundObservationWindow must be a non-negative integer, got ` +
        `${config.roundObservationWindow} — 0 carries nothing between rounds`
    );
  }

  // See SessionConfig.compactTailTokens — below this gap the fixed floor eats
  // the headroom and compaction fires on nearly every append.
  const headroom =
    config.session.compactAfterTokens - config.session.compactTailTokens;
  if (headroom < 10_000) {
    throw new ConfigError(
      `session.compactAfterTokens - session.compactTailTokens must be >= 10000, got ${headroom}. ` +
        "Lower compactTailTokens along with compactAfterTokens."
    );
  }

  return config;
}
