/**
 * `@dynamicagents/core/workflow` — the task workflow.
 *
 * {@link TaskWorkflow} owns a task's steps and the state between them, one
 * instance per task, id = task id. A consumer's pipeline subclasses it, declares
 * `run()`, and writes `pipeline()` with `step.agent`, `step.ask`, `step.say`
 * and `step.do`. The task it runs for is its host's (`/task`); the jobs its
 * steps start are step agents' (`/agent`).
 */

export {
  TaskWorkflow,
  WAIT_CEILING,
  type AgentStepOptions,
  type StepAgentStub,
  type TaskHostStub,
  type TaskStep
} from "./workflow.js";
export {
  answerEventType,
  digest,
  reportEventType,
  stepJobIdFor
} from "./keys.js";
export type {
  AskRequest,
  NotedStepJob,
  PipelineResult,
  StepAnswer,
  StepJob,
  StepJobReport,
  TaskParams,
  TaskResult
} from "./types.js";
