import { describe, it, expect, afterEach, vi } from "vitest";
import { decodeJwt } from "jose";
import { createPushChannel } from "./push.js";
import { TEST_AGENT_PRIVATE_JWK } from "../testing/fixtures.js";

const PUSH = {
  taskId: "task-1",
  contextId: "ctx-1",
  pushUrl: "https://gatekeeper.test/push",
  pushToken: "push-token",
  jku: "http://localhost/.well-known/jwks.json"
};

/** The bearer token on every POST the channel makes, in order. */
function captureTokens(): string[] {
  const tokens: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    tokens.push(auth.replace(/^Bearer /, ""));
    return new Response(null, { status: 200 });
  });
  return tokens;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createPushChannel", () => {
  it("reuses one token while it has time left, and signs a fresh one before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const tokens = captureTokens();
    const channel = createPushChannel(
      JSON.stringify(TEST_AGENT_PRIVATE_JWK),
      PUSH
    );

    await channel.working("first", "r1:step:0");
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    await channel.working("second", "r1:step:1");
    // Six minutes in: the first token expired a minute ago.
    vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
    await channel.working("third", "r1:step:2");

    expect(tokens).toHaveLength(3);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
    const exp = decodeJwt(tokens[2]!).exp! * 1000;
    expect(exp).toBeGreaterThan(Date.now());
  });
});
