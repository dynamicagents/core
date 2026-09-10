import { describe, it, expect, vi } from "vitest";
import { TEST_MODELS } from "../testing/fixtures.js";
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createAgentRuntime, RuntimeSetupError } from "./index.js";
import { deterministicSessionMessage } from "../agent/history.js";
import { buildRecipeTools, collectToolFamilies } from "./tool-families.js";
import {
  definePlugin,
  restrictMainAgentTools,
  PLUGIN_CONTRACT_VERSION,
  type AgentPlugin,
  type MainAgentToolContext,
  type ToolFamilyContext
} from "../contract/plugin.js";
import type { SessionLike } from "../agent/session.js";
import { memoryWorkspaceBacking } from "../subagent/workspace.js";
import { DEFAULT_CORE_CONFIG } from "../config.js";
import type { ResolvedRecipe, SubtaskTypeSpec } from "../contract/recipe.js";

/**
 * `createAgentRuntime` is the load-bearing refactor this package exists for: the
 * predecessor resolved its recipe registry, tool-family map and delegate schema
 * at *module import*, which froze them before `env` exists and pulled every
 * domain into every bundle. Everything that used to be a module constant is now
 * a field on an object built once per DO instance.
 *
 * These specs cover the part a plugin author feels: what the runtime refuses at
 * startup, and what it composes when the plugins agree.
 */

const recipe = (key: string): ResolvedRecipe => ({
  key,
  version: 1,
  soul: `You are the ${key} subagent.`,
  toolFamilies: [],
  enabled: true,
  limits: {},
  historyWindow: 10,
  reportMetrics: false
});

const subtaskType = (key: string): SubtaskTypeSpec => ({
  key,
  description: `does ${key} things`,
  params: z.object({ targetId: z.string().describe("the thing to act on") }),
  capability: `You can delegate ${key} work.`,
  recipe: recipe(key)
});

const noopFamily = (name: string) => () => ({
  tools: { [name]: tool({ description: name, inputSchema: z.object({}) }) }
});

/**
 * A `MainAgentToolContext` over a session stub. Only `getCompactions` is ever
 * read by these specs — it is the one fact a plugin cannot get from config,
 * which is the whole reason the context exists.
 */
const toolCtx = (compactions: unknown[] = []): MainAgentToolContext => ({
  session: {
    getCompactions: async () => compactions
  } as unknown as SessionLike
});

/** The options the SDK passes a tool's `execute`. */
const executeOptions = (abortSignal: AbortSignal) => ({
  toolCallId: "call-1",
  messages: [],
  context: undefined,
  abortSignal
});

describe("createAgentRuntime — what it refuses at startup", () => {
  it("refuses two plugins claiming the same key", () => {
    const a = definePlugin({ key: "dup" });
    const b = definePlugin({ key: "dup" });

    expect(() =>
      createAgentRuntime({ config: { model: TEST_MODELS }, plugins: [a, b] })
    ).toThrow(RuntimeSetupError);
    expect(() =>
      createAgentRuntime({ config: { model: TEST_MODELS }, plugins: [a, b] })
    ).toThrow(/dup/);
  });

  it("refuses a plugin built against a different contract version", () => {
    // The three-repo publish train's failure mode: core and plugins ship from
    // separate repos, so one can lag. This must fail at DO start, naming both
    // versions, rather than as a structural-type mismatch several frames away.
    const stale: AgentPlugin = {
      key: "stale",
      contractVersion: PLUGIN_CONTRACT_VERSION + 1
    };

    expect(() =>
      createAgentRuntime({ config: { model: TEST_MODELS }, plugins: [stale] })
    ).toThrow(/contract v|speaks v/);
  });

  it("refuses two plugins registering the same tool family", () => {
    const a = definePlugin({
      key: "a",
      toolFamilies: { shared: noopFamily("one") }
    });
    const b = definePlugin({
      key: "b",
      toolFamilies: { shared: noopFamily("two") }
    });

    expect(() =>
      createAgentRuntime({ config: { model: TEST_MODELS }, plugins: [a, b] })
    ).toThrow(/"shared".*"a".*"b"/s);
  });

  it("refuses a missing binding only when env is supplied to check against", () => {
    const needsKey = definePlugin({
      key: "needy",
      requires: { secrets: ["SOME_API_KEY"] }
    });

    // Core cannot know which of a consumer's bindings are optional, so the
    // check is opt-in.
    expect(() =>
      createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [needsKey]
      })
    ).not.toThrow();

    expect(() =>
      createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [needsKey],
        env: {}
      })
    ).toThrow(/SOME_API_KEY.*needy/s);

    // An empty string is a missing secret, not a present one — this is the
    // shape a `wrangler secret` that was never set actually takes.
    expect(() =>
      createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [needsKey],
        env: { SOME_API_KEY: "" }
      })
    ).toThrow(/SOME_API_KEY/);

    expect(() =>
      createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [needsKey],
        env: { SOME_API_KEY: "sk-1" }
      })
    ).not.toThrow();
  });
});

