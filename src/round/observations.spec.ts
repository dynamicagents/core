import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { captureObservations, renderObservations } from "./observations.js";

/**
 * What a round carries out of itself, and what a later round is handed back.
 *
 * The incident these are written from: thirteen rounds, each cloning the same
 * repository, each first trying an SSH URL that had already been refused twelve
 * times, and each delegating on the strength of a checkout it could no longer
 * prove existed. Every fact below is one of the reasons that was possible.
 *
 * These are pure functions over `ModelMessage[]`, so they need neither a model
 * nor a Durable Object — which is the point of having extracted them.
 */

const call = (
  id: string,
  toolName: string,
  input: unknown = {}
): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }]
});

const result = (
  id: string,
  toolName: string,
  value: string,
  type: "text" | "error-text" = "text"
): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName,
      output:
        type === "text"
          ? { type: "text", value }
          : { type: "error-text", value }
    }
  ]
});

const capture = (captured: ModelMessage[], round = 0) =>
  captureObservations(captured, {
    round,
    controlNames: ["delegate", "final_reply"]
  });

/** Every tool-call id anywhere in a message list, in order. */
function ids(messages: ModelMessage[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && typeof message.content !== "string") {
      for (const part of message.content) {
        if (part.type === "tool-call") found.push(part.toolCallId);
      }
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") found.push(part.toolCallId);
      }
    }
  }
  return found;
}

/** Every tool result's rendered output text, in order. */
function outputs(messages: ModelMessage[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      found.push(
        part.output.type === "text" || part.output.type === "error-text"
          ? part.output.value
          : JSON.stringify(part.output)
      );
    }
  }
  return found;
}

describe("what a round carries out of itself", () => {
  it("keeps a work-tool call with the result it came back with", () => {
    const observed = capture([
      call("c1", "repo_clone", { url: "https://github.com/o/r" }),
      result("c1", "repo_clone", "reused the existing checkout")
    ]);

    expect(observed).toHaveLength(2);
    expect(outputs(observed)).toEqual(["reused the existing checkout"]);
  });

  /**
   * The refusal is the single most valuable thing in the incident's transcript
   * and the one most obviously dropped: the model re-made the same SSH-URL
   * mistake in all thirteen rounds because the answer to it never survived one.
   */
  it("keeps a refusal, which is the whole point", () => {
    const observed = capture([
      call("c1", "repo_clone", { url: "git@github.com:o/r.git" }),
      result(
        "c1",
        "repo_clone",
        "this agent may only clone over https from: github.com",
        "error-text"
      )
    ]);

    expect(outputs(observed)).toEqual([
      "this agent may only clone over https from: github.com"
    ]);
  });

  /**
   * The ending is not an observation. It is already durable in the Session and
   * already reconstructed by `delegationPair`, so carrying it here would show a
   * later round two of every delegation — and the acknowledgment text twice.
   */
  it("drops the message that reached for an ending", () => {
    const observed = capture([
      call("c1", "repo_status"),
      result("c1", "repo_status", "(no changes)"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Repo cloned successfully. Launching…" },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "delegate",
            input: {}
          }
        ]
      }
    ]);

    expect(JSON.stringify(observed)).not.toContain("delegate");
    expect(JSON.stringify(observed)).not.toContain("Launching");
    expect(ids(observed)).toHaveLength(2);
  });

  /**
   * Both directions, and both are a provider rejecting the request outright
   * rather than a round losing context: an assistant `tool_use` with no
   * `tool_result` after it, or a result naming a call that is not there.
   *
   * The round most worth carrying is the one that was cut off mid-step, so this
   * is not a corner case — it is the shape a budget ceiling produces.
   */
  it("drops a call that never came back", () => {
    const observed = capture([
      call("c1", "repo_clone"),
      result("c1", "repo_clone", "ok"),
      call("c2", "sb_ls")
    ]);

    expect(ids(observed)).toEqual(["obs_r0_0", "obs_r0_0"]);
  });

  it("drops a result whose call is not there", () => {
    const observed = capture([result("ghost", "sb_ls", "…")]);
    expect(observed).toEqual([]);
  });

  /**
   * Provider ids are not replayable. The incident's own round-13 request carries
   * `functions.repo_clone:13`, and Anthropic rejects any `tool_use.id` outside
   * `^[a-zA-Z0-9_-]+$` — so a carried exchange would fail the *next* round's call
   * rather than the one that made it.
   */
  it("re-identifies the pair so a provider will accept it", () => {
    const observed = capture(
      [
        call("functions.repo_clone:13", "repo_clone"),
        result("functions.repo_clone:13", "repo_clone", "ok")
      ],
      7
    );

    expect(ids(observed)).toEqual(["obs_r7_0", "obs_r7_0"]);
    for (const id of ids(observed)) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("carries the round in the id, so two rounds cannot collide", () => {
    const first = capture([call("x", "sb_ls"), result("x", "sb_ls", "ok")], 0);
    const second = capture([call("x", "sb_ls"), result("x", "sb_ls", "ok")], 1);

    expect(ids(first)[0]).not.toBe(ids(second)[0]);
  });

  it("shortens a result too large to carry, keeping its head", () => {
    const huge = `line one\n${"x".repeat(50_000)}`;
    const observed = capture([
      call("c1", "sb_read"),
      result("c1", "sb_read", huge)
    ]);

    expect(outputs(observed)[0]).toContain("line one");
    expect(outputs(observed)[0]).toMatch(/truncated/);
    expect(outputs(observed)[0].length).toBeLessThan(5_000);
  });

  /**
   * Shortened, but never dropped and never demoted to a plain result. Losing
   * *why* a call failed costs a retry to rediscover, which is the cost this file
   * exists to remove — so the reason survives however long the tail was, and a
   * shortened failure is still a failure to both the provider and the model.
   */
  it("keeps the reason a call failed, however long it was", () => {
    const huge = `fatal: authentication failed\n${"x".repeat(50_000)}`;
    const observed = capture([
      call("c1", "sb_exec"),
      result("c1", "sb_exec", huge, "error-text")
    ]);

    expect(outputs(observed)[0]).toContain("fatal: authentication failed");
    const part = (observed[1] as { content: { output: { type: string } }[] })
      .content[0];
    expect(part.output.type).toBe("error-text");
  });

  /**
   * A round's later calls are the ones its ending was reasoning from, so the
   * budget drops the oldest — and it cuts at an assistant boundary, because a
   * `tool` message left at the front is a result with no call, which is the one
   * shape a provider refuses outright.
   */
  it("drops the oldest exchanges when a round overruns its budget, in pairs", () => {
    const big = "y".repeat(3_500);
    const observed = capture([
      call("c1", "sb_read"),
      result("c1", "sb_read", big),
      call("c2", "sb_read"),
      result("c2", "sb_read", big),
      call("c3", "sb_read"),
      result("c3", "sb_read", big),
      call("c4", "sb_read"),
      result("c4", "sb_read", big)
    ]);

    expect(observed.length).toBeLessThan(8);
    expect(observed.length % 2).toBe(0);
    expect(observed[0].role).toBe("assistant");
    expect(JSON.stringify(observed).length).toBeLessThan(16_000);
  });
});

