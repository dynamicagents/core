import { describe, it, expect } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { FINAL_REPLY_TOOL_NAME } from "../agent/final-reply.js";
import { DELEGATE_TOOL_NAME } from "../subtasks/delegate.js";
import { makeSubtaskTypes } from "../subtasks/index.js";
import { newTurnBudget } from "../agent/index.js";
import type { ModelPair } from "../agent/index.js";
import type { CompositionBranch } from "../subtasks/index.js";
import type { SubtaskTypeSpec } from "../contract/recipe.js";
import { FakeSession } from "../testing/fake-session.js";
import {
  countingModel,
  finalReply,
  mockModel,
  inspectingModel,
  rateLimitedModel,
  throwingModel
} from "../testing/mock-model.js";
import { CredentialRejectedError } from "../agent/errors.js";
import { TEST_MODELS } from "../testing/fixtures.js";
import {
  buildTurnInstructions,
  joinSuccessfulBranches,
  renderTurnMessages,
  runTurn,
  type RunTurnArgs
} from "./turn.js";
import { captureObservations } from "./observations.js";
import type { RoundPolicy } from "./policy.js";

/**
 * The round loop.
 *
 * ## Why this file is here
 *
 * These assertions lived in starter, back when the loop itself did.
 * Moving the loop into core deleted them and re-landed nothing, so the entire
 * primary→fallback→repair ladder shipped from a published package with no
 * coverage at all — and the suite stayed green throughout, because the tests
 * left with the code they covered. That is the failure mode a refactor is most
 * prone to and least likely to notice: **coverage does not move with code
 * unless someone moves it.**
 *
 * Core ships no prompt copy, so the fixture below supplies a {@link RoundPolicy}
 * the way an agent does.
 *
 * What they pin is the part with no second chance at runtime: a round that
 * reaches no ending must cost the budget it spent, fall back to the other
 * model, and — when both models fail — still deliver durable branch results
 * rather than throwing away work the user asked for and paid for.
 */

/**
 * A stand-in for a plugin-declared type. Core cannot import the starter's, and
 * should not: what these specs need is *a* type with a name, so the contract
 * can be checked for naming exactly the installed ones.
 */
const generalType: SubtaskTypeSpec = {
  key: "general",
  description: "General research or writing work.",
  params: z.object({}),
  capability: "You can delegate general work.",
  recipe: {
    key: "general",
    version: 1,
    soul: "You are a general subagent.",
    toolFamilies: [],
    enabled: true,
    limits: {},
    historyWindow: 10,
    reportMetrics: false
  }
};

const types = makeSubtaskTypes([generalType]);

/**
 * Policy in the shape the interface documents: every prompt string opens on a
 * blank line, because the composition concatenates these directly onto the soul
 * and the caller context and adds no separator of its own.
 */
const policy: RoundPolicy = {
  roundContract: ({ typeKeys, maxSubtasks }) => `

# Answering this request

You may delegate up to ${maxSubtasks} subtasks, each of type ${typeKeys
    .map((k) => `"${k}"`)
    .join(", ")}, or answer with final_reply.`,
  finalRoundNote: (limits, reason) =>
    reason === "no-progress"
      ? `

# The work is not getting anywhere

Every recent attempt came back failing the same way. Call final_reply now, say
plainly what could not be done, and give the user the rest.`
      : `

# Your budget is spent

You have used this task's full budget of ${limits.maxTurns} turns. Call
final_reply now with what you have.`,
  copy: {
    taskFailed: "Sorry — something went wrong handling that request.",
    recoveredReply: "Working on your request.",
    partialNote: "Some parts of this request could not be completed."
  }
};

const instructions = buildTurnInstructions(policy, types, 8, {
  maxTurns: 20,
  maxWallMs: 60_000
});

/** A model pair whose two slots can be scripted independently. */
function pair(primary: ReturnType<typeof mockModel>, fallback = primary) {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => TEST_MODELS.chatModelId,
    fallbackId: () => TEST_MODELS.fallbackChatModelId
  } as unknown as ModelPair;
}

function args(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    session: new FakeSession(),
    taskId: "t1",
    round: 0,
    text: "hello",
    mode: "open",
    budget: newTurnBudget(20),
    systemSuffix: "",
    tools: {},
    models: pair(mockModel(finalReply("done"))),
    branches: [],
    types,
    maxSubtasks: 8,
    maxOutputTokens: 4096,
    // Zero, so the ladder specs below count model *calls* the way they mean to:
    // a retry is invisible to `countingModel` as anything but another call, and
    // these assertions are about the primary→fallback→repair shape.
    maxRetries: 0,
    instructions,
    partialNote: policy.copy.partialNote,
    ...overrides
  };
}

