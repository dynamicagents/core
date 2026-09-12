import { describe, it, expect } from "vitest";
import { decodeJwt } from "jose";
import type { Task } from "@a2a-js/sdk";
import {
  A2A_RPC_PATH,
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  endpointUrl
} from "@dynamicagents/g2a-protocol";
import { createA2AWorker } from "../worker/index.js";
import type { AgentManifest } from "../a2a/card.js";
import type { A2ASecretsEnv } from "../env.js";
import {
  buildCompletedTask,
  buildSubmittedTask,
  postNotification,
  signCallbackJwt
} from "../a2a/notify.js";
import { createAgentHarness } from "./harness.js";
import { TEST_TENANT } from "./auth.js";
import {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK
} from "./fixtures.js";

/**
 * The published test harness, driven against a real `createA2AWorker`.
 *
 * ## Why this exists
 *
 * `createAgentHarness` is the one thing in this package whose *only* job is to
 * be used by other repos' tests. Nothing in core's own suite went through it, so
 * a regression in the token audience, the tenant claim, the request envelope or
 * the callback capture would ship green and surface as an inscrutable 401 in a
 * consumer's suite — where the harness is the least likely thing to be
 * suspected, because it is the part they did not write.
 *
 * The four facts below are exactly the four every consumer got wrong by hand
 * before the harness existed, which is why it exists.
 */

const manifest: AgentManifest = {
  name: "harness-spec-agent",
  description: "an agent driven through the published harness",
  version: "0.1.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

interface TestEnv extends A2ASecretsEnv {
  [key: string]: unknown;
}

const env: TestEnv = {
  A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  GATEKEEPER_ORIGINS: GATEKEEPER_ORIGIN
};

/** Accepted turns, so a spec can read what the edge actually forwarded. */
const accepted: { taskId: string; text: string }[] = [];

const handler = createA2AWorker<TestEnv>({
  manifest,
  tenants: {
    [TEST_TENANT]: {
      manifest,
      resolveAgent: () =>
        ({
          async beginTask(input: { taskId: string; contextId: string }) {
            return buildSubmittedTask(input.taskId, input.contextId);
          },
          async getTask() {
            return null;
          },
          async saveTask() {
            return true;
          },
          async cancelTask() {
            return null;
          }
        }) as never,
      startTurn: async (turn) => {
        accepted.push({ taskId: turn.taskId, text: turn.text });
      }
    }
  }
});

/**
 * `createA2AWorker` returns the bare `fetch`, while a Worker module's default
 * export is `{ fetch }` — which is what a consumer passes and what the harness
 * takes. Wrapped here rather than widening the harness: accepting both shapes
 * would let `worker` be a value that is not an `ExportedHandler`, and the whole
 * point is that a spec drives the same object the runtime does.
 */
const worker = { fetch: handler };

describe("createAgentHarness", () => {
  it("mints a token the edge accepts, and gets back a submitted Task", async () => {
    const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
    using _ = harness.interceptGatekeeper();

    const task = await harness.send("what's the weather?");

    // The whole point: a consumer writes three lines and gets a verified,
    // tenant-scoped, push-configured turn. Everything below is what those three
    // lines had to get right.
    // The wire form renders proto enums as *names*: what comes back over JSON-RPC
    // is "TASK_STATE_SUBMITTED", not the numeric member. A spec comparing to
    // `TaskState.TASK_STATE_SUBMITTED` is comparing a string to 1.
    expect(String(task.status.state)).toContain("SUBMITTED");
    expect(accepted.at(-1)?.text).toBe("what's the weather?");
    expect(accepted.at(-1)?.taskId).toBe(task.id);
  });

  it("addresses the endpoint, not the origin", async () => {
    // The first thing every consumer got wrong. `aud` is `origin + rpcPath`;
    // minting the bare origin is a 401 on every request, and the error names
    // the audience rather than the mistake.
    const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
    const payload = decodeJwt(await harness.token());

    expect(harness.endpoint).toBe(endpointUrl(AGENT_ORIGIN, A2A_RPC_PATH));
    expect(payload.aud).toBe(harness.endpoint);
    expect(payload.aud).not.toBe(AGENT_ORIGIN);
  });

  it("scopes the token to the tenant it addresses", async () => {
    // The second. A token whose tenant claim disagrees with the tenant in the
    // body is refused — that check is what stops one agent's token reaching a
    // sibling on the same endpoint.
    const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
    const payload = decodeJwt(await harness.token());

    expect(payload[TENANT_CLAIM]).toBe(TEST_TENANT);
    expect((payload[IDENTITY_CLAIM] as { key?: string })?.key).toBeTruthy();
  });

  it("refuses a turn whose token authorizes a different tenant", async () => {
    // Proves the scoping above is load-bearing rather than decorative: the
    // harness can mint a mismatched token, and the edge must refuse it.
    const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
    using _ = harness.interceptGatekeeper();

    const res = await harness.rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          tenant: TEST_TENANT,
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            content: [{ text: "hi" }]
          },
          configuration: {
            taskPushNotificationConfig: { url: harness.pushUrl, token: "t" }
          }
        }
      },
      { token: await harness.token({ tenant: "someone-else" }) }
    );

    // 401 with a text body, refused at the edge — not a JSON-RPC error. The
    // tenant check runs before the request is ever dispatched, which is what
    // makes it isolation rather than validation.
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/tenant|unauthoriz/i);
  });

  it("serves the gatekeeper JWKS and 404s anything else", async () => {
    // The third. Without the JWKS reachable, every token fails to verify and
    // every spec below it reports a 401 that has nothing to do with its subject.
    // The 404 is deliberate: an unexpected outbound call fails loudly instead of
    // hanging or escaping the isolate.
    const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
    using _ = harness.interceptGatekeeper();

    const jwks = await fetch(`${GATEKEEPER_ORIGIN}/.well-known/jwks.json`);
    expect(jwks.ok).toBe(true);
    expect(await jwks.json()).toHaveProperty("keys");

    const stray = await fetch("https://somewhere.invalid/anything");
    expect(stray.status).toBe(404);
  });

  it("captures push callbacks with their validation token", async () => {
    // A turn's real output arrives on the callback, not in the response, so a
    // harness that dropped these would make every assertion about what an agent
    // *said* impossible to write.
    //
    // The terminal Task is built with core's own `buildCompletedTask` — the
    // exact producer the round workflow uses. Hand-rolling the shape here would
    // test the harness against a message no agent actually sends.
    const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
    using _ = harness.interceptGatekeeper();

    const task = await harness.send("hello");
    const terminal = buildCompletedTask(task.id, task.contextId, "the reply");

    const jwt = await signCallbackJwt(TEST_AGENT_PRIVATE_JWK, {
      jku: `${AGENT_ORIGIN}/.well-known/jwks.json`,
      aud: harness.pushUrl
    });
    await postNotification(
      harness.pushUrl,
      "harness-push-token",
      jwt,
      terminal as unknown as Task
    );

    // Two callbacks, and the count is the assertion: the *edge* posts the
    // `submitted` accept before any turn runs, so a spec that expected only its
    // own terminal callback would be asserting the accept-and-notify contract
    // does not happen.
    expect(harness.callbacks.map((c) => c.state)).toEqual([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_COMPLETED"
    ]);

    const final = harness.callbacks.at(-1)!;
    expect(final.taskId).toBe(task.id);
    expect(final.text).toBe("the reply");
    // Echoed verbatim so the issuer can correlate the callback to its pending
    // task row — the header name both repos now read from one package.
    expect(final.token).toBe("harness-push-token");
  });

  it("restores the global fetch when the interception is disposed", async () => {
    // `using` is the whole ergonomic claim. A harness that leaked its stub would
    // make the *next* spec in a file fail for reasons invisible in that spec.
    const before = globalThis.fetch;
    {
      const harness = createAgentHarness({ worker, env, tenant: TEST_TENANT });
      using _ = harness.interceptGatekeeper();
      expect(globalThis.fetch).not.toBe(before);
    }
    expect(globalThis.fetch).toBe(before);
  });
});

