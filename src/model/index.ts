/**
 * `@dynamicagents/core/model` — the model an agent's `getModel()` returns.
 *
 * A provider is a function returning one `LanguageModel`. Two of them, split by
 * what the model id names rather than by how it is reached — both go through AI
 * Gateway over the `AI` binding, and both carry the same log fields:
 * `workersAIModel` for a `@cf/...` Workers AI id, `catalogModel` for a
 * `"<provider>/<model>"` slug from AI Gateway's provider catalog. Two functions
 * rather than one because the provider underneath is built differently for a
 * slug — and because sending a slug to the Workers AI one fails quietly, which
 * is the fault {@link file://./workers-ai.ts workersAIModel} describes.
 *
 * There is no fallback model, on either: a transient failure is retried by the
 * AI SDK (`maxRetries`, which `beforeTurn` can tune) and an interrupted turn is
 * continued by Think's chat recovery. What standing one model in for another
 * would cost is in {@link file://./catalog.ts catalogModel}, where the choice
 * of transport makes it concrete.
 */

export {
  GATEWAY_METADATA_MAX,
  gatewayLogFields,
  type AiGatewayMetadata,
  type GatewayCorrelation,
  type GatewayLogFields,
  type GatewayPhase
} from "./gateway-log.js";

export { catalogModel, type CatalogModelOptions } from "./catalog.js";

export { workersAIModel, type WorkersAIModelOptions } from "./workers-ai.js";
