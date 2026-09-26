/**
 * `@dynamicagents/core/testing/fixtures` — the **realm-neutral** slice of the
 * harness: fixed keys, origins, and task/message builders.
 *
 * Its own subpath because it is the one part a consumer's `vitest.config.ts`
 * needs, and that file runs in **Node**. The `/testing` barrel pulls in
 * `cloudflare:test` (DO helpers) and `vitest` (the VCR spec hooks), so importing
 * it from a config fails at load with `ERR_UNSUPPORTED_ESM_URL_SCHEME` before a
 * single test runs. Nothing here imports either, so it is safe from a config, a
 * spec, or a plain Node script.
 *
 * Seeding the required secrets from these values is the intended use:
 *
 * ```ts
 * // vitest.config.ts
 * import { GATEKEEPER_ORIGIN, TEST_AGENT_PRIVATE_JWK } from "@dynamicagents/core/testing/fixtures";
 *
 * process.env.A2A_SIGNING_KEY ??= JSON.stringify(TEST_AGENT_PRIVATE_JWK);
 * process.env.GATEKEEPER_ORIGINS ??= JSON.stringify([GATEKEEPER_ORIGIN]);
 * ```
 */
import { type JWK } from "jose";
import { Role, type Message, type Task, type TaskState } from "@a2a-js/sdk";

/** The gatekeeper origin used in all tests. Must match vitest.config.ts and the MockAgent setup. */
export const GATEKEEPER_ORIGIN = "https://gatekeeper.test";

/** Agent origin matching `url.origin` for requests to `http://localhost`. */
export const AGENT_ORIGIN = "http://localhost";

/** Fixed Ed25519 private JWK used as A2A_SIGNING_KEY in tests. */
export const TEST_AGENT_PRIVATE_JWK: JWK & { kid: string } = {
  crv: "Ed25519",
  d: "sbR9EgZV1zUY-K6ENkvSLY8c8Q9kJ9NnxsXc4GVx_1g",
  x: "1dXrUHeE89GBnZbd7MjzJK-3Xvu7khZCK9ZrQauZQ6s",
  kty: "OKP",
  kid: "test-agent-key-1"
};

/** Fixed Ed25519 private JWK for signing gatekeeper JWTs in tests. */
export const TEST_GATEKEEPER_PRIVATE_JWK: JWK & { kid: string } = {
  crv: "Ed25519",
  d: "OVKcn3LDH-qybNIdUbr7T9wbmlxNk2maU4_nILbaLKY",
  x: "jYiAbquXL6db7RihLvp2nsp1ShAolDI0tGOjuwsZVnI",
  kty: "OKP",
  kid: "test-gk-key-1"
};

/** Public JWKS the gatekeeper would serve at its `jku` (the private key minus `d`). */
export function gatekeeperPublicJwks(): string {
  const { d: _d, ...pub } = TEST_GATEKEEPER_PRIVATE_JWK;
  return JSON.stringify({ keys: [{ ...pub, use: "sig", alg: "EdDSA" }] });
}

/**
 * Build an A2A v1.0 `TaskStatus` for tests. The generated protobuf types require
 * every field to be present (`message` included, holding `undefined` when there
 * is none), so this keeps the specs from spelling that out each time.
 */
export function testStatus(
  state: TaskState,
  message?: Message
): NonNullable<Task["status"]> {
  return { state, message, timestamp: new Date().toISOString() };
}

/** An agent-role `Message` carrying a single v1.0 text part. */
export function testAgentMessage(
  messageId: string,
  text: string,
  contextId = "",
  taskId = ""
): Message {
  return {
    messageId,
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain"
      }
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

/** A complete v1.0 `Task` in the given state. */
export function testTask(
  id: string,
  contextId: string,
  state: TaskState,
  message?: Message
): Task {
  return {
    id,
    contextId,
    status: testStatus(state, message),
    artifacts: [],
    history: [],
    metadata: undefined
  };
}
