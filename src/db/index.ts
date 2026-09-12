/**
 * `@dynamicagents/core/db` — the tables core owns, and the seam a plugin uses to
 * own its own without touching core's migration journal.
 */

export {
  AgentDB,
  PLUGIN_MIGRATIONS_TABLE,
  type AgentDBOptions,
  type DB,
  type PluginStore
} from "./db.js";

export {
  humanRequests,
  notifyTasks,
  roundObservations,
  subtasks
} from "./schema.js";

export { makeTasks, stateOf, type TaskListQuery } from "./models/tasks.js";

export { makeSubtasks, type SubtaskModelOptions } from "./models/subtasks.js";

export { makeObservations } from "./models/observations.js";

export {
  makeHumanRequests,
  type AnswerVerdict,
  type HumanRequest,
  type HumanRequestStatus
} from "./models/human-requests.js";
