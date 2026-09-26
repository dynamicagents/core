/**
 * The plugin contract — the only thing core and a plugin package both name.
 *
 * Re-exported from the package root as well, so a plugin author writes
 * `import { definePlugin } from "@dynamicagents/core"` and nothing else.
 */

export {
  PLUGIN_CONTRACT_VERSION,
  definePlugin,
  restrictTools,
  type AgentPlugin,
  type PluginContext,
  type PluginContextBlock,
  type PluginRequirements,
  type RestrictToolsOptions
} from "./plugin.js";

export {
  PluginSetupError,
  assemblePlugins,
  type AssembledPlugins
} from "./assemble.js";