describe("the round contract", () => {
  it("names every installed subtask type, and only those", () => {
    expect(instructions.open).toContain('"general"');
    // The enum is what the model may emit; a type nobody installed must not
    // appear in the prose either, or the model is invited to name it.
    expect(instructions.open).not.toContain('"arc-game"');
  });

  it("tells a budget-spent round it has no way out but answering", () => {
    expect(instructions.final.budget).toContain("Your budget is spent");
    expect(instructions.final.budget).toContain("final_reply");
    // Names the budget as a fact rather than as a withheld capability — a model
    // told "you cannot delegate" tries to route around it.
    expect(instructions.final.budget).toContain("20 turns");
  });

  it("tells a stalled round the truth instead of the budget's words", () => {
    // The whole reason the reason exists. This round has turns left; what it has
    // run out of is progress, and a model told its budget was spent would pass
    // that on to the user as the explanation for a task that failed for an
    // entirely different reason.
    const note = instructions.final["no-progress"];
    expect(note).toContain("not getting anywhere");
    expect(note).toContain("final_reply");
    expect(note).not.toContain("Your budget is spent");
  });

  it("keeps every final round a superset of the open one", () => {
    // `final` is `open + note`, so the model still has the contract it needs to
    // call `final_reply` correctly. A `final` that replaced the contract would
    // leave the round with an instruction and no schema.
    for (const note of Object.values(instructions.final)) {
      expect(note.startsWith(instructions.open)).toBe(true);
    }
  });

  it("separates the note from the contract it is appended to", () => {
    // Core adds nothing between these two independently-owned sections — see
    // `RoundPolicy`. This asserts the documented contract holds for a policy
    // that follows it, so the doc and the composition cannot drift apart.
    for (const note of Object.values(instructions.final)) {
      const seam = note.slice(instructions.open.length);
      expect(seam.startsWith("\n\n")).toBe(true);
    }
  });
});

