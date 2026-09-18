import type { Task } from "@a2a-js/sdk";
import type { OnContent } from "../agent/inference.js";
import { parsePrivateJwk } from "./card.js";
import {
  CALLBACK_TOKEN_TTL_SECONDS,
  buildWorkingTask,
  postNotification,
  signCallbackJwt
} from "./notify.js";

/**
 * The gatekeeper callback channel for one accepted turn.
 *
 * Every agent that accepts asynchronously has to do the same four things with
 * the push config the gatekeeper handed it: sign a callback JWT against the
 * deployment's card key, POST `working` snapshots as the model reasons, POST the
 * terminal Task, and never let a failed progress post take down a turn. That was
 * written out longhand in four places across two agents in the starter — twice as
 * a `streamWorking` closure inside a Durable Object, twice as a `notify` step
 * inside a Workflow — with the signing, the header names and the swallow-and-log
 * discipline duplicated each time.
 *
 * It is one object here because none of it is per-agent. What *is* per-agent is
 * the notification **key**, and that is the one thing a caller supplies.
 */

/**
 * Everything needed to call a gatekeeper back about one task.
 *
 * RPC-serializable by construction: it crosses the Workflow → Durable Object
 * boundary on every turn, so it holds only strings.
 */
export interface TurnPushContext {
  /** The accepted task id (echoed on every callback of this turn). */
  taskId: string;
  /** A2A context id, echoed on every callback. */
  contextId: string;
  /** Gatekeeper push-notification webhook (also the callback JWT `aud`). */
  pushUrl: string;
  /** Per-task validation token the gatekeeper set; echoed in the callback header. */
  pushToken: string;
  /** This agent's card-signing JWKS URL — the callback JWT `jku` (pinned key). */
  jku: string;
}

export interface PushChannel {
  /**
   * POST one `working` Task snapshot, keyed by a stable semantic `key`.
   *
   * **Best-effort**: every failure is logged and swallowed, so a progress post
   * can never abort generation or fail a durable step. The key is what lets the
   * gatekeeper dedupe a re-posted event on replay, so it must be derived from
   * position (`r2:step:3`), never from content or a clock.
   */
  working(text: string, key: string): Promise<void>;
  /**
   * An {@link OnContent} sink that posts each intermediate message as a
   * `working` snapshot, signing the JWT once and reusing it across the turn.
   *
   * `key` maps a 0-based step ordinal to its notification key. An agent running
   * one turn per task can use the bare index; an agent with rounds **must**
   * include the round, or two rounds of one task collide on the gatekeeper.
   */
  stream(key: (stepIndex: number) => string): OnContent;
  /**
   * POST the terminal Task. **Throws on a non-2xx** so the calling Workflow step
   * retries — the opposite of {@link working}, because this is the delivery the
   * whole turn exists for.
   */
  deliver(task: Task): Promise<void>;
}

/** How long a signed callback JWT is reused: its lifetime, less a minute. */
const REUSE_MS = (CALLBACK_TOKEN_TTL_SECONDS - 60) * 1000;

/**
 * Build the callback channel for one turn.
 *
 * `signingKey` is the deployment's Ed25519 private JWK as JSON — `A2A_SIGNING_KEY`
 * by default. There is one per origin, not one per agent: the card sits at a
 * well-known URI, which RFC 8615 defines per-authority, so this origin publishes
 * one card and the gatekeeper pins one key for every agent on it.
 */
export function createPushChannel(
  signingKey: string,
  push: TurnPushContext
): PushChannel {
  // Signed lazily and reused: one turn can post many progress snapshots, and
  // re-signing per message costs a key import each time for no benefit. Reused
  // only until a minute before it expires, because a round or a facet chunk
  // outlives the token and the gatekeeper refuses a post that carries a dead one.
  let signed: { jwt: Promise<string>; at: number } | undefined;
  const sign = (): Promise<string> => {
    const now = Date.now();
    if (!signed || now - signed.at >= REUSE_MS) {
      signed = {
        jwt: signCallbackJwt(parsePrivateJwk(signingKey), {
          jku: push.jku,
          aud: push.pushUrl
        }),
        at: now
      };
    }
    return signed.jwt;
  };

  const post = async (task: Task): Promise<Response> =>
    postNotification(push.pushUrl, push.pushToken, await sign(), task);

  const working = async (text: string, key: string): Promise<void> => {
    try {
      const res = await post(
        buildWorkingTask(push.taskId, push.contextId, text, key)
      );
      if (!res.ok) {
        console.warn("[push] working notification non-2xx", {
          taskId: push.taskId,
          key,
          status: res.status
        });
      }
    } catch (err) {
      // Swallowed on purpose, including a signing failure: a turn that cannot
      // report its progress is still a turn that should deliver its answer.
      console.warn("[push] working notification failed", {
        taskId: push.taskId,
        key,
        err: String(err)
      });
    }
  };

  return {
    working,

    stream(key) {
      return (text, stepIndex) => working(text, key(stepIndex));
    },

    async deliver(task) {
      const res = await post(task);
      if (!res.ok) {
        throw new Error(`gatekeeper notification failed: HTTP ${res.status}`);
      }
    }
  };
}