/**
 * What a gatekeeper sends onto a Task parked on a question: an answer, or word
 * that the question expired.
 *
 * Driven against an edge whose agent records what reached it, because what the
 * harness owes a consumer is exactly that: a reply shaped so the edge takes it
 * as an answer, under the message id a real gatekeeper would give it.
 */
describe("replying to a question through the harness", () => {
  const replies: unknown[] = [];

  const parkedHandler = createA2AWorker<TestEnv>({
    manifest,
    tenants: {
      [TEST_TENANT]: {
        manifest,
        resolveAgent: () =>
          ({
            async beginTask(): Promise<never> {
              throw new Error("a reply must never begin a task");
            },
            async getTask(taskId: string) {
              return buildSubmittedTask(taskId, "ctx-1");
            },
            async saveTask() {
              return true;
            },
            async cancelTask() {
              return null;
            },
            async answerTask(input: { taskId: string }) {
              replies.push(input);
              return {
                task: buildSubmittedTask(input.taskId, "ctx-1"),
                wake: null
              };
            }
          }) as never,
        startTurn: async () => {
          throw new Error("a reply must never start a turn");
        },
        resumeTurn: async () => {}
      }
    }
  });
  const parkedWorker = { fetch: parkedHandler };

  it("answers the way the gatekeeper answers", async () => {
    const harness = createAgentHarness({
      worker: parkedWorker,
      env,
      tenant: TEST_TENANT
    });
    using _ = harness.interceptGatekeeper();

    const task = await harness.answer(
      "t1",
      "q1",
      { optionId: "option_2" },
      { answeredBy: "U1" }
    );

    expect(task.id).toBe("t1");
    expect(replies.at(-1)).toEqual({
      taskId: "t1",
      // The gatekeeper's own derivation, so calling it again is its retry.
      messageId: "harness-push-token:r:q1",
      reply: {
        kind: "answer",
        requestId: "q1",
        answer: { optionId: "option_2", answeredBy: "U1" }
      }
    });
  });

  it("expires a question the way the gatekeeper expires one", async () => {
    const harness = createAgentHarness({
      worker: parkedWorker,
      env,
      tenant: TEST_TENANT
    });
    using _ = harness.interceptGatekeeper();

    await harness.timeout("t1", "q1");

    expect(replies.at(-1)).toEqual({
      taskId: "t1",
      messageId: "harness-push-token:t:q1",
      reply: { kind: "timeout", requestId: "q1" }
    });
  });
});
