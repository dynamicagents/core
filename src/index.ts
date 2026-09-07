/**
 * `@dynamicagents/core` — the mandatory foundation for a Dynamic Agent.
 *
 * This root entry carries only what nearly every consumer touches: the plugin
 * contract, the config shape, the runtime factory, and the platform facts.
 * Everything else lives behind a subpath (`/a2a`, `/agent`, `/db`, `/subtasks`,
 * `/subagent`, `/worker`, `/testing`), so importing the delegation layer does not
 * pull in the A2A adapter and importing the test harness never reaches a
 * production bundle.
 */

export {
  createAgentRuntime,
  RuntimeSetupError,
  buildRecipeTools,
  collectToolFamilies,
  type AgentRuntime,
  type CreateAgentRuntimeOptions
} from "./runtime/index.js";

export {
  PLUGIN_CONTRACT_VERSION,
  definePlugin,
  restrictMainAgentTools,
  type AgentPlugin,
  type RestrictMainAgentToolsOptions,
  type EmitProgress,
  type EnrichResultContext,
  type MainAgentToolContext,
  type PluginRequirements,
  type RecipeToolSet,
  type ResolveRuntimeContext,
  type ToolFamilyBuilder,
  type ToolFamilyContext,
  type TurnGateContext
} from "./contract/plugin.js";

export type {
  DelegationNames,
  RecipeLimits,
  ResolvedRecipe,
  SubtaskParams,
  SubtaskParamsSchema,
  SubtaskParamsShape,
  SubtaskTypeSpec,
  ValidatedRecipe
} from "./contract/recipe.js";

export {
  RecipeValidationError,
  resolveLimits,
  validateRecipe,
  type RecipePolicy
} from "./contract/validation.js";

export {
  ConfigError,
  DEFAULT_CORE_CONFIG,
  resolveConfig,
  type AgentLimits,
  type CoreConfig,
  type CoreConfigOverrides,
  type ModelConfig,
  type SessionConfig
} from "./config.js";

export {
  parseGatekeeperOrigins,
  type A2ASecretsEnv,
  type AiEnv,
  type CoreEnv
} from "./env.js";

export {
  CHUNK_SOFT_MS,
  CHUNK_STEP,
  MAX_CHUNKS_PER_BRANCH,
  MAX_TOOL_CALL_MS,
  STEP_TIMEOUT_MS,
  STEPS_PER_INSTANCE
} from "./platform.js";

export type { PluginStore } from "./db/db.js";

export {
  makeWorkspaceHandle,
  memoryWorkspaceBacking,
  WorkspaceLimitError,
  WORKSPACE_MAX_FILES,
  WORKSPACE_MAX_FILE_BYTES,
  type WorkspaceBacking,
  type WorkspaceEntry,
  type WorkspaceHandle
} from "./subagent/workspace.js";
