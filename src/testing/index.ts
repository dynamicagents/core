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
 * - **Fakes** — scripted streaming `LanguageModel`s, so a Think turn runs with no
 *   model call at all.
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

export {
  askUser,
  call,
  inspectingModel,
  mockModel,
  reply,
  scriptedModel,
  throwingModel,
  type MockStep,
  type ModelCall,
  type ModelPrompt,
  type ModelTurnView
} from "./mock-model.js";

export { makeGatekeeperToken, type GatekeeperTokenOptions } from "./auth.js";
export {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  TEST_GATEKEEPER_PRIVATE_JWK,
  gatekeeperPublicJwks,
  testAgentMessage,
  testStatus,
  testTask
} from "./fixtures.js";

export { doStorage, makeDoHelpers, type DoTestHelpers } from "./do.js";

export {
  TERMINAL_CALLBACK_STATES,
  createAgentHarness,
  type AgentHarness,
  type AgentHarnessOptions,
  type CapturedCallback,
  type HarnessWorker
} from "./harness.js";