describe("runTurn", () => {
  it("appends the user turn once, under a deterministic id", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));
    // A Workflow step re-runs; a second append under the same id must not
    // duplicate the turn.
    await runTurn(args({ session, round: 0 }));

    const users = session.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
  });

  it("charges the budget for every step, including a failed attempt", async () => {
    const budget = newTurnBudget(20);
    // Prose with no control call is not an ending: the attempt fails and the
    // fallback gets its turn. Both slots spent real steps.
    await runTurn(
      args({
        budget,
        models: pair(mockModel({ text: "I'll get right on that" }))
      })
    );
    expect(budget.spent).toBeGreaterThanOrEqual(2);
  });

  /**
   * A rate limit is "not yet", not "this model cannot do it".
   *
   * The fallback slot answers the second question and is useless for the first
   * — worse than useless when both slots sit behind one credential, which is
   * exactly the coder's shape (Opus with Sonnet as its step-down). Production
   * showed the cost: a 429 skipped straight to the fallback, the fallback hit
   * the same limit, the round threw, the Workflow retried, and the pair
   * repeated four more times over three minutes.
   *
   * The call counts are the assertion. The outcome is a successful reply either
   * way, so only "which model was asked, and how many times" can tell a waited
   * retry from a burned fallback.
   */
  it("retries a rate-limited model in place instead of burning the fallback", async () => {
    const primary = rateLimitedModel(1, finalReply("the actual answer"));
    const fallback = countingModel(finalReply("should never be reached"));

    const outcome = await runTurn(
      args({
        maxRetries: 1,
        models: pair(primary.model, fallback.model)
      })
    );

    expect(outcome).toEqual({ status: "replied", reply: "the actual answer" });
    // Once refused, once honoured — inside a single slot.
    expect(primary.calls()).toBe(2);
    expect(fallback.calls()).toBe(0);
  });

  /** With retries off, the same 429 spends the slot — the old behaviour. */
  it("hands a rate limit to the fallback when retries are disabled", async () => {
    const primary = rateLimitedModel(1, finalReply("unreachable"));
    const fallback = countingModel(finalReply("fallback answered"));

    const outcome = await runTurn(
      args({
        maxRetries: 0,
        models: pair(primary.model, fallback.model)
      })
    );

    expect(outcome).toEqual({ status: "replied", reply: "fallback answered" });
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  it("falls back to the second model when the first reaches no ending", async () => {
    const outcome = await runTurn(
      args({
        models: pair(
          mockModel({ text: "narrating instead of acting" }),
          mockModel(finalReply("the actual answer"))
        )
      })
    );
    expect(outcome).toEqual({ status: "replied", reply: "the actual answer" });
  });

  it("delivers durable branch results when both models fail", async () => {
    // The work is done and the user asked for it; failing the task because the
    // *answering* model is down would throw away good results.
    const branches: CompositionBranch[] = [
      {
        subtaskId: 1,
        round: 0,
        ordinal: 0,
        type: "general",
        prompt: "research",
        params: {},
        status: "completed",
        resultParts: [{ kind: "text", text: "what the branch found" }],
        error: null
      }
    ];
    const outcome = await runTurn(
      args({ branches, models: pair(mockModel({ text: "no ending" })) })
    );

    expect(outcome.status).toBe("replied");
    expect(outcome).toMatchObject({ reply: "what the branch found" });
  });

  it("fails the round when both models fail with nothing durable behind them", async () => {
    const outcome = await runTurn(
      args({ models: pair(mockModel({ text: "no ending" })) })
    );
    // `exhausted` is the assertion that matters: the ladder was actually run.
    // A credential failure reaches the same status with a different kind, so
    // the status alone no longer distinguishes them.
    expect(outcome).toMatchObject({ status: "failed", kind: "exhausted" });
  });

  /**
   * The behaviour four files describe and none used to implement. Classifying a
   * rejected credential as merely "not transient" is what routes it *into* the
   * fallback slot — so the assertion that matters is not the returned status but
   * that the second model was never asked at all.
   */
  it("fails on a rejected credential without spending the fallback slot", async () => {
    const primary = throwingModel(
      new CredentialRejectedError("invalid bearer token", {
        status: 401,
        source: "provider"
      })
    );
    const fallback = countingModel(finalReply("the fallback answered"));

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toMatchObject({ status: "failed", kind: "credential" });
    // The two that matter: one attempt, and the second slot never asked. A
    // repair would show as primary > 1, a fallthrough as fallback > 0.
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(0);
  });

  /**
   * The AI Gateway in front of the provider has its own credential
   * (`cf-aig-authorization`), and rejects with the same 401. Reporting that as
   * `credential` sends an operator to rotate a Claude token that was never
   * presented to Claude — so the kind has to survive to the host, which is the
   * only place that knows what to say.
   */
  it("distinguishes an AI Gateway rejection from a provider one", async () => {
    const primary = throwingModel(
      new CredentialRejectedError("401 Unauthorized", {
        status: 401,
        source: "gateway"
      })
    );
    const fallback = countingModel(finalReply("the fallback answered"));

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toMatchObject({
      status: "failed",
      kind: "gateway-credential"
    });
    expect(fallback.calls()).toBe(0);
  });

  /**
   * A 401 whose body matched neither shape, including one that crossed a realm
   * boundary and lost its `source`. Guessing here is the whole bug.
   */
  it("reports an unclassified rejection as unknown rather than guessing", async () => {
    const primary = throwingModel(
      new CredentialRejectedError("401 Unauthorized", { status: 401 })
    );

    const outcome = await runTurn(
      args({
        models: pair(primary.model, countingModel(finalReply("x")).model)
      })
    );

    expect(outcome).toMatchObject({
      status: "failed",
      kind: "unknown-credential"
    });
  });

  /**
   * Durable branch results rescue this one exactly as they rescue a
   * deterministic double failure, and for a reason that has nothing to do with
   * the credential: the join needs no model. It filters completed rows, joins
   * their text and appends it. So the fault stops *inference*, not the round's
   * ability to return work that is already done — the operator hears about it
   * from the log, and the user is not made to pay for it.
   */
  it("still delivers the deterministic join with completed branches behind it", async () => {
    const branches: CompositionBranch[] = [
      {
        subtaskId: 1,
        round: 0,
        ordinal: 0,
        type: "general",
        prompt: "research",
        params: {},
        status: "completed",
        resultParts: [{ kind: "text", text: "what the branch found" }],
        error: null
      }
    ];
    const primary = throwingModel(
      new CredentialRejectedError("invalid bearer token", { status: 401 })
    );
    const fallback = countingModel(finalReply("the fallback answered"));

    const outcome = await runTurn(
      args({ branches, models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toMatchObject({ status: "replied" });
    expect((outcome as { reply: string }).reply).toContain(
      "what the branch found"
    );
    // The short-circuit still holds: the join is what answered, not a second
    // model attempt presenting the same dead credential.
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(0);
  });

  /**
   * The same fault with nothing durable behind it. Here the kind is the whole
   * output — there is no work to return, so what the round owes the operator is
   * an accurate reason.
   */
  it("fails with the credential kind when no branch completed", async () => {
    const primary = throwingModel(
      new CredentialRejectedError("invalid bearer token", { status: 401 })
    );

    const outcome = await runTurn(
      args({ branches: [], models: pair(primary.model) })
    );

    expect(outcome).toMatchObject({
      status: "failed",
      kind: "unknown-credential"
    });
  });
});

/**
 * What an attempt is handed — the tools it may call and the note it is given —
 * neither of which any assertion on the outcome can see.
 *
 * The tool rules have one shape and one reason: an attempt ends only on a control
 * call, and the tool loop halts on the step count just as readily, so an attempt
 * that cannot afford a tool call *and* an ending must not be offered the tool. A
 * round with one turn left that spends it on a lookup is a round that produced no
 * decision — the failure that ended a task in production on the 60th call of a
 * 60-turn budget, on both slots, for this reason alone.
 *
 * The note is the other half of a forced round: it is the model's only account of
 * why it has nothing but the answer, and therefore the user's.
 */
describe("what an attempt is handed", () => {
  const tools = {
    probe: tool({
      description: "look something up",
      inputSchema: z.object({}),
      execute: async () => "looked it up"
    })
  };

  it("withholds the work tools from a budget-spent round", async () => {
    const model = inspectingModel(finalReply("what I have"));

    await runTurn(args({ mode: "final", tools, models: pair(model.model) }));

    // Only the answer: no work tool, and no `delegate` either — a round with no
    // budget cannot hand out work it has nothing left to compose.
    expect(model.asked()[0].tools).toEqual([FINAL_REPLY_TOOL_NAME]);
  });

  it("tells a stalled round why it is answering", async () => {
    // The reason has to survive the whole path — Workflow to RPC to `runTurn` to
    // the note — because every step of it produces a round that answers, and only
    // the words say whether the user is told the truth about why.
    const model = inspectingModel(finalReply("what I have"));

    await runTurn(
      args({
        mode: "final",
        finalReason: "no-progress",
        models: pair(model.model)
      })
    );

    expect(model.asked()[0].system).toContain("not getting anywhere");
    expect(model.asked()[0].system).not.toContain("Your budget is spent");
  });

  it("treats a final round that names no reason as a spent budget", async () => {
    // The only reason core had before the guard existed, so a caller that names
    // none can mean nothing else — and an `undefined` that silently selected the
    // wrong note would be worse than a missing one.
    const model = inspectingModel(finalReply("what I have"));

    await runTurn(args({ mode: "final", models: pair(model.model) }));

    expect(model.asked()[0].system).toContain("Your budget is spent");
  });

  it("withholds them from an open round down to its last step", async () => {
    const model = inspectingModel(finalReply("answered from what I had"));

    const outcome = await runTurn(
      args({ budget: newTurnBudget(1), tools, models: pair(model.model) })
    );

    expect(outcome).toEqual({
      status: "replied",
      reply: "answered from what I had"
    });
    expect(model.asked()[0].tools).not.toContain("probe");
    // The endings stay on. Withholding those would leave the round no legal way
    // to end at all, which is the opposite of the fix.
    expect(model.asked()[0].tools).toEqual(
      expect.arrayContaining([FINAL_REPLY_TOOL_NAME, DELEGATE_TOOL_NAME])
    );
  });

  it("leaves the fallback's floor step an ending it can reach", async () => {
    // The production shape, and the half a `mode` decision cannot reach: the
    // primary spends the entire allowance on work tools and never ends, so
    // `stepAllowance`'s one-step floor is all the fallback gets. Handed the work
    // tools with it, the fallback spends that step the same way and the round
    // dies having asked two models a question neither could answer in one step.
    const primary = inspectingModel({ toolCall: { toolName: "probe" } });
    const fallback = inspectingModel(finalReply("the fallback answered"));

    const outcome = await runTurn(
      args({
        budget: newTurnBudget(3),
        tools,
        models: pair(primary.model, fallback.model)
      })
    );

    expect(outcome).toEqual({
      status: "replied",
      reply: "the fallback answered"
    });
    // The primary had room to work and used it; the fallback had one step, and
    // nothing to spend it on but the ending.
    expect(primary.asked()[0].tools).toContain("probe");
    expect(fallback.asked()[0].tools).not.toContain("probe");
  });
});

describe("renderTurnMessages", () => {
  it("marks referenceable turns with the index the model selects them by", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));

    const { messages, catalog } = renderTurnMessages(
      session.messages,
      "t1",
      []
    );
    expect(catalog).toHaveLength(
      messages.filter((m) => String(m.content).startsWith("[ref ")).length
    );
    // The markers and the catalog are produced in one pass precisely so they
    // cannot disagree; a mismatch means a subtask could cite an index that
    // resolves to different text.
    expect(catalog[0]?.index).toBe(1);
  });

  /**
   * Every synthetic tool-call id core emits has to satisfy
   * `^[a-zA-Z0-9_-]+$` — Anthropic's rule for `tool_use.id`.
   *
   * This is checked on the *rendered* messages rather than on
   * `delegateToolCallId` directly, because the id only matters where it reaches
   * a provider, and the reconstruction is what puts it there. Round 0 never
   * exercised it (the model authors its own ids), which is exactly how a
   * colon-separated id shipped and 400d every round from the first delegation
   * onwards.
   */
  it("emits provider-safe tool-call ids when it rebuilds a delegation", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));

    const branch: CompositionBranch = {
      subtaskId: 1,
      round: 0,
      ordinal: 0,
      type: "general",
      prompt: "do the thing",
      params: {},
      status: "completed",
      resultParts: [{ kind: "text", text: "did the thing" }],
      error: null
    };
    const { messages } = renderTurnMessages(session.messages, "t1", [branch]);

    const ids = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-call" || part.type === "tool-result"
              ? [part.toolCallId]
              : []
          )
        : []
    );

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

