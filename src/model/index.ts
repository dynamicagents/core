/**
 * `@dynamicagents/core/model` — the model an agent's `getModel()` returns.
 *
 * A provider is a function returning one `LanguageModel`. There is no fallback
 * model: a transient failure is retried by the AI SDK (`maxRetries`, which
 * `beforeTurn` can tune) and an interrupted turn is continued by Think's chat
 * recovery.
 */

export {
  GATEWAY_METADATA_MAX,
  gatewayLogFields,
  type AiGatewayMetadata,
  type GatewayCorrelation,
  type GatewayLogFields,
  type GatewayPhase
} from "./gateway-log.js";

export { workersAIModel, type WorkersAIModelOptions } from "./workers-ai.js";
