import { describe, it, expect } from "vitest";
import { APICallError, generateText, isStepCount, tool } from "ai";
import type { ModelMessage, ToolResultPart } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { FINAL_REPLY_TOOL_NAME } from "../agent/final-reply.js";
import { ASK_USER_TOOL_NAME } from "../agent/ask-user.js";
import {
  deterministicSessionMessage,
  roundAnswerMessageId,
  roundAskMessageId
} from "../agent/history.js";
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
  heldCalls,
  renderTurnMessages,
  runTurn,
  type ApprovalReplay,
  type RunTurnArgs,
  type RunTurnOutcome
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
   * The two roads to "this attempt reached no ending", which look identical from
   * the outcome and are charged by entirely different code.
   *
   * A model that narrates instead of calling anything never returns: the SDK
   * enforces `toolChoice` and throws, so `onStepEnd` — where a round bills its
   * budget — never runs for that step. A model that spends every step on work
   * tools returns normally, having billed each one. Both fail the slot; only the
   * step count tells them apart, so that is what these assert.
   *
   * Worth pinning because the throw is the fragile road. Narration arriving as a
   * *result* is safe — `onStepEnd` runs and bills it, and it falls out as the
   * no-control-call failure. The silent one is the throw ceasing to be a
   * `ToolChoiceViolationError`: `isInstance` stops matching, the `catch`
   * rethrows without charging, and a model that never calls a tool burns both
   * slots and every repair for free.
   */
  it("charges a narrated attempt, which never completes a step", async () => {
    const budget = newTurnBudget(5);
    const primary = countingModel({ text: "narrating instead of acting" });
    const fallback = countingModel(finalReply("fallback answered"));

    const outcome = await runTurn(
      args({ budget, models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toEqual({ status: "replied", reply: "fallback answered" });
    // One call, no repair: nothing was rejected, so there is no ending to
    // correct and the slot goes straight to the fallback.
    expect(primary.calls()).toBe(1);
    // The step the provider answered, plus the fallback's. Zero here would mean
    // a model that never calls a tool costs nothing.
    expect(budget.spent).toBe(2);
  });

  it("charges every step of an attempt that never reaches a control tool", async () => {
    const budget = newTurnBudget(3);
    // Always calls a work tool: `toolChoice` is satisfied every step, so nothing
    // throws — the attempt simply runs out of steps having decided nothing.
    const primary = countingModel({ toolCall: { toolName: "work" } });
    const fallback = countingModel(finalReply("fallback answered"));

    const outcome = await runTurn(
      args({
        budget,
        tools: {
          work: tool({
            description: "Does some work.",
            inputSchema: z.object({}),
            execute: async () => "done"
          })
        },
        models: pair(primary.model, fallback.model)
      })
    );

    expect(outcome).toEqual({ status: "replied", reply: "fallback answered" });
    // Its whole allowance, one step at a time.
    expect(primary.calls()).toBe(3);
    // Three spent by the primary, and the fallback's one step past the
    // allowance — `stepAllowance`'s floor, which a round may exceed by exactly
    // that and never by more.
    expect(budget.spent).toBe(4);
  });

  /**
   * Truncation is the round's own diagnosis, and it survives only because a work
   * call landed in the same step: a truncated step with no tool call at all is a
   * `toolChoice` violation and throws before the round sees a `finishReason`.
   *
   * It also ends the attempt on the spot. A cut-off response is terminal to the
   * SDK's loop, so the round gets a one-step attempt rather than one that spends
   * its allowance — which is why a truncated round fails so much cheaper than a
   * stuck one, and why `maxOutputTokens` set too low looks like a fallback that
   * answers everything.
   */
  it("charges a truncated step, which is spent like any other", async () => {
    const budget = newTurnBudget(2);
    const primary = countingModel({
      toolCall: { toolName: "work" },
      truncated: true
    });
    const fallback = countingModel(finalReply("fallback answered"));

    const outcome = await runTurn(
      args({
        budget,
        tools: {
          work: tool({
            description: "Does some work.",
            inputSchema: z.object({}),
            execute: async () => "done"
          })
        },
        models: pair(primary.model, fallback.model)
      })
    );

    expect(outcome).toEqual({ status: "replied", reply: "fallback answered" });
    // One call, though the allowance was two: the cut-off ends the loop.
    expect(primary.calls()).toBe(1);
    // The step still cost a turn. Zero for the primary — a total of one here —
    // would mean truncation had begun throwing before the step completed, the
    // way a `toolChoice` violation does, and the round had stopped billing for
    // a response the provider had already produced.
    expect(budget.spent).toBe(2);
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
   * The waiting is the SDK's own, on its defaults — core configures none. The
   * call counts are the assertion: the outcome is a successful reply either way,
   * so only "which model was asked, and how many times" can tell one slot's
   * answer from the other's.
   */
  it("offers a rate limit to the other model rather than waiting it out", async () => {
    const primary = rateLimitedModel(1, finalReply("never reached"));
    const fallback = countingModel(finalReply("the other slot had capacity"));

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    // The two slots are different models, and the second may have capacity the
    // first does not — so it is asked before the SDK spends a step's retries
    // waiting on the model that hit the limit.
    expect(outcome).toEqual({
      status: "replied",
      reply: "the other slot had capacity"
    });
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
  });

  /**
   * A rate limit neither slot outlasts is still "not yet": the round throws so
   * the Workflow step retries it, rather than failing a Task that another minute
   * would have answered.
   *
   * What the ladder is handed is not the 429 — it is the SDK's wrapper around
   * every attempt it made, and seeing through that is
   * {@link file://../agent/inference.ts isTransientAiError}'s job.
   */
  it("throws for the step when a rate limit outlasts the retries", async () => {
    const primary = rateLimitedModel(
      Number.POSITIVE_INFINITY,
      finalReply("unreachable")
    );
    const fallback = rateLimitedModel(
      Number.POSITIVE_INFINITY,
      finalReply("unreachable")
    );

    await expect(
      runTurn(args({ models: pair(primary.model, fallback.model) }))
    ).rejects.toThrow();

    // Every attempt the SDK made cost *both* slots, because the retry wraps the
    // pair rather than sitting inside it — which is the half of this a thrown
    // error alone does not show.
    //
    // The exact count is the SDK's own default, and core configures nothing —
    // which makes it the budget `CHUNK_SOFT_MS`'s headroom is sized against in
    // src/platform.ts. Pinned here so a release that changes that default fails
    // a test rather than quietly eating five minutes of a chunk step.
    expect(primary.calls()).toBe(3);
    expect(fallback.calls()).toBe(3);
  });

  /**
   * The same short-circuit as the credential specs below, reached the way it
   * actually happens once a rate limit moves the call to the other slot: the
   * blip is transient and the rejection behind it is not, and only one of the
   * two can be reported.
   *
   * Reporting the blip would send the Workflow step back to present the same
   * dead token, once per retry, and end the Task saying capacity was the
   * problem.
   */
  it("reports a credential the second slot refused, not the blip that got there", async () => {
    const primary = rateLimitedModel(
      Number.POSITIVE_INFINITY,
      finalReply("never reached")
    );
    const fallback = throwingModel(
      new CredentialRejectedError("invalid bearer token", {
        status: 401,
        source: "provider"
      })
    );

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toMatchObject({ status: "failed", kind: "credential" });
    // Refused once, and not presented again by a retry or by the slot loop.
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

  /**
   * The second slot is for a model the round has not asked yet. Once the pair
   * has handed the round's calls to the fallback, that model has seen the round,
   * and asking it again from the top would repeat every tool call since.
   */
  it("does not ask the fallback again once it has taken the round over", async () => {
    const primary = throwingModel(
      new APICallError({
        message: "400 malformed request",
        url: "mock:chat:test",
        requestBodyValues: {},
        statusCode: 400
      })
    );
    const fallback = countingModel({ text: "narrating instead of acting" });

    const outcome = await runTurn(
      args({ models: pair(primary.model, fallback.model) })
    );

    expect(outcome).toMatchObject({ status: "failed", kind: "exhausted" });
    expect(fallback.calls()).toBe(1);
  });

  it("retries the round for a rate limit the fallback covered with no ending", async () => {
    const primary = rateLimitedModel(
      Number.POSITIVE_INFINITY,
      finalReply("never reached")
    );
    const fallback = countingModel({ text: "narrating instead of acting" });

    // The narration is the fallback's, produced because the primary had no
    // capacity — which a retry of the round may well have again.
    await expect(
      runTurn(args({ models: pair(primary.model, fallback.model) }))
    ).rejects.toThrow();
    expect(fallback.calls()).toBe(1);
  });

  it("gives the fallback its turn when the primary cannot be built", async () => {
    const fallback = countingModel(finalReply("the fallback answered"));
    const models = {
      primary: () => {
        throw new Error("no binding for the primary slot");
      },
      fallback: () => fallback.model,
      primaryId: () => TEST_MODELS.chatModelId,
      fallbackId: () => TEST_MODELS.fallbackChatModelId
    } as unknown as ModelPair;

    const outcome = await runTurn(args({ models }));

    expect(outcome).toEqual({
      status: "replied",
      reply: "the fallback answered"
    });
    expect(fallback.calls()).toBe(1);
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

  /**
   * A tool call is a thing that happened, and it does not un-happen because the
   * attempt that made it went on to fail.
   *
   * The concrete case: a primary clones the repository, then runs out of steps
   * without reaching an ending. The fallback delegates successfully. If the round
   * carried only the winning attempt's calls, the next round would inherit no
   * record of a clone that genuinely ran — and would clone again. That is this
   * feature's own failure mode, reintroduced one level down.
   */
  it("keeps work a failed attempt completed before it failed", async () => {
    const primary = mockModel(
      {
        toolCall: {
          toolName: "repo_clone",
          input: { url: "https://github.com/o/r" }
        }
      },
      // Narration, not an ending: the attempt dies with `round produced no
      // decision` and the slot moves on to the fallback.
      { text: "I cloned it and I am thinking about what to do next" }
    );
    const fallback = mockModel(delegated("on it"));

    const outcome = await runTurn(
      args({ tools: workTools, models: pair(primary, fallback) })
    );

    expect(outcome.status).toBe("delegated");
    const observed = JSON.stringify(
      outcome.status === "delegated" ? outcome.observations : []
    );
    expect(observed).toContain("reused the existing checkout");
  });

  /**
   * The same rule one level in: a call the primary cannot finish is finished by
   * the other model **from where it got to**, not from the top of the round.
   *
   * The concrete case is the expensive one. A primary clones the repository and
   * its next call fails outright. A round that started the fallback over would
   * hand it the round's opening messages, and the clone would run a second time
   * — real work, really repeated, for a fault that had nothing to do with it.
   */
  it("finishes on the other model from where the first got to", async () => {
    let clones = 0;
    const counted = {
      repo_clone: tool({
        description: "clone a repository",
        inputSchema: z.object({ url: z.string() }),
        execute: async () => {
          clones += 1;
          return "reused the existing checkout at /workspace/SpikeResearch";
        }
      })
    };

    // Clones, and then cannot make its next call at all. The step shape comes
    // from `mockModel` so only the failure is spelled out here.
    const cloned = mockModel({
      toolCall: {
        toolName: "repo_clone",
        input: { url: "https://github.com/o/r" }
      }
    });
    let calls = 0;
    const primary = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls += 1;
        if (calls > 1)
          throw new APICallError({
            message: "400 malformed request",
            url: "mock:chat:test",
            requestBodyValues: {},
            statusCode: 400
          });
        return cloned.doGenerate(options);
      }
    });

    const outcome = await runTurn(
      args({
        tools: counted,
        models: pair(primary as never, mockModel(delegated("on it")))
      })
    );

    expect(outcome.status).toBe("delegated");
    // Once. A ladder one level up makes it twice.
    expect(clones).toBe(1);
    const observed = JSON.stringify(
      outcome.status === "delegated" ? outcome.observations : []
    );
    expect(observed).toContain("reused the existing checkout");
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

/**
 * Cancellation reaching the round's own inference.
 *
 * The round is the widest window a Task has — a model call plus every tool it
 * decides to make — and before this it could only be interrupted between rounds.
 * What these pin is not that a cancelled Task ends (the caller re-reads the row
 * and would reach that anyway) but that it ends as a **cancellation**: an abort
 * read as bad model output walks the repair ladder and spends the fallback slot,
 * which is real money and a real delay on work nobody is waiting for.
 */
describe("a cancelled round", () => {
  it("reports canceled rather than failed, and leaves the fallback unspent", async () => {
    const controller = new AbortController();
    const fallback = countingModel(finalReply("fallback answered"));

    // Aborted while the call is in flight, then allowed to return normally. That
    // is the same-tick race — the signal lands as the provider answers — and it
    // is why the abort is checked before the result is read rather than only in
    // the `catch`. A model that rejects on abort takes the other road; both
    // arrive here.
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        controller.abort();
        return {
          content: [{ type: "text" as const, text: "" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 }
          },
          warnings: []
        };
      }
    });

    const outcome = await runTurn(
      args({
        models: {
          primary: () => primary,
          fallback: () => fallback.model,
          primaryId: () => TEST_MODELS.chatModelId,
          fallbackId: () => TEST_MODELS.fallbackChatModelId
        } as unknown as ModelPair,
        abortSignal: controller.signal
      })
    );

    expect(outcome.status).toBe("canceled");
    // The assertion that costs something to get wrong. Without the abort check
    // this is a `stop` with no control call — the round's canonical "model
    // narrated instead of acting" failure — which spends the second slot and
    // then reports `exhausted` for a Task the user cancelled.
    expect(fallback.calls()).toBe(0);
  });

  it("still charges the turns the model already spent", async () => {
    const controller = new AbortController();
    const budget = newTurnBudget(20);
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        controller.abort();
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: crypto.randomUUID(),
              toolName: FINAL_REPLY_TOOL_NAME,
              input: JSON.stringify({ text: "answered anyway" })
            }
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 }
          },
          warnings: []
        };
      }
    });

    const outcome = await runTurn(
      args({ models: pair(model), budget, abortSignal: controller.signal })
    );

    expect(outcome.status).toBe("canceled");
    // A cancelled round is not a free round: the provider was called and
    // answered. Forgiving it would let a cancel-heavy caller infer for nothing,
    // and every other exit in this file charges what it spent.
    expect(budget.spent).toBe(1);
  });

  it("hands the round's tools a signal that its cancellation reaches", async () => {
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;

    const outcome = await runTurn(
      args({
        tools: {
          look: tool({
            description: "A work tool.",
            inputSchema: z.object({}),
            execute: async (_input, options) => {
              toolSignal = options.abortSignal;
              return "looked";
            }
          })
        },
        models: pair(
          mockModel({ toolCall: { toolName: "look" } }, finalReply("done"))
        ),
        abortSignal: controller.signal
      })
    );

    expect(outcome.status).toBe("replied");
    // A tool is *given* something to stop its work on — the SDK merges the
    // round's signal with the per-tool deadline and hands the result to
    // `execute`. Core stops waiting on the call either way; stopping the work is
    // the tool's to do, and no amount of core code can do it for it.
    expect(toolSignal).toBeInstanceOf(AbortSignal);
    expect(toolSignal?.aborted).toBe(false);
    controller.abort();
    expect(toolSignal?.aborted).toBe(true);
  });
});