describe("createAgentRuntime — what it composes", () => {
  const alpha = definePlugin({
    key: "alpha",
    subtaskType: subtaskType("alpha"),
    toolFamilies: { alphaTools: noopFamily("alphaTool") },
    capability: "Alpha capability block.",
    mainAgentTools: () => ({
      alphaLookup: tool({ description: "lookup", inputSchema: z.object({}) })
    }),
    store: { plugin: "alpha", version: 1, ensureTables: () => {} }
  });

  const beta = definePlugin({
    key: "beta",
    subtaskType: subtaskType("beta"),
    capability: "Beta capability block."
  });

  it("builds the type registry, family map and stores from the plugin list", () => {
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [alpha, beta]
    });

    expect(rt.types.keys).toEqual(["alpha", "beta"]);
    expect([...rt.toolFamilies.keys()]).toEqual(["alphaTools"]);
    expect(rt.stores.map((s) => s.plugin)).toEqual(["alpha"]);
    expect(rt.plugins).toHaveLength(2);
  });

  it("derives the recipe policy's legal tool families from what is installed", () => {
    // The predecessor hardcoded `KNOWN_TOOL_FAMILIES` as a literal Set naming
    // three families, one of them a domain's. The legal set is now exactly what
    // the installed plugins registered.
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [alpha, beta]
    });

    expect([...rt.policy.knownToolFamilies]).toEqual(["alphaTools"]);
    // The pair every recipe runs on is the host's, carried on the policy.
    expect(rt.policy.primaryModelId).toBe(TEST_MODELS.chatModelId);
  });

  it("routes lifecycle hooks to the plugin owning the subtask type", async () => {
    const withHooks = definePlugin<{ leased?: string }>({
      key: "leases",
      subtaskType: subtaskType("leased-work"),
      resolveRuntime: async () => ({ leased: "resource-1" }),
      enrichResult: async (_ctx, result) => ({ ...result, enriched: true })
    });

    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [withHooks, beta]
    });
    const ctx = {
      taskId: "t1",
      subtaskId: 1,
      type: "leased-work",
      params: {},
      toolFamilies: []
    };

    expect(rt.pluginForType("leased-work")?.key).toBe("leases");
    expect(await rt.resolveRuntime(ctx)).toEqual({ leased: "resource-1" });

    // A type whose plugin declares no hook gets the neutral value, not a throw.
    expect(await rt.resolveRuntime({ ...ctx, type: "beta" })).toEqual({});
    // …and neither does a type no plugin owns at all.
    expect(await rt.resolveRuntime({ ...ctx, type: "nobody" })).toEqual({});
    await expect(
      rt.onAbort({ ...ctx, type: "nobody" })
    ).resolves.toBeUndefined();
  });

  it("merges main-agent tools and capability blocks across plugins", async () => {
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [alpha, beta]
    });

    expect(Object.keys(await rt.mainAgentTools(toolCtx()))).toEqual([
      "alphaLookup"
    ]);
    // Plugin declaration order, with each plugin's own block and its type's
    // adjacent. Both fixtures declare both, which the contract advises against
    // for exactly the reason this ordering makes visible: the main agent reads
    // two introductions to one domain.
    expect(rt.renderCapabilities()).toBe(
      [
        "Alpha capability block.",
        "You can delegate alpha work.",
        "Beta capability block.",
        "You can delegate beta work."
      ].join("\n\n")
    );
  });

  it("hands plugins the round's signal, and bounds every tool they return", async () => {
    let seen: AbortSignal | undefined;
    const execute = vi.fn(async () => "acted");
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        definePlugin({
          key: "gamma",
          mainAgentTools: (ctx) => {
            seen = ctx.signal;
            return {
              act: tool({
                description: "act",
                inputSchema: z.object({}),
                execute
              })
            };
          }
        })
      ]
    });
    const round = new AbortController();

    const tools = await rt.mainAgentTools({
      ...toolCtx(),
      signal: round.signal
    });

    expect(seen).toBe(round.signal);
    // Only the wrapper declines to start a call whose signal has already fired,
    // so a call that never reaches `execute` is one that went through it.
    round.abort();
    await expect(
      tools.act!.execute!({}, executeOptions(round.signal))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("renders a capability block declared only on a plugin's subtask type", () => {
    // The contract tells a plugin with a subtask type to declare its block on
    // the *type* and leave `AgentPlugin.capability` unset. Following that advice
    // has to reach the soul, or the block is written and never read.
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        definePlugin({ key: "gamma", subtaskType: subtaskType("gamma") })
      ]
    });

    expect(rt.renderCapabilities()).toBe("You can delegate gamma work.");
  });

  it("awaits a plugin that shapes its tool surface from session state", async () => {
    // The reason `mainAgentTools` may be async at all. A tool whose only possible
    // answer is "nothing archived yet" costs the model a call to discover that,
    // and costs every round the tokens to describe it — so a plugin gets to ask
    // the session before deciding whether to offer one.
    const archival = definePlugin({
      key: "archival",
      mainAgentTools: async (ctx): Promise<ToolSet> =>
        (await ctx.session.getCompactions()).length > 0
          ? { search: tool({ description: "s", inputSchema: z.object({}) }) }
          : {}
    });
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [alpha, archival]
    });

    expect(Object.keys(await rt.mainAgentTools(toolCtx()))).toEqual([
      "alphaLookup"
    ]);
    expect(
      Object.keys(await rt.mainAgentTools(toolCtx([{ id: "c1" }])))
    ).toEqual(["alphaLookup", "search"]);
  });

  it("returns an empty capability string when no plugin declares one", () => {
    // Named because it is what lets a call site append unconditionally instead
    // of emitting a separator around nothing.
    const rt = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [definePlugin({ key: "bare" })]
    });
    expect(rt.renderCapabilities()).toBe("");
  });

  describe("shouldHandleTurn", () => {
    // The gate exists because "should I answer this?" degrades when it is asked
    // of a model already trying to be helpful — and degrades *invisibly*, since
    // failing to call a decline-tool looks identical to deciding not to.
    const ctx = {
      history: [deterministicSessionMessage("m1", "user", "hi all")]
    };
    const gate = (key: string, answer: boolean) =>
      definePlugin({ key, shouldHandleTurn: async () => answer });

    it("handles the turn when no plugin declares a gate", async () => {
      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [alpha, beta]
      });
      expect(await rt.shouldHandleTurn(ctx)).toBe(true);
    });

    it("declines when any single gate declines", async () => {
      // AND, not majority or first-wins: a plugin installed to keep the agent
      // quiet in a busy channel has to be able to keep it quiet on its own.
      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [gate("permissive", true), gate("triage", false)]
      });
      expect(await rt.shouldHandleTurn(ctx)).toBe(false);
    });

    it("consults every gate and handles the turn when all agree", async () => {
      const asked: string[] = [];
      const recording = (key: string) =>
        definePlugin({
          key,
          shouldHandleTurn: async () => {
            asked.push(key);
            return true;
          }
        });

      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [recording("one"), beta, recording("two")]
      });
      expect(await rt.shouldHandleTurn(ctx)).toBe(true);
      expect(asked).toEqual(["one", "two"]);
    });

    it("fails open when a gate rejects", async () => {
      // The asymmetry this whole hook is designed around: a wrong reply is noise
      // the user sees and ignores, a wrong silence is invisible to the person who
      // needed an answer. So a broken gate must degrade to the previous
      // behaviour — run the turn — and never to a mute agent.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          definePlugin({
            key: "broken",
            shouldHandleTurn: async () => {
              throw new Error("classifier model unavailable");
            }
          })
        ]
      });

      expect(await rt.shouldHandleTurn(ctx)).toBe(true);
      expect(warn.mock.calls[0][0]).toContain("broken");
      warn.mockRestore();
    });

    it("fails open on a gate that throws synchronously, and still consults the rest", async () => {
      // A gate is typed `(ctx) => Promise<boolean>`, which does not oblige it to
      // be `async`. One that reads a binding before its first await throws during
      // the `.map()` that builds the promise array — before `allSettled` exists
      // to catch it — which would both reject this method and abort the
      // iteration, skipping every gate declared after the thrower.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let consulted = false;

      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          definePlugin({
            key: "sync-thrower",
            // Deliberately not `async` — that would convert the throw into a
            // rejection for free and reproduce nothing.
            shouldHandleTurn: () => {
              throw new Error("AI binding undefined");
            }
          }),
          definePlugin({
            key: "downstream",
            shouldHandleTurn: async () => {
              consulted = true;
              return false;
            }
          })
        ]
      });

      // The thrower is counted as `true`; the gate after it still gets to
      // decline, which is the assertion that matters.
      expect(await rt.shouldHandleTurn(ctx)).toBe(false);
      expect(consulted).toBe(true);
      expect(warn.mock.calls[0][0]).toContain("sync-thrower");
      warn.mockRestore();
    });
  });

  describe("workspaceBacking", () => {
    const backing = (key: string) =>
      definePlugin({ key, workspaceBacking: () => memoryWorkspaceBacking() });

    it("falls back to an in-memory backing when no plugin declares one", async () => {
      // Always defined, so `SubagentRuntime.workspaceBacking` stays required and
      // a host never writes a null check for a capability it did not install.
      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [alpha, beta]
      });
      const ws = rt.workspaceBacking({} as SqlStorage, () => "child");

      await ws.writeFile("notes.md", "hello");
      expect(await ws.readFile("notes.md")).toBe("hello");
      expect(await ws.getWorkspaceInfo()).toEqual({ fileCount: 1 });
    });

    it("uses the one a plugin declares, with the facet's own sql and name", async () => {
      const seen: Array<{ sql: SqlStorage; name: string | undefined }> = [];
      const sql = {} as SqlStorage;
      const declared = definePlugin({
        key: "workspace",
        workspaceBacking: (s, name) => {
          seen.push({ sql: s, name: name() });
          const ws = memoryWorkspaceBacking();
          void ws.writeFile("marker", "from the declared backing");
          return ws;
        }
      });

      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [alpha, declared]
      });
      const ws = rt.workspaceBacking(sql, () => "subtask:t1:1");

      expect(await ws.readFile("marker")).toBe("from the declared backing");
      // Both arguments reach the plugin: the executing facet's *own* SQLite (so
      // isolation per execution is free) and its lazily-read name.
      expect(seen).toEqual([{ sql, name: "subtask:t1:1" }]);
    });

    it("refuses two plugins declaring a backing", () => {
      // Two backends means two answers to "where did that file go", and the file
      // lands in whichever the runtime happened to pick.
      expect(() =>
        createAgentRuntime({
          config: { model: TEST_MODELS },
          plugins: [backing("shell"), backing("r2")]
        })
      ).toThrow(RuntimeSetupError);
      expect(() =>
        createAgentRuntime({
          config: { model: TEST_MODELS },
          plugins: [backing("shell"), backing("r2")]
        })
      ).toThrow(/shell.*r2|r2.*shell/);
    });
  });

  describe("onMessagesDisplaced", () => {
    // Compaction is lossy and core is what performs it, so the announcement is
    // core's to make. What a plugin does with the messages is its own business.
    const displaced: SessionMessage[] = [
      deterministicSessionMessage("m1", "user", "one"),
      deterministicSessionMessage("m2", "assistant", "two")
    ];

    it("fans out to every plugin declaring the hook", async () => {
      const seen: Record<string, string[]> = {};
      const listener = (key: string) =>
        definePlugin({
          key,
          onMessagesDisplaced: async (messages) => {
            seen[key] = messages.map((m) => m.id);
          }
        });

      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [listener("one"), beta, listener("two")]
      });
      await rt.onMessagesDisplaced(displaced);

      expect(seen).toEqual({ one: ["m1", "m2"], two: ["m1", "m2"] });
    });

    it("still delivers to the others when one plugin rejects", async () => {
      // The `allSettled` property. A `Promise.all` here fails this twice over:
      // it rejects the aggregate at the first throw, and it stops awaiting the
      // rest — so the healthy plugin's write is still in flight when the
      // wrapper returns, and on a DO the isolate can be evicted before it
      // lands. The healthy listener defers past a macrotask precisely so this
      // test can tell the two apart.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let delivered: string[] = [];

      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          definePlugin({
            key: "broken",
            onMessagesDisplaced: async () => {
              throw new Error("store unavailable");
            }
          }),
          definePlugin({
            key: "healthy",
            onMessagesDisplaced: async (messages) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              delivered = messages.map((m) => m.id);
            }
          })
        ]
      });

      await expect(rt.onMessagesDisplaced(displaced)).resolves.toBeUndefined();
      expect(delivered).toEqual(["m1", "m2"]);

      // Logged against the key that caused it — an anonymous aggregate is not
      // debuggable across installed plugins.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][0]).toContain("broken");
      errors.mockRestore();
    });

    it("survives a listener that throws synchronously instead of rejecting", async () => {
      // The contract types a listener `(messages) => Promise<void>`, which does
      // not oblige it to be `async`. A plugin that touches a binding before
      // starting its async work — `env.VECTORIZE.upsert(…)` on an undefined
      // binding — throws during the `.map()` that builds the promise array,
      // before `Promise.allSettled` exists to catch it.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let delivered: string[] = [];

      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          definePlugin({
            key: "sync-thrower",
            // Deliberately not `async`: an async function converts a sync throw
            // into a rejection for free, so it cannot reproduce this at all.
            onMessagesDisplaced: () => {
              throw new Error("VECTORIZE binding undefined");
            }
          }),
          definePlugin({
            key: "downstream",
            onMessagesDisplaced: async (messages) => {
              delivered = messages.map((m) => m.id);
            }
          })
        ]
      });

      await expect(rt.onMessagesDisplaced(displaced)).resolves.toBeUndefined();

      // The assertion that matters. An aborted `.map()` never invokes the
      // listeners *after* the thrower — worse than `Promise.all`, which at
      // least starts them all before rejecting.
      expect(delivered).toEqual(["m1", "m2"]);
      expect(errors.mock.calls[0][0]).toContain("sync-thrower");
      errors.mockRestore();
    });

    it("resolves cleanly when no plugin declares it", async () => {
      const rt = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [alpha, beta]
      });
      await expect(rt.onMessagesDisplaced(displaced)).resolves.toBeUndefined();
    });
  });

  it("applies config overrides over the defaults", () => {
    const rt = createAgentRuntime({
      plugins: [],
      config: {
        maxSubtasks: 3,
        model: { ...TEST_MODELS, chatModelId: "@cf/custom/model" }
      }
    });

    expect(rt.config.maxSubtasks).toBe(3);
    expect(rt.config.model.chatModelId).toBe("@cf/custom/model");
    // Untouched groups still come from the baseline.
    expect(rt.config.subagentLimits).toEqual(
      DEFAULT_CORE_CONFIG.subagentLimits
    );
  });

  it("takes the model pair from the agent, never from a baseline", () => {
    // The baseline has no model ids to fall back to — that is the point, and it
    // is checked structurally here so a future edit cannot quietly restore one.
    expect(DEFAULT_CORE_CONFIG.model).not.toHaveProperty("chatModelId");
    expect(DEFAULT_CORE_CONFIG.model).not.toHaveProperty("fallbackChatModelId");

    const rt = createAgentRuntime({
      plugins: [],
      config: { model: TEST_MODELS }
    });
    expect(rt.config.model.chatModelId).toBe(TEST_MODELS.chatModelId);
    // The pair every recipe runs on is carried straight through to the policy —
    // there is no allowlist, because there is nothing for a recipe to select.
    expect(rt.policy.primaryModelId).toBe(TEST_MODELS.chatModelId);
    expect(rt.policy.fallbackModelId).toBe(TEST_MODELS.fallbackChatModelId);
    // …and stays distinct, so the fallback is never a retry of the primary.
    expect(rt.policy.primaryModelId).not.toBe(rt.policy.fallbackModelId);
  });
});

