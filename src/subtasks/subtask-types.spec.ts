import { describe, it, expect } from "vitest";
import { z } from "zod";
import { makeSubtaskTypes, SubtaskParamsError } from "./subtask-types.js";
import type { ResolvedRecipe, SubtaskTypeSpec } from "../contract/recipe.js";

/**
 * The closed set of delegable subtask types, as a factory rather than the
 * predecessor's module constant.
 *
 * Most of what is asserted here is about the *delegate tool's schema*, which is
 * derived from these specs. That derivation is where a real bug lived: a domain
 * subtask once reached validation with none of its declared ids, because the
 * params field was declared as a free-form record and the provider's JSON Schema
 * conversion flattens that to an object permitting no keys at all. A param the
 * model cannot see declared is a param it has no legal way to send.
 */

const recipe = (key: string): ResolvedRecipe => ({
  key,
  version: 1,
  soul: "s",
  toolFamilies: [],
  enabled: true,
  limits: {},
  historyWindow: 10,
  reportMetrics: false
});

const withParams: SubtaskTypeSpec = {
  key: "play-game",
  description: "play one game",
  params: z.object({
    gameId: z.string().describe("id of the game to play"),
    boardId: z.string().describe("leaderboard to record against")
  }),
  paramsHelp: "call `list_games` first",
  capability: "You can play games.",
  delegationGuidance: (names) =>
    `## Games\nUse \`${names.delegateTool}\`, or \`${names.finalReplyTool}\` to ask.`,
  recipe: recipe("play-game")
};

const noParams: SubtaskTypeSpec = {
  key: "summarize",
  description: "summarize the conversation",
  params: null,
  recipe: recipe("summarize")
};

describe("registry construction", () => {
  it("refuses two plugins declaring the same type", () => {
    // Last-one-wins would silently route work to the wrong domain.
    expect(() => makeSubtaskTypes([withParams, { ...withParams }])).toThrow(
      /duplicate subtask type "play-game"/
    );
  });

  it("preserves declaration order for keys and lookup", () => {
    const types = makeSubtaskTypes([withParams, noParams]);

    expect(types.keys).toEqual(["play-game", "summarize"]);
    expect(types.spec("play-game")?.description).toBe("play one game");
    expect(types.spec("nope")).toBeNull();
  });

  it("refuses to produce a delegate enum when nothing is registered", () => {
    // Not defensive: an agent with no types has nothing to delegate to and must
    // not build a delegate tool at all.
    const empty = makeSubtaskTypes([]);
    expect(empty.keys).toEqual([]);
    expect(() => empty.enumKeys()).toThrow(/no subtask types are registered/);
  });

  it("yields a non-empty tuple for z.enum when types exist", () => {
    const types = makeSubtaskTypes([withParams]);
    expect(types.enumKeys()).toEqual(["play-game"]);
    // The enum is what stops a model emitting a type the data layer never sees.
    expect(() => z.enum(types.enumKeys())).not.toThrow();
  });
});

describe("validateParams", () => {
  const types = makeSubtaskTypes([withParams, noParams]);

  it("accepts params satisfying the type's contract", () => {
    expect(
      types.validateParams("play-game", { gameId: "g1", boardId: "c1" })
    ).toEqual({ gameId: "g1", boardId: "c1" });
  });

  it("refuses a subtask missing a param its type requires", () => {
    // The point of requiring params up front: discovering there is nothing to
    // play several turns into an execution is the failure this prevents.
    expect(() => types.validateParams("play-game", { gameId: "g1" })).toThrow(
      SubtaskParamsError
    );
    expect(() => types.validateParams("play-game", { gameId: "g1" })).toThrow(
      /boardId/
    );
  });

  it("strips unknown keys rather than refusing the subtask", () => {
    // A model that invents a key has produced a valid subtask with noise
    // attached, and the noise provably cannot reach the execution.
    expect(
      types.validateParams("play-game", {
        gameId: "g1",
        boardId: "c1",
        invented: "x"
      })
    ).toEqual({ gameId: "g1", boardId: "c1" });
  });

  it("refuses stray params on a type that declares none", () => {
    // Otherwise the param rides along unread, looking meaningful.
    expect(types.validateParams("summarize", undefined)).toEqual({});
    expect(types.validateParams("summarize", {})).toEqual({});
    expect(() => types.validateParams("summarize", { gameId: "g1" })).toThrow(
      /takes no params/
    );
  });

  it("treats an unknown type as terminal, not recoverable", () => {
    expect(() => types.validateParams("ghost", {})).toThrow(SubtaskParamsError);
    expect(() => types.resolveRecipe("ghost")).toThrow(/unknown subtask type/);
  });

  it("resolves a known type to its recipe", () => {
    expect(types.resolveRecipe("play-game").key).toBe("play-game");
  });
});

describe("paramProperties — what the delegate tool advertises", () => {
  const types = makeSubtaskTypes([withParams, noParams]);

  it("names the union of every type's param keys", () => {
    // One tool schema serves every type, so the alternative to naming the union
    // is naming none — and an unnamed key is one the model cannot send.
    expect(Object.keys(types.paramProperties()).sort()).toEqual([
      "boardId",
      "gameId"
    ]);
  });

  it("makes each key optional, since requiredness is per type", () => {
    const props = types.paramProperties();
    // Optional at the schema level; `validateParams` still refuses a subtask
    // whose own type requires the key.
    expect(props.gameId.safeParse(undefined).success).toBe(true);
    expect(props.gameId.safeParse("g1").success).toBe(true);
  });

  it("prefixes each description with the owning type so a flat namespace reads", () => {
    const props = types.paramProperties();
    expect(props.gameId.description).toBe("play-game: id of the game to play");
  });

  it("names every owner when two types share a key", () => {
    const other: SubtaskTypeSpec = {
      key: "score-game",
      description: "score it",
      params: z.object({ gameId: z.string().describe("game to score") }),
      recipe: recipe("score-game")
    };
    const shared = makeSubtaskTypes([withParams, other]);

    expect(shared.paramProperties().gameId.description).toMatch(
      /play-game\/score-game/
    );
  });
});

describe("rendering for the model", () => {
  const types = makeSubtaskTypes([withParams, noParams]);

  it("renders the type catalogue with params help appended", () => {
    const rendered = types.renderTypes();
    expect(rendered).toContain(
      "- `play-game`: play one game — call `list_games` first"
    );
    expect(rendered).toContain("- `summarize`: summarize the conversation");
  });

  // A type's capability block is asserted in `runtime/index.spec.ts` instead:
  // the runtime is the only thing that renders one, so that is where "declared
  // on the type, and it reached the soul" can actually be shown.

  it("injects the agent's control-tool names into delegation guidance", () => {
    // Guidance legitimately names those tools; injecting them is what lets a
    // domain write that sentence without importing from the runtime.
    const guidance = types.renderDelegationGuidance({
      delegateTool: "delegate",
      finalReplyTool: "final_reply"
    });

    expect(guidance).toContain("`delegate`");
    expect(guidance).toContain("`final_reply`");
    expect(guidance.startsWith("## ")).toBe(true);
  });
});
