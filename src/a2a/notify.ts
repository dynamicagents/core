import { SignJWT, type JWK } from "jose";
import { TaskState, type Task } from "@a2a-js/sdk";
import { V1PushNotificationSerializer } from "@a2a-js/sdk/server";
import {
  A2A_JWS_ALG,
  NOTIFICATION_TOKEN_HEADER
} from "@dynamicagents/g2a-protocol";
import { agentTextMessage } from "./parts.js";
import type { PlainTask } from "./task.js";

/**
 * Outbound push-notification (accept + notify) helpers — the "notify" half of the
 * async A2A contract. The gatekeeper dispatches `SendMessage` with a
 * `taskPushNotificationConfig` (webhook `url` + validation `token`), we accept
 * immediately with a `submitted` Task, and later POST the terminal Task back to
 * that webhook. This module builds the Task shapes and signs + sends that
 * callback.
 *
 * The callback is authenticated exactly like the AgentCard: a short-lived EdDSA
 * JWT signed by `A2A_SIGNING_KEY`, whose protected header `kid`+`jku` must equal
 * the card's signing `kid`+`jku` (see {@link file://./card.ts} `signCard`) — the
 * gatekeeper pinned those at registration (Trust-On-First-Use) and verifies the
 * callback token against that same public JWKS. No shared secret crosses the
 * boundary; only our public key is ever used to verify.
 */

/**
 * The two shared values on this hop — the signature algorithm and the header
 * carrying the per-task validation `token` — come from
 * `@dynamicagents/g2a-protocol`, the same package the gatekeeper reads them from.
 *
 * A slightly different case from the claim names: the value is `@a2a-js/sdk`'s
 * own default for `tokenHeaderName`, not Dynamic Agents' choice, but the SDK
 * never *exports* it — it exists only as an inline fallback — so neither side
 * can import it, and the protocol package is where it is written down once
 * rather than on both sides.
 *
 * Re-exported so `@dynamicagents/core/a2a` keeps being where an agent finds it.
 */
export { NOTIFICATION_TOKEN_HEADER } from "@dynamicagents/g2a-protocol";

/**
 * Callback-JWT lifetime, in seconds. The gatekeeper enforces `maxTokenAge: 10m` with a
 * 60s clock tolerance, so keep this comfortably under that.
 */
export const CALLBACK_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * The SDK's canonical v1.0 push-notification body encoder: the `StreamResponse`
 * envelope as protobuf-JSON, with content type `application/a2a+json`. v1.0
 * moved push notifications onto the same envelope the streaming transports use
 * (v0.3 POSTed a bare `Task`), so the encoding is the SDK's rather than ours —
 * the gatekeeper decodes it with `StreamResponse.fromJSON`.
 */
const PUSH_SERIALIZER = new V1PushNotificationSerializer();