describe("what a later round is handed back", () => {
  const roundOf = (round: number, value: string) => ({
    round,
    messages: capture(
      [call("c", "repo_clone"), result("c", "repo_clone", value)],
      round
    )
  });

  /**
   * The elision runs across every carried round at once, which is the reason it
   * happens here and not at capture. Its newest-per-tool rule is what makes a
   * tool called in three consecutive rounds cost roughly one result rather than
   * three — and it can only see that across rounds.
   */
  it("stubs an older result whose tool has since answered again", () => {
    const long = "z".repeat(500);
    const rendered = renderObservations(
      [roundOf(0, `first ${long}`), roundOf(1, `second ${long}`)],
      0
    );

    expect(outputs(rendered.get(0) ?? [])[0]).not.toContain("first");
    expect(outputs(rendered.get(1) ?? [])[0]).toContain("second");
  });

  it("hands each round back exactly the messages it put in", () => {
    const rendered = renderObservations([roundOf(0, "a"), roundOf(1, "b")], 99);

    expect(rendered.get(0)).toHaveLength(2);
    expect(rendered.get(1)).toHaveLength(2);
    expect(outputs(rendered.get(0) ?? [])).toEqual(["a"]);
    expect(outputs(rendered.get(1) ?? [])).toEqual(["b"]);
  });

  it("renders rounds in order however they arrive", () => {
    const rendered = renderObservations(
      [roundOf(2, "later"), roundOf(1, "earlier")],
      99
    );

    expect(outputs(rendered.get(1) ?? [])).toEqual(["earlier"]);
    expect(outputs(rendered.get(2) ?? [])).toEqual(["later"]);
  });

  it("carries nothing when there is nothing to carry", () => {
    expect(renderObservations([], 4).size).toBe(0);
  });
});
