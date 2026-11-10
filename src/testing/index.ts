/**
 * `@dynamicagents/core/testing`: the harness a consumer's specs share, so none
 * grows its own. Never import it from runtime code; it imports `vitest`.
 *
 * **This barrel is the workerd half** — safe to import from a spec. The VCR
 * recorder needs `node:fs`, so it lives behind `@dynamicagents/core/testing/node`
 * and must not be re-exported here: pulling it into this graph would drag Node
 * builtins into every spec that wanted a fixture. `vcr-shared.ts` is the seam
 * both realms may load.
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
  askApproval,
  askForm,
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
  SECOND_GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  TEST_CALLER_IDENTITY,
  TEST_GATEKEEPER,
  TEST_GATEKEEPERS,
  TEST_GATEKEEPER_PRIVATE_JWK,
  TEST_SECOND_GATEKEEPER,
  TEST_SECOND_GATEKEEPER_PRIVATE_JWK,
  gatekeeperJwksResponse,
  gatekeeperPublicJwks,
  testAgentMessage,
  testStatus,
  testTask,
  type TestGatekeeper
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
