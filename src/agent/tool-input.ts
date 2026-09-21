import {
  InvalidToolInputError,
  type ToolCallRepairFunction,
  type ToolSet
} from "ai";

/**
 * A tool call whose arguments arrived as a JSON string holding the object —
 * `"{\"reply\":…}"` where `{"reply":…}` belongs — unwrapped into that object.
 *
 * Common small-model behaviour, and one the model cannot correct from what it is
 * told: the schema error says only "expected object, received string".
 *
 * The SDK's `repairToolCall` hook, so it runs for every tool, control and work
 * alike, in every loop that passes it — and before anything is decided on the
 * call: the unwrapped input is validated exactly as if it had been sent that way.
 * Anything else is left to fail as it would have: a string that does not parse
 * to an object, or a call refused for any other reason.
 */
export const unwrapEncodedInput: ToolCallRepairFunction<ToolSet> = ({
  toolCall,
  error
}) => {
  if (!InvalidToolInputError.isInstance(error)) return Promise.resolve(null);
  const inner = parseJson(toolCall.input);
  return Promise.resolve(
    typeof inner === "string" && isPlainObject(parseJson(inner))
      ? { ...toolCall, input: inner }
      : null
  );
};

/**
 * What a provider accepts as a tool call's arguments: a JSON object, and not an
 * array or `null`, both of which `typeof` calls an object.
 */
export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
