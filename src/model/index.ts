/**
 * `@dynamicagents/core/model` — the one model an agent runs on.
 *
 * A provider here answers `getModel()` with a single `LanguageModel`. There is
 * no pair and no fallback ladder: Think's chat recovery and the AI SDK's own
 * retries cover a transient failure, and a call the model cannot take at all is
 * a deployment fact rather than something to route around silently.
 *
 * Which model id, which gateway and which reasoning budget are the agent's —
 * core ships no numbers and no ids. What it ships is the wiring that is the same
 * whoever writes those down: the settings a Workers AI call has to carry, and
 * what a call tells AI Gateway about itself.
 */

export {
  workersAIModel,
  type WorkersAIModelOptions
} from "./workers-ai.js";

export {
  GATEWAY_METADATA_MAX,
  gatewayLogFields,
  type AiGatewayMetadata,
  type GatewayCorrelation,
  type GatewayLogFields,
  type GatewayPhase
} from "./gateway-log.js";