/**
 * The SDK behaviour core's `timeout.toolMs` depends on, pinned here because
 * depending on it silently is how an upgrade breaks a design — and because "does
 * not stop a tool that ignores its signal" is why core wraps every plugin tool
 * rather than trusting the signal. The wrapper's own specs are in
 * `src/runtime/bound-tools.spec.ts`.
 *
 * `MAX_TOOL_CALL_MS` is far too long to wait out, so neither goes through
 * `runTurn`: they call `generateText` directly with a deadline a spec can.
 */
describe("the tool deadline the round relies on", () => {
  it("fails a tool that honours its signal, and lets the model answer around it", async () => {
    const result = await generateText({
      model: mockModel(
        { toolCall: { toolName: "slow" } },
        { text: "answered without it" }
      ),
      messages: [{ role: "user", content: "go" }],
      tools: {
        slow: tool({
          description: "Runs until its signal says stop.",
          inputSchema: z.object({}),
          execute: async (_input, options) =>
            new Promise<string>((_resolve, reject) => {
              const signal = options.abortSignal;
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true
              });
            })
        })
      },
      stopWhen: isStepCount(2),
      timeout: { toolMs: 10 }
    });

    const errors = result.steps
      .flatMap((step) => step.content)
      .filter((part) => part.type === "tool-error");

    // A `tool-error`, not a thrown call. The loop kept going and the model got a
    // second step, which is what lets a round route around a wedged tool instead
    // of dying with it — and is why the round sets `toolMs` and not `stepMs`.
    expect(errors).toHaveLength(1);
    expect(result.text).toContain("answered without it");
  });

  it("does not stop a tool that ignores its signal", async () => {
    let release: (() => void) | undefined;
    const hang = new Promise<string>((resolve) => {
      release = () => resolve("far too late");
    });

    const generation = generateText({
      model: mockModel(
        { toolCall: { toolName: "deaf" } },
        { text: "answered eventually" }
      ),
      messages: [{ role: "user", content: "go" }],
      tools: {
        deaf: tool({
          description: "Never reads its signal.",
          inputSchema: z.object({}),
          // No second parameter: exactly the shape every tool has before it is
          // taught to take one.
          execute: async () => hang
        })
      },
      stopWhen: isStepCount(2),
      timeout: { toolMs: 10 }
    });

    try {
      // The deadline is 10 ms and this waits twenty times that. The SDK merges
      // the deadline into the signal it hands `execute` — it does not race the
      // promise — so nothing here has stopped, and the round is still waiting.
      const marker = Symbol("still running");
      const raced = await Promise.race([
        generation,
        new Promise<symbol>((resolve) => setTimeout(() => resolve(marker), 200))
      ]);

      // Why core wraps every plugin tool instead of relying on this signal: a
      // deadline set through it is a deadline only for a tool that reads it.
      expect(raced).toBe(marker);
    } finally {
      release?.();
      await generation;
    }
  });
});