/**
 * The evidence a round produces, and whether the next one can see it.
 *
 * A round is one `generateText` call, so its work-tool calls and their results
 * end with it — and what survives into the Session is the acknowledgment the user
 * read. Carry nothing and every round inherits its predecessors' assertions and
 * none of their observations, which is a loop that reinforces itself: by round
 * five the context held five claims that a repository was ready and zero records
 * of how any of them had checked.
 *
 * Two halves, and both are needed. A round has to *produce* its exchanges, and a
 * later round has to be *handed* them.
 */
describe("what a round carries to the next one", () => {
  const workTools = {
    repo_clone: tool({
      description: "clone a repository",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }: { url: string }) =>
        url.startsWith("git@")
          ? "this agent may only clone over https from: github.com"
          : "reused the existing checkout at /workspace/SpikeResearch"
    })
  };

  const delegated = (reply: string) => ({
    toolCall: {
      toolName: DELEGATE_TOOL_NAME,
      input: {
        reply,
        subtasks: [{ type: "general", prompt: "research the thing" }]
      }
    }
  });

  it("reports the exchanges a delegating round made", async () => {
    const outcome = await runTurn(
      args({
        tools: workTools,
        models: pair(
          mockModel(
            {
              toolCall: {
                toolName: "repo_clone",
                input: { url: "git@github.com:o/r.git" }
              }
            },
            {
              toolCall: {
                toolName: "repo_clone",
                input: { url: "https://github.com/o/r" }
              }
            },
            delegated("Repo cloned successfully. Launching…")
          )
        )
      })
    );

    expect(outcome.status).toBe("delegated");
    // Exactly two exchanges, four messages. `onStepEnd` reports each step's *new*
    // messages, not the conversation so far — a cumulative read here would carry
    // the first exchange again with every step after it, and the duplication
    // would grow with the round rather than announce itself.
    if (outcome.status === "delegated")
      expect(outcome.observations).toHaveLength(4);
    const observed = JSON.stringify(
      outcome.status === "delegated" ? outcome.observations : []
    );
    // Both attempts, including the one that was refused — that refusal is what
    // thirteen rounds each re-discovered.
    expect(observed).toContain("may only clone over https");
    expect(observed).toContain("reused the existing checkout");
    // And not the ending: it is already durable, and `delegationPair` rebuilds it.
    expect(observed).not.toContain(DELEGATE_TOOL_NAME);
    expect(observed).not.toContain("Launching");
  });

  /** A round that answered has ended the task. There is no later round to tell. */
  it("reports none from a round that replied", async () => {
    const outcome = await runTurn(
      args({
        tools: workTools,
        models: pair(
          mockModel(
            {
              toolCall: {
                toolName: "repo_clone",
                input: { url: "https://github.com/o/r" }
              }
            },
            finalReply("here is what I found")
          )
        )
      })
    );

    expect(outcome.status).toBe("replied");
    expect(outcome).not.toHaveProperty("observations");
  });

  /**
   * The incident, inverted. Round 1 is handed round 0's refusal, so the mistake
   * it repeated thirteen times is one it can now see it already made.
   */
  it("hands a later round the refusal an earlier one hit", async () => {
    const model = inspectingModel(finalReply("done"));
    const session = new FakeSession();
    await runTurn(args({ session }));

    await runTurn(
      args({
        session,
        round: 1,
        models: pair(model.model),
        observations: [
          {
            round: 0,
            messages: captureObservations(
              [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "functions.repo_clone:1",
                      toolName: "repo_clone",
                      input: { url: "git@github.com:o/r.git" }
                    }
                  ]
                },
                {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: "functions.repo_clone:1",
                      toolName: "repo_clone",
                      output: {
                        type: "error-text",
                        value:
                          "this agent may only clone over https from: github.com"
                      }
                    }
                  ]
                }
              ],
              {
                round: 0,
                controlNames: [DELEGATE_TOOL_NAME, FINAL_REPLY_TOOL_NAME]
              }
            )
          }
        ]
      })
    );

    const handed = JSON.stringify(model.asked()[0]?.messages ?? []);
    expect(handed).toContain("may only clone over https");
    expect(handed).toContain("git@github.com:o/r.git");
  });

  /** The control: without them, the round sees exactly what it used to. */
  it("hands it nothing when the agent carries nothing", async () => {
    const model = inspectingModel(finalReply("done"));
    const session = new FakeSession();
    await runTurn(args({ session }));

    await runTurn(args({ session, round: 1, models: pair(model.model) }));

    const handed = JSON.stringify(model.asked()[0]?.messages ?? []);
    expect(handed).not.toContain("repo_clone");
  });

  /**
   * The ids reach a provider as `tool_use.id`, which Anthropic restricts to
   * `^[a-zA-Z0-9_-]+$`. A carried exchange keeps the id its *provider* assigned
   * unless something rewrites it — and the incident's own transcript carries
   * `functions.repo_clone:13`, so this is the failure that would replace the one
   * being fixed.
   */
  it("renders carried exchanges with provider-safe ids", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));

    const observed = captureObservations(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "functions.repo_clone:13",
              toolName: "repo_clone",
              input: {}
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "functions.repo_clone:13",
              toolName: "repo_clone",
              output: { type: "text", value: "ok" }
            }
          ]
        }
      ],
      { round: 0, controlNames: [DELEGATE_TOOL_NAME] }
    );

    const { messages } = renderTurnMessages(
      session.messages,
      "t1",
      [],
      new Map([[0, observed]])
    );

    const ids = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part) =>
            part.type === "tool-call" || part.type === "tool-result"
              ? [part.toolCallId]
              : []
          )
        : []
    );

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("joinSuccessfulBranches", () => {
  const branch = (
    status: CompositionBranch["status"],
    text: string
  ): CompositionBranch => ({
    subtaskId: 1,
    round: 0,
    ordinal: 0,
    type: "general",
    prompt: "p",
    params: {},
    status,
    resultParts: [{ kind: "text", text }],
    error: null
  });

  it("joins only what succeeded", () => {
    const joined = joinSuccessfulBranches(
      [branch("completed", "first"), branch("completed", "second")],
      policy.copy.partialNote
    );
    expect(joined).toBe("first\n\nsecond");
  });

  it("discloses the gap rather than presenting a partial answer as complete", () => {
    const joined = joinSuccessfulBranches(
      [branch("completed", "first"), branch("failed", "ignored")],
      policy.copy.partialNote
    );
    expect(joined).toContain("first");
    expect(joined).toContain(policy.copy.partialNote);
    expect(joined).not.toContain("ignored");
  });

  it("takes the disclosure wording from the agent, never from core", () => {
    // The note is `RoundPolicy.copy.partialNote` — a user-facing string, so it
    // is the agent's. A default here would be house prompt copy in a published
    // package, which is the line core does not cross.
    const joined = joinSuccessfulBranches(
      [branch("completed", "kept"), branch("failed", "dropped")],
      "MY OWN WORDING"
    );
    expect(joined).toContain("MY OWN WORDING");
    expect(joined).not.toContain(policy.copy.partialNote);
  });
});