/** A Task snapshot in `state` carrying no message — nothing to say, only a state change. */
function buildBareTask(
  taskId: string,
  contextId: string,
  state: TaskState
): PlainTask {
  return {
    id: taskId,
    contextId,
    status: {
      state,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

/**
 * The `submitted` Task we return synchronously to accept a turn (A2A §7.2). The
 * gatekeeper only requires a non-empty `id`; the actual reply follows later via the
 * callback.
 */
export function buildSubmittedTask(
  taskId: string,
  contextId: string
): PlainTask {
  return buildBareTask(taskId, contextId, TaskState.TASK_STATE_SUBMITTED);
}

/**
 * The terminal `completed` Task for a turn the agent deliberately did not
 * answer — a turn an `AgentPlugin.shouldHandleTurn` gate declined, or whatever
 * else a host treats as "nothing to say". Same shape as
 * {@link buildSubmittedTask}: **no `status.message` at all**.
 *
 * The callback is still POSTed. The gatekeeper's pending row has to resolve — we
 * simply hand it nothing to post to Slack. There is no `messageId` because there
 * is no message, so unlike {@link buildCompletedTask} nothing needs a stable id
 * for the gatekeeper to dedupe on: a `notify`-step retry re-delivers no content and
 * is idempotent by construction.
 */
export function buildNoReplyCompletedTask(
  taskId: string,
  contextId: string
): PlainTask {
  return buildBareTask(taskId, contextId, TaskState.TASK_STATE_COMPLETED);
}

/**
 * A Task snapshot POSTed to the gatekeeper callback in a given `state`, carrying one
 * `agent` message. The gatekeeper reads the reply from `status.message.parts`, so
 * the text lives there.
 */
function buildTaskUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  text: string,
  messageId: string
): PlainTask {
  const task = buildBareTask(taskId, contextId, state);
  task.status.message = agentTextMessage({
    messageId,
    text,
    contextId,
    taskId
  });
  return task;
}

/**
 * A non-terminal `working` Task snapshot carrying an intermediate content message.
 * Streamed live from the DO as the tool loop emits content before the final reply.
 *
 * `messageId` is derived from `${taskId}:${key}` — stable across re-runs (see
 * {@link agentTextMessage}) so the gatekeeper dedupes correctly on workflow replay.
 *
 * `key` is a **semantic** string, not a step counter, and the distinction is
 * load-bearing: an agent that runs several rounds per task emits progress from
 * each, so a bare index makes round 0's third step and round 1's third step the
 * same message to the gatekeeper — it dedupes the second away and the user watches
 * a task go quiet. A caller that genuinely has one flat sequence can pass
 * `String(i)`; one with rounds should key on both (`r1:step:3`), and milestones
 * on what they are (`ack:1`).
 */
export function buildWorkingTask(
  taskId: string,
  contextId: string,
  text: string,
  key: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_WORKING,
    text,
    `${taskId}:${key}`
  );
}

/**
 * The terminal `completed` Task POSTed to the gatekeeper callback. The `messageId` is
 * deterministic (`${taskId}:final`, not a fresh UUID) because this is built in the
 * workflow body, which re-runs on replay: a random id would change on a notify-step
 * retry and the gatekeeper would dedupe the final message as a new one and double-post.
 */
export function buildCompletedTask(
  taskId: string,
  contextId: string,
  reply: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_COMPLETED,
    reply,
    `${taskId}:final`
  );
}

/**
 * The terminal `failed` Task POSTed to the gatekeeper callback — an unexpected,
 * non-transient failure aborted the turn.
 *
 * A2A v1.0 gives a task no structured error (`TaskStatus` is only
 * `{state, message, timestamp}`), so the state *is* the failure signal and `text`
 * is the only place to explain. Keep that text user-safe: the gatekeeper renders it
 * to a human, under its own "⚠️ *Agent …* (failed):" prefix.
 *
 * Shares the `${taskId}:final` messageId with {@link buildCompletedTask} by
 * design: a Task terminates exactly once and the two states are mutually
 * exclusive, so only one of them is ever built and posted — and a notify retry
 * re-posts that same one under the same dedupe key.
 */
export function buildFailedTask(
  taskId: string,
  contextId: string,
  text: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_FAILED,
    text,
    `${taskId}:final`
  );
}

/**
 * Sign the callback JWT the gatekeeper verifies against our pinned card key. The
 * protected header mirrors the card signature (`kid`+`jku`); `aud` must equal the
 * exact webhook URL the gatekeeper handed us in the `taskPushNotificationConfig`.
 */
export async function signCallbackJwt(
  privateJwk: JWK & { kid: string },
  opts: { jku: string; aud: string }
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({
      alg: A2A_JWS_ALG,
      kid: privateJwk.kid,
      jku: opts.jku
    })
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(`${CALLBACK_TOKEN_TTL_SECONDS}s`)
    .sign(privateJwk);
}

/**
 * POST a Task snapshot to the gatekeeper's push-notification webhook, wrapped in the
 * v1.0 `StreamResponse` envelope. Returns the raw `Response` so the caller (the
 * workflow's `notify` step) can decide whether a non-2xx warrants a retry.
 */
export async function postNotification(
  url: string,
  token: string,
  jwt: string,
  task: Task
): Promise<Response> {
  const { body, contentType } = PUSH_SERIALIZER.serialize({
    payload: { $case: "task", value: task }
  });
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": contentType,
      authorization: `Bearer ${jwt}`,
      [NOTIFICATION_TOKEN_HEADER]: token
    },
    body
  });
}