/**
 * A round that stops to ask the person.
 *
 * Asking is an ending, as `final_reply` and `delegate` are, and what is pinned
 * is what makes it one: it is offered only where the agent's policy says it may
 * ask and never on a round that has to answer, it outranks the other endings in
 * its step, and it leaves the Session alone — the question goes in with its
 * answer, not before.
 */
describe("a round that asks", () => {
  const askPolicy: RoundPolicy = {
    ...policy,
    human: {
      askGuidance: `

# Asking

Ask only when you cannot go on without an answer that only they have.`,
      approvalPrompt: (calls) =>
        calls.map((call) => call.reason ?? call.toolName).join("\n")
    }
  };
  const askInstructions = buildTurnInstructions(askPolicy, types, 8, {
    maxTurns: 20,
    maxWallMs: 60_000
  });

  const asking = (overrides: Partial<RunTurnArgs> = {}) =>
    args({ canAsk: true, instructions: askInstructions, ...overrides });

  const ask = (question: string, options?: string[]) => ({
    toolName: ASK_USER_TOOL_NAME,
    input: { question, ...(options ? { options } : {}) }
  });

  it("ends on the question, and leaves the Session to the answer", async () => {
    const session = new FakeSession();

    const outcome = await runTurn(
      asking({
        session,
        models: pair(
          mockModel({
            toolCall: ask("Which repository?", ["org/api", "org/web"])
          })
        )
      })
    );

    expect(outcome).toMatchObject({
      status: "parked",
      asked: {
        kind: "question",
        question: "Which repository?",
        options: ["org/api", "org/web"]
      }
    });
    // Only the turn that began the Task. A question in history before anyone
    // was shown it would read to every later round as asked and ignored.
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("asks instead of delegating, in a step that does both", async () => {
    const outcome = await runTurn(
      asking({
        models: pair(
          mockModel({
            toolCalls: [
              {
                toolName: DELEGATE_TOOL_NAME,
                input: {
                  reply: "on it",
                  subtasks: [{ type: "general", prompt: "research it" }]
                }
              },
              ask("Should the old API be covered too?")
            ]
          })
        )
      })
    );

    // Asking starts nothing, so the work waits on the answer rather than
    // starting on a guess the answer could have changed.
    expect(outcome.status).toBe("parked");
  });

  it("asks instead of answering, in a step that does both", async () => {
    const outcome = await runTurn(
      asking({
        models: pair(
          mockModel({
            toolCalls: [
              { toolName: FINAL_REPLY_TOOL_NAME, input: { text: "done" } },
              ask("Did you want the tests as well?")
            ]
          })
        )
      })
    );

    expect(outcome.status).toBe("parked");
  });

  it("offers the question only to an agent that may ask", async () => {
    const may = inspectingModel(finalReply("done"));
    const mayNot = inspectingModel(finalReply("done"));

    await runTurn(asking({ models: pair(may.model) }));
    await runTurn(args({ models: pair(mayNot.model) }));

    expect(may.asked()[0].tools).toContain(ASK_USER_TOOL_NAME);
    expect(mayNot.asked()[0].tools).not.toContain(ASK_USER_TOOL_NAME);
  });

  it("never offers it to a round that has to answer", async () => {
    // No budget is left to act on whatever the person says.
    const model = inspectingModel(finalReply("what I have"));

    await runTurn(asking({ mode: "final", models: pair(model.model) }));

    expect(model.asked()[0].tools).toEqual([FINAL_REPLY_TOOL_NAME]);
  });

  it("tells the model when to ask only where the agent does", () => {
    expect(askInstructions.open).toContain("# Asking");
    expect(instructions.open).not.toContain("# Asking");
  });

  it("hands two questions in one step back, to be asked as one", async () => {
    const model = inspectingModel(
      { toolCalls: [ask("Which repository?"), ask("Which branch?")] },
      { toolCall: ask("Which repository, and which branch?") }
    );

    const outcome = await runTurn(asking({ models: pair(model.model) }));

    expect(outcome).toMatchObject({
      status: "parked",
      asked: { question: "Which repository, and which branch?" }
    });
    // Repaired on the same model, which was shown why.
    expect(JSON.stringify(model.asked()[1].messages)).toContain(
      "Ask one question"
    );
  });

  it("hands back options the person could not tell apart", async () => {
    const model = inspectingModel(
      { toolCall: ask("Go ahead?", ["Yes", "yes"]) },
      { toolCall: ask("Go ahead?", ["Yes", "No"]) }
    );

    const outcome = await runTurn(asking({ models: pair(model.model) }));

    expect(outcome).toMatchObject({
      status: "parked",
      asked: { options: ["Yes", "No"] }
    });
  });

  it("puts what it saw in front of its question, for the round after the answer", () => {
    const saw: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "obs_r0_0",
            toolName: "repo_status",
            input: {}
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "obs_r0_0",
            toolName: "repo_status",
            output: { type: "text", value: "two checkouts" }
          }
        ]
      }
    ];
    const history = [
      deterministicSessionMessage("task:t1:user", "user", "fix the build"),
      deterministicSessionMessage(
        roundAskMessageId("t1", 0),
        "assistant",
        "Which repository?"
      ),
      deterministicSessionMessage(
        roundAnswerMessageId("t1", 0),
        "user",
        "org/web"
      )
    ];

    const { messages } = renderTurnMessages(
      history,
      "t1",
      [],
      new Map([[0, saw]])
    );

    const at = (needle: string) =>
      messages.findIndex((m) => JSON.stringify(m).includes(needle));
    expect(at("two checkouts")).toBeGreaterThan(at("fix the build"));
    expect(at("two checkouts")).toBeLessThan(at("Which repository?"));
    expect(at("Which repository?")).toBeLessThan(at("org/web"));
    // Once, where it happened — not a second time at the end, as a round with
    // nothing to anchor on would be.
    expect(
      messages.filter((m) => JSON.stringify(m).includes("two checkouts"))
    ).toHaveLength(1);
  });
});

