/**
 * `@dynamicagents/core` — the mandatory foundation for a Dynamic Agent.
 *
 * This root entry carries only what nearly every consumer touches: the plugin
 * contract and the env slices. Everything else lives behind a subpath
 * (`/agent`, `/subagent`, `/model`, `/a2a`, `/worker`, `/alarm`, `/job`,
 * `/artifacts`, `/testing`), so importing the contract does not pull in Think, and importing
 * the test harness never reaches a production bundle.
 */

export {
  PLUGIN_CONTRACT_VERSION,
  PluginSetupError,
  assemblePlugins,
  definePlugin,
  restrictTools,
  type AgentPlugin,
  type AssembledPlugins,
  type PluginContext,
  type PluginContextBlock,
  type PluginRequirements,
  type RestrictToolsOptions,
  type SubAgentPrepareContext,
  type SubAgentSettleContext,
  type SubAgentSpec
} from "./contract/index.js";

export {
  parseGatekeeperOrigins,
  type A2ASecretsEnv,
  type AiEnv,
  type ArtifactsEnv,
  type CoreEnv
} from "./env.js";

export { withAbort } from "./abort.js";
