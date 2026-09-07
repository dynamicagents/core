/**
 * `@dynamicagents/core/testing` — the harness both predecessor agents grew, shipped so
 * a consumer does not grow it a third time.
 *
 * Never import this from runtime code. It is a separate subpath precisely so it
 * cannot reach a production bundle, and it pulls in `cloudflare:test`, which
 * does not exist in a deployed Worker.
 *
 * **This barrel is the workerd half** — safe to import from a spec. The VCR
 * recorder needs `node:fs`, so it lives behind `@dynamicagents/core/testing/node`
 * and must not be re-exported here: pulling it into this graph would drag Node
 * builtins into every spec that wanted a fixture. `vcr-shared.ts` is the seam
 * both realms may load.
 *
 * Three things live here:
 *
 * - **VCR (spec side)** — `setupRecording()`, which names a cassette per test and
 *   talks to the Node-side recorder over the in-band control channel.
 * - **Fakes** — a `SessionLike` reference implementation and a scripted
 *   `LanguageModel`, so a loop can be driven with no model call at all.
 * - **Fixtures** — Ed25519 keypairs and a gatekeeper-JWT signer, so the zero-trust
 *   path can be exercised end to end without a real gatekeeper.
 */

export {
  setupRecording,
  cassetteNameFor,
  type SetupRecordingOptions
} from "./vcr-spec.js";
export {
  VCR_CONTROL_ORIGIN,
  VCR_MARKER_HEADER,
  CASSETTE_NAME_RE,
  type VcrReleaseResult
} from "./vcr-shared.js";

export { FakeSession } from "./fake-session.js";
// `throwingModel`, `countingModel` and `rateLimitedModel` were reachable only
// through a deep `dist/` path until now, which meant a consumer could not assert
// the one thing they exist for: that a rate limit is waited out on the *same*
// model rather than falling through to the fallback slot.
export {
  mockModel,
  finalReply,
  throwingModel,
  countingModel,
  inspectingModel,
  type ModelCall,
  rateLimitedModel,
  type MockStep
} from "./mock-model.js";

export { makeGatekeeperToken, type GatekeeperTokenOptions } from "./auth.js";
export {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  TEST_GATEKEEPER_PRIVATE_JWK,
  TEST_MODELS,
  gatekeeperPublicJwks,
  testAgentMessage,
  testStatus,
  testTask
} from "./fixtures.js";

export { doStorage, makeDoHelpers, type DoTestHelpers } from "./do.js";

export {
  createAgentHarness,
  type AgentHarness,
  type AgentHarnessOptions,
  type CapturedCallback,
  type HarnessWorker
} from "./harness.js";