/**
 * Calls a plugin's rule holds for a person.
 *
 * What is pinned is the promise the rule makes: a held call does not run until a
 * person approves it, runs **once** when they do — however many times the round
 * after the answer is attempted — and never runs at all where nobody can be asked.
 */
describe("a round that holds calls for approval", () => {
  /** A gated tool and an ungated one, each counting how often it really ran. */
  function counted() {
    const runs = { push: 0, probe: 0 };
    const tools = {
      push: tool({
        description: "push a branch",
        inputSchema: z.object({ branch: z.string() }),
        execute: async ({ branch }: { branch: string }) => {
          runs.push += 1;
          return `pushed ${branch}`;
        }
      }),
      probe: tool({
        description: "look something up",
        inputSchema: z.object({}),
        execute: async () => {
          runs.probe += 1;
          return "probed";
        }
      })
    };
    return { runs, tools };
  }

  const rules = {
    push: { type: "user-approval" as const, reason: "Push fix to org/web?" }
  };
  const push = { toolName: "push", input: { branch: "fix" } };

  /** The round after the answer, fed the held step and the person's decision. */
  function replayOf(
    outcome: RunTurnOutcome,
    approved: boolean,
    results: Record<string, ToolResultPart> = {}
  ) {
    if (outcome.status !== "parked" || outcome.asked.kind !== "approval")
      throw new Error(`expected held calls, got ${outcome.status}`);
    const kept: ToolResultPart[] = [];
    const calls = heldCalls(outcome.asked.pending);
    const replay: ApprovalReplay = {
      pending: outcome.asked.pending,
      responses: calls.map((call) => ({
        type: "tool-approval-response",
        approvalId: call.approvalId,
        approved,
        ...(approved ? {} : { reason: "not today" })
      })),
      results: approved
        ? results
        : Object.fromEntries(
            calls.map((call) => [
              call.toolCallId,
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: "execution-denied", reason: "not today" }
              } satisfies ToolResultPart
            ])
          ),
      onResult: (part) => {
        kept.push(part);
      }
    };
    return { replay, kept };
  }

  const holding = (overrides: Partial<RunTurnArgs>) =>
    runTurn(args({ canAsk: true, toolApproval: rules, ...overrides }));

  it("parks on a held call without running it", async () => {
    const { runs, tools } = counted();

    const outcome = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });

    expect(outcome).toMatchObject({
      status: "parked",
      asked: {
        kind: "approval",
        calls: [
          {
            toolName: "push",
            input: { branch: "fix" },
            reason: "Push fix to org/web?"
          }
        ]
      }
    });
    expect(runs.push).toBe(0);
  });

  it("runs the call beside it that no rule holds, once, and keeps it with the step", async () => {
    const { runs, tools } = counted();

    const outcome = await holding({
      tools,
      models: pair(mockModel({ toolCalls: [{ toolName: "probe" }, push] }))
    });

    expect(runs).toEqual({ push: 0, probe: 1 });
    if (outcome.status !== "parked" || outcome.asked.kind !== "approval")
      throw new Error("expected held calls");
    // Replayed with the step it belongs to, and not carried a second time as
    // something the round observed.
    expect(JSON.stringify(outcome.asked.pending)).toContain("probed");
    expect(JSON.stringify(outcome.observations)).not.toContain("probed");
  });

  it("holds the call rather than taking an ending written beside it", async () => {
    // The ending was written before the call ran, and may say it did.
    const { tools } = counted();

    const outcome = await holding({
      tools,
      models: pair(
        mockModel({
          toolCalls: [
            push,
            { toolName: FINAL_REPLY_TOOL_NAME, input: { text: "pushed it" } }
          ]
        })
      )
    });

    expect(outcome.status).toBe("parked");
    if (outcome.status !== "parked" || outcome.asked.kind !== "approval")
      throw new Error("expected held calls");
    // And the ending is not kept with the step. Its tool never executes, so
    // nothing in the exchange answers that call, and a replayed call the
    // provider has no result for is refused before the approved one can run.
    expect(JSON.stringify(outcome.asked.pending)).not.toContain(
      FINAL_REPLY_TOOL_NAME
    );
  });

  it("runs the approved call from a step that also reached an ending", async () => {
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(
        mockModel({
          toolCalls: [
            push,
            { toolName: FINAL_REPLY_TOOL_NAME, input: { text: "pushed it" } }
          ]
        })
      )
    });
    const { replay } = replayOf(parked, true);
    const model = inspectingModel(finalReply("pushed, and here is the PR"));

    const outcome = await holding({
      round: 1,
      tools,
      approval: replay,
      models: pair(model.model)
    });

    expect(runs.push).toBe(1);
    expect(outcome).toEqual({
      status: "replied",
      reply: "pushed, and here is the PR"
    });
  });

  it("answers a held call whose tool the surface no longer offers", async () => {
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });
    const { replay } = replayOf(parked, true);
    const model = inspectingModel(finalReply("that is no longer available"));

    // The main-agent surface may depend on durable state, and a question can
    // wait a week: the round after the answer can be offered a different set.
    const { push: _gone, ...without } = tools;
    const outcome = await holding({
      round: 1,
      tools: without,
      approval: replay,
      models: pair(model.model)
    });

    expect(runs.push).toBe(0);
    expect(outcome.status).toBe("replied");
    // Answered rather than left out: the person's approval never reaches the
    // provider attached to a call nothing can run.
    expect(JSON.stringify(model.asked()[0].messages)).toContain(
      "execution-denied"
    );
  });

  it("runs an approved call once, and goes on from its output", async () => {
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });
    const { replay, kept } = replayOf(parked, true);
    const model = inspectingModel(finalReply("pushed, and here is the PR"));

    const outcome = await holding({
      round: 1,
      tools,
      approval: replay,
      models: pair(model.model)
    });

    expect(outcome).toEqual({
      status: "replied",
      reply: "pushed, and here is the PR"
    });
    expect(runs.push).toBe(1);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(model.asked()[0].messages)).toContain("pushed fix");
  });

  it("hands a declined call to the model as refused, without running it", async () => {
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });
    const { replay } = replayOf(parked, false);
    const model = inspectingModel(finalReply("left it unpushed"));

    const outcome = await holding({
      round: 1,
      tools,
      approval: replay,
      models: pair(model.model)
    });

    expect(outcome.status).toBe("replied");
    expect(runs.push).toBe(0);
    expect(JSON.stringify(model.asked()[0].messages)).toContain("not today");
  });

  it("runs an approved call once when the first slot reaches no ending", async () => {
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });
    const { replay } = replayOf(parked, true);
    const fallback = inspectingModel(finalReply("done on the second model"));

    const outcome = await holding({
      round: 1,
      tools,
      approval: replay,
      // Narration: no ending, so the round moves on to the second slot — which
      // must read the push that already ran rather than run it again.
      models: pair(mockModel({ text: "let me think" }), fallback.model)
    });

    expect(outcome).toEqual({
      status: "replied",
      reply: "done on the second model"
    });
    expect(runs.push).toBe(1);
    expect(JSON.stringify(fallback.asked()[0].messages)).toContain(
      "pushed fix"
    );
  });

  it("does not run an approved call again when the round itself re-runs", async () => {
    // The step re-ran after a crash, with the output kept from the first run.
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });
    if (parked.status !== "parked" || parked.asked.kind !== "approval")
      throw new Error("expected held calls");
    const [call] = heldCalls(parked.asked.pending);
    const { replay } = replayOf(parked, true, {
      [call.toolCallId]: {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text", value: "pushed fix" }
      }
    });

    const outcome = await holding({
      round: 1,
      tools,
      approval: replay,
      models: pair(mockModel(finalReply("already pushed")))
    });

    expect(outcome.status).toBe("replied");
    expect(runs.push).toBe(0);
  });

  it("runs an approved call on a round that has to answer", async () => {
    // No work tools are left to that round, and the approval is not a new call.
    const { runs, tools } = counted();
    const parked = await holding({
      tools,
      models: pair(mockModel({ toolCall: push }))
    });
    const { replay } = replayOf(parked, true);

    const outcome = await holding({
      round: 1,
      mode: "final",
      tools,
      approval: replay,
      models: pair(mockModel(finalReply("pushed, out of budget now")))
    });

    expect(outcome.status).toBe("replied");
    expect(runs.push).toBe(1);
  });

  it("refuses a held call, and parks on nothing, where nobody can be asked", async () => {
    const { runs, tools } = counted();
    const model = inspectingModel(
      { toolCall: push },
      finalReply("could not push without a person")
    );

    const outcome = await runTurn(
      args({ tools, toolApproval: rules, models: pair(model.model) })
    );

    expect(outcome.status).toBe("replied");
    expect(runs.push).toBe(0);
    expect(JSON.stringify(model.asked()[1].messages)).toContain(
      "nobody this agent can ask"
    );
  });
});
