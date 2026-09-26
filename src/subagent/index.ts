/**
 * `@dynamicagents/core/subagent` — the child an `A2AAgent` dispatches.
 *
 * {@link SubAgent} is the Think agent a starter subclasses once per
 * `SubAgentSpec`; the spec itself is contract, exported from the package root,
 * because a plugin exports it as data without importing this runtime.
 */

export {
  NOTE_MILESTONE,
  SubAgent,
  type NoteData,
  type SubAgentClass
} from "./subagent.js";
