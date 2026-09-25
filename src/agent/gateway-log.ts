/**
 * What a model call tells AI Gateway about itself, so its log row can be tied
 * back to the agent, task and conversation that caused it.
 *
 * AI Gateway's own `metadata` is otherwise `null`, and a row can then only be
 * matched to its task by timestamp. Neutral on purpose: nothing here imports a
 * provider, and a provider that is not behind AI Gateway ignores both fields.
 */

/** AI Gateway's accepted scalar set for a metadata value. */
export type AiGatewayMetadata = Record<string, number | string | boolean>;

/**
 * AI Gateway keeps at most this many custom metadata entries on a request, and
 * under Cloudflare Access it evicts the last one to make room for its own
 * `cf.user_id`. So the keys are spent in {@link PRIORITY} order and the least
 * valuable is the one at risk.
 */
export const GATEWAY_METADATA_MAX = 5;

/** Which kind of call this is. The dimension a gateway dashboard groups by. */
export type GatewayPhase = "round" | "subagent" | "compaction" | "embed";

/**
 * Everything a call site may know about itself. Every field is optional because
 * each site knows a different subset: compaction runs inside a Session shared by
 * every task, so it has no task; a subagent chunk has no Slack turn in scope.
 *
 * There is deliberately no field for the person who sent the turn. `parseTurn`
 * returns their Slack user id beside `channel`, and the only thing keeping it
 * out of an account-retained log is that there is nowhere here to put it —
 * {@link gatewayLogFields} reads these keys and no others, so spreading a whole
 * `ParsedTurn` in cannot leak one either.
 */
export interface GatewayCorrelation {
  agent?: string;
  taskId?: string;
  phase?: GatewayPhase;
  round?: number;
  subtaskId?: number;
  /** Slack channel id — a conversation, not a person. */
  channel?: string;
}

/** The two things a provider forwards to AI Gateway for one pair of models. */
export interface GatewayLogFields {
  /** Custom log metadata, at most {@link GATEWAY_METADATA_MAX} entries. */
  metadata?: AiGatewayMetadata;
  /**
   * The one exact handle for a unit of work — a round or a subtask — in the Logs
   * API's `event_id` filter. Metadata cannot stand in for it: a filter on
   * `metadata.value` matches any key holding that value, so `round` 3 and some
   * other key holding 3 are indistinguishable there.
   */
  eventId?: string;
}

/** Spend order. A key past {@link GATEWAY_METADATA_MAX} is dropped. */
const PRIORITY = [
  "agent",
  "taskId",
  "phase",
  "round",
  "subtaskId",
  "channel"
] as const satisfies readonly (keyof GatewayCorrelation)[];

/**
 * The metadata and event id for one call site. A field that is absent or empty
 * is left out rather than sent as a placeholder, so a filter on a key only ever
 * matches rows that actually know it.
 */
export function gatewayLogFields(
  correlation: GatewayCorrelation
): GatewayLogFields {
  const metadata: AiGatewayMetadata = {};
  let spent = 0;
  for (const key of PRIORITY) {
    const value = correlation[key];
    if (value === undefined || value === "") continue;
    if (spent === GATEWAY_METADATA_MAX) break;
    metadata[key] = value;
    spent += 1;
  }

  const { taskId, round, subtaskId } = correlation;
  const eventId = !taskId
    ? undefined
    : round !== undefined
      ? `${taskId}:r${round}`
      : subtaskId !== undefined
        ? `${taskId}:s${subtaskId}`
        : undefined;

  return {
    ...(spent > 0 ? { metadata } : {}),
    ...(eventId ? { eventId } : {})
  };
}