describe("buildRecipeTools", () => {
  const ctx = {} as ToolFamilyContext;

  it("merges the named families and reports names nobody registered", () => {
    const registry = collectToolFamilies([
      { key: "p", toolFamilies: { one: noopFamily("toolOne") } }
    ]);

    const built = buildRecipeTools(["one", "missing"], registry, ctx);

    expect(Object.keys(built.tools)).toEqual(["toolOne"]);
    // Skipped rather than thrown: a subagent running with fewer tools degrades
    // better than a whole branch failing, and the caller can log the names.
    expect(built.skipped).toEqual(["missing"]);
  });

  it("composes every family's abort hook into one", async () => {
    const ran: string[] = [];
    const family = (name: string) => () => ({
      tools: {},
      abort: async () => {
        ran.push(name);
      }
    });
    const registry = collectToolFamilies([
      { key: "p", toolFamilies: { a: family("a"), b: family("b") } }
    ]);

    const built = buildRecipeTools(["a", "b"], registry, ctx);
    await built.abort?.(ctx);

    expect(ran).toEqual(["a", "b"]);
  });

  it("leaves abort undefined when no family declared one", () => {
    const registry = collectToolFamilies([
      { key: "p", toolFamilies: { plain: noopFamily("t") } }
    ]);

    expect(buildRecipeTools(["plain"], registry, ctx).abort).toBeUndefined();
  });

  it("hands each family the chunk's signal, and bounds every tool it returns", async () => {
    let seen: AbortSignal | undefined;
    const execute = vi.fn(async () => "acted");
    const registry = collectToolFamilies([
      {
        key: "p",
        toolFamilies: {
          act: (c: ToolFamilyContext) => {
            seen = c.signal;
            return {
              tools: {
                act: tool({
                  description: "act",
                  inputSchema: z.object({}),
                  execute
                })
              }
            };
          }
        }
      }
    ]);
    const chunk = new AbortController();
    chunk.abort();

    const built = buildRecipeTools(["act"], registry, {
      ...ctx,
      signal: chunk.signal
    });

    expect(seen).toBe(chunk.signal);
    // See the main-agent case: never reaching `execute` is the wrapper's mark.
    await expect(
      built.tools.act!.execute!({}, executeOptions(chunk.signal))
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("restrictMainAgentTools", () => {
  /** A plugin with a full surface: three main-agent tools, a family, a binding. */
  const sandboxish = (): AgentPlugin =>
    definePlugin({
      key: "sandboxish",
      mainAgentTools: () =>
        ({
          sb_exec: tool({ description: "run", inputSchema: z.object({}) }),
          sb_read: tool({ description: "read", inputSchema: z.object({}) }),
          sb_write: tool({ description: "write", inputSchema: z.object({}) })
        }) satisfies ToolSet,
      toolFamilies: { sandbox: noopFamily("sb_exec") },
      capability: "You can run anything.",
      requires: { bindings: ["Sandbox"] }
    });

  it("keeps only the allowed tools and swaps the capability block", async () => {
    const runtime = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [
        restrictMainAgentTools(sandboxish(), {
          allow: ["sb_read"],
          capability: "You can read, not write."
        })
      ]
    });

    expect(Object.keys(await runtime.mainAgentTools(toolCtx()))).toEqual([
      "sb_read"
    ]);
    // The plugin's own block advertises `sb_exec`, which the parent no longer
    // has — leaving it in place is how a model spends a turn calling a tool
    // that is not there.
    expect(runtime.renderCapabilities()).toBe("You can read, not write.");
  });

  /**
   * The whole reason this helper exists rather than "just don't install it".
   *
   * `validateRecipe` runs on the parent, so a family the parent does not
   * register is dropped from every recipe the parent validates — and the
   * subagent loses a capability nobody meant to take away.
   */
  it("keeps the tool family and the binding requirement registered", () => {
    const runtime = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [restrictMainAgentTools(sandboxish(), { allow: [] })]
    });

    expect([...runtime.policy.knownToolFamilies]).toEqual(["sandbox"]);
    expect(runtime.requirements.bindings).toEqual(["Sandbox"]);
  });

  it("removes the main-agent surface and the capability block entirely on an empty allowlist", async () => {
    const runtime = createAgentRuntime({
      config: { model: TEST_MODELS },
      plugins: [restrictMainAgentTools(sandboxish(), { allow: [] })]
    });

    expect(await runtime.mainAgentTools(toolCtx())).toEqual({});
    expect(runtime.renderCapabilities()).toBe("");
  });

  it("logs the plugin and tool name when the allowlist names a tool that is gone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          restrictMainAgentTools(sandboxish(), {
            allow: ["sb_read", "sb_renamed"],
            capability: "read only"
          })
        ]
      });

      // The surviving tool still comes through: one typo must not take the
      // others with it.
      expect(Object.keys(await runtime.mainAgentTools(toolCtx()))).toEqual([
        "sb_read"
      ]);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/sandboxish.*sb_renamed/s)
      );
    } finally {
      error.mockRestore();
    }
  });

  /**
   * The silent case: a plugin that offers no main-agent surface at all. Every
   * allowed name is missing, so every one is reported — this is what a removed
   * or renamed `mainAgentTools` looks like, and reporting nothing would make a
   * whole capability disappear with no trace.
   */
  it("logs every allowed name when the plugin has no main-agent tools at all", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runtime = createAgentRuntime({
        config: { model: TEST_MODELS },
        plugins: [
          restrictMainAgentTools(
            definePlugin({
              key: "surfaceless",
              toolFamilies: { sandbox: noopFamily("sb_exec") }
            }),
            { allow: ["sb_read", "sb_exists"] }
          )
        ]
      });

      expect(await runtime.mainAgentTools(toolCtx())).toEqual({});
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/surfaceless.*sb_read/s)
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/surfaceless.*sb_exists/s)
      );
    } finally {
      error.mockRestore();
    }
  });

  it("does not mutate the plugin it was given", async () => {
    const original = sandboxish();
    restrictMainAgentTools(original, { allow: [] });

    expect(original.capability).toBe("You can run anything.");
    expect(Object.keys(await original.mainAgentTools!(toolCtx()))).toHaveLength(
      3
    );
  });
});
