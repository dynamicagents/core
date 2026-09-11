import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import {
  A2A_RPC_PATH,
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  NOTIFICATION_TOKEN_HEADER,
  endpointUrl,
  jwksUrl
} from "@dynamicagents/g2a-protocol";
import type { PlainTask } from "../a2a/task.js";
import { makeGatekeeperToken, TEST_TENANT } from "./auth.js";
import {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  gatekeeperPublicJwks
} from "./fixtures.js";

/**
 * Drive one A2A turn against a Worker the way a gatekeeper does.
 *
 * Core already shipped every *piece* of this — a token signer, Ed25519 fixtures,
 * a fake session, a scripted model — and no assembly, so every consumer wrote the
 * assembly themselves and got the same four things wrong first: the token's
 * audience is the **endpoint** and not the origin, the tenant claim has to match
 * the tenant in the body, `SendMessage` is refused without a push config, and the
 * gatekeeper's own JWKS has to be reachable or verification fails before anything
 * interesting happens.
 *
 * None of that is a property of any one agent, so none of it should be written
 * more than once.
 *
 * ```ts
 * const harness = createAgentHarness({ worker, env, tenant: "reactive" });
 * using _ = harness.interceptGatekeeper();
 *
 * const accepted = await harness.send("what's the weather?");
 * expect(accepted.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
 * ```
 *
 * What it covers is the **synchronous accept**: everything from the gatekeeper's
 * bearer token to the `submitted` Task the Worker returns. The turn itself runs
 * in a Workflow the test runtime does not start, so assert on the callbacks with
 * {@link AgentHarness.callbacks} while driving the workflow body directly with a
 * fake `step`.
 */

/** The minimum of an `ExportedHandler` this harness calls. */
export interface HarnessWorker<TEnv> {
  fetch(request: Request, env: TEnv): Promise<Response> | Response;
}

export interface AgentHarnessOptions<TEnv> {
  /** The Worker module under test — usually `import worker from "@/index"`. */
  worker: HarnessWorker<TEnv>;
  /** The `env` the pool built from `wrangler.jsonc`. */
  env: TEnv;
  /** Which agent to address. Must be a tenant the Worker mounts. */
  tenant?: string;
  /** Where the Worker serves JSON-RPC. Defaults to core's `/a2a`. */
  rpcPath?: string;
  /** The origin the Worker is addressed on. Defaults to the test fixture's. */
  origin?: string;
}

/** One push notification the agent POSTed back, already decoded. */
export interface CapturedCallback {
  /** The `taskId` the callback was about. */
  taskId: string;
  /** The task state, e.g. `TASK_STATE_WORKING`. */
  state: string;
  /** The message text, joined across parts. `""` for a no-reply completion. */
  text: string;
  /** The per-task validation token echoed in the callback header. */
  token: string | null;
  /** The raw decoded body, for anything the projection above drops. */
  body: unknown;
}

export interface AgentHarness {
  /** The endpoint a token is minted for — the audience, not the origin. */
  readonly endpoint: string;
  /** The gatekeeper webhook the agent is told to call back on. */
  readonly pushUrl: string;
  /**
   * Send one turn and return the accepted Task.
   *
   * Throws on a JSON-RPC error rather than returning it, so a spec asserting the
   * happy path fails with the agent's own message instead of on a later
   * `undefined`. Use {@link rpc} for the refusal cases.
   */
  send(text: string, options?: { taskId?: string }): Promise<PlainTask>;
  /**
   * Answer a question a Task asked, the way the gatekeeper does once a person
   * picks an option or types a reply, and return the Task the agent hands back.
   *
   * The message id is derived as the gatekeeper derives an answer's, so calling
   * this twice is the gatekeeper retrying, not a second answer. Throws on a
   * JSON-RPC error, like {@link send}.
   */
  answer(
    taskId: string,
    requestId: string,
    answer:
      { optionId: string; text?: string } | { optionId?: string; text: string },
    options?: { answeredBy?: string }
  ): Promise<PlainTask>;
  /** Tell a Task its question expired unanswered, as the gatekeeper does. */
  timeout(taskId: string, requestId: string): Promise<PlainTask>;
  /**
   * One raw JSON-RPC call with a valid gatekeeper token, returning the `Response`.
   * For specs about what the edge *refuses*.
   */
  rpc(body: unknown, init?: { token?: string }): Promise<Response>;
  /** A valid gatekeeper token for this harness's tenant and endpoint. */
  token(overrides?: { tenant?: string }): Promise<string>;
  /**
   * Stub `fetch` so the gatekeeper's JWKS resolves and every push callback is
   * captured instead of leaving the isolate.
   *
   * Returns a disposable — `using _ = harness.interceptGatekeeper()` — that restores
   * the global on scope exit. Anything neither the JWKS nor the webhook 404s, so
   * an unexpected outbound call fails loudly rather than hanging.
   */
  interceptGatekeeper(): Disposable;
  /** Callbacks captured since {@link interceptGatekeeper}, in arrival order. */
  readonly callbacks: CapturedCallback[];
}

/**
 * Project the push envelope onto the three fields a spec usually asserts.
 *
 * Reads `status.message.parts` — the key the wire form actually uses. It read
 * `content` until `harness.spec.ts` drove a real callback through it, which
 * made `text` the empty string on every capture: silently, since a harness
 * reporting `""` for what an agent said looks exactly like an agent that said
 * nothing, and the no-reply completion is a legitimate outcome.
 */
function projectCallback(
  body: unknown,
  token: string | null
): CapturedCallback {
  const task = (body as { task?: unknown }).task ?? body;
  const t = task as {
    id?: string;
    status?: { state?: string; message?: { parts?: { text?: string }[] } };
  };
  const parts = t.status?.message?.parts ?? [];
  return {
    taskId: t.id ?? "",
    state: t.status?.state ?? "",
    text: parts
      .map((p) => p.text ?? "")
      .join("")
      .trim(),
    token,
    body
  };
}

export function createAgentHarness<TEnv>(
  options: AgentHarnessOptions<TEnv>
): AgentHarness {
  const origin = options.origin ?? AGENT_ORIGIN;
  const rpcPath = options.rpcPath ?? A2A_RPC_PATH;
  // The audience a gatekeeper actually mints: the endpoint this deployment serves,
  // which is also exactly what its card advertises as its interface. Composed
  // with the protocol package's own helper, so a harness cannot agree with the
  // verifier while disagreeing with what a real gatekeeper would send.
  const endpoint = endpointUrl(origin, rpcPath);
  const tenant = options.tenant ?? TEST_TENANT;
  const pushUrl = `${GATEKEEPER_ORIGIN}/a2a/push`;
  const pushToken = "harness-push-token";
  const callbacks: CapturedCallback[] = [];

  const token = (overrides: { tenant?: string } = {}) =>
    makeGatekeeperToken({
      audience: endpoint,
      tenant: overrides.tenant ?? tenant
    });

  const rpc = async (
    body: unknown,
    init: { token?: string } = {}
  ): Promise<Response> =>
    options.worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "A2A-Version": A2A_PROTOCOL_VERSION,
          authorization: `Bearer ${init.token ?? (await token())}`
        },
        body: JSON.stringify(body)
      }),
      options.env
    ) as Promise<Response>;

  /**
   * One `SendMessage` carrying this harness's push config, returning the Task
   * the agent accepted it with — or throwing with the agent's own refusal.
   */
  const sendMessage = async (
    message: Record<string, unknown>
  ): Promise<PlainTask> => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      // `SendMessageRequest` is **flat**: `tenant`, `message`, `configuration`,
      // `metadata`. There is no `request` wrapper, and wrapping is silent when
      // you do it — `fromJSON` drops unknown keys rather than rejecting them,
      // so the whole turn decodes to an empty message with no push config and
      // the agent refuses it for "missing" fields the caller did send.
      //
      // This harness shipped with exactly that envelope. Nothing caught it,
      // because nothing in this package drove the harness against a real
      // Worker until `harness.spec.ts` — which is the argument for that spec
      // existing, made by the code it tests.
      params: {
        tenant,
        message,
        configuration: {
          // Required by the accept-and-notify contract: an agent that replies
          // out of band and is given nowhere to call back has accepted a turn
          // it can never answer.
          taskPushNotificationConfig: { url: pushUrl, token: pushToken }
        }
      }
    });

    const envelope = await res.json<{
      error?: { code: number; message: string };
      result?: { task?: PlainTask } & PlainTask;
    }>();
    if (envelope.error) {
      throw new Error(
        `SendMessage was refused (${envelope.error.code}): ${envelope.error.message}`
      );
    }
    const result = envelope.result;
    const task = (result?.task ?? result) as PlainTask | undefined;
    if (!task) {
      throw new Error(
        `SendMessage returned no task: ${JSON.stringify(envelope)}`
      );
    }
    return task;
  };

  return {
    endpoint,
    pushUrl,
    callbacks,
    token,
    rpc,

    send(text, sendOptions = {}) {
      return sendMessage({
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        // `parts`, not `content`. The decoded `Message` exposes `parts`, and
        // `fromJSON` silently yields an empty list for anything else — so a
        // turn sent under the wrong key arrives as a message with no text and
        // the agent answers a blank prompt.
        parts: [{ text }],
        ...(sendOptions.taskId ? { taskId: sendOptions.taskId } : {})
      });
    },

    answer(taskId, requestId, answer, answerOptions = {}) {
      return sendMessage({
        messageId: `${pushToken}:r:${requestId}`,
        role: "ROLE_USER",
        taskId,
        parts: [
          { text: answer.text ?? answer.optionId },
          {
            data: {
              type: HITL_RESPONSE_TYPE,
              requestId,
              ...answer,
              answeredBy: answerOptions.answeredBy ?? "harness-person"
            },
            mediaType: "application/json"
          }
        ]
      });
    },

    timeout(taskId, requestId) {
      return sendMessage({
        messageId: `${pushToken}:t:${requestId}`,
        role: "ROLE_USER",
        taskId,
        parts: [
          { text: "(No response was received within the allotted time.)" },
          {
            data: { type: HITL_TIMEOUT_TYPE, requestId },
            mediaType: "application/json"
          }
        ]
      });
    },

    interceptGatekeeper() {
      const original = globalThis.fetch;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);

        // The gatekeeper's public JWKS — without it every token fails to verify and
        // every spec below it reports a 401 that has nothing to do with its subject.
        if (url === jwksUrl(GATEKEEPER_ORIGIN)) {
          return new Response(gatekeeperPublicJwks(), {
            headers: { "content-type": "application/json" }
          });
        }

        if (url === pushUrl) {
          const request = new Request(input as RequestInfo, init);
          const body: unknown = await request.json().catch(() => null);
          callbacks.push(
            projectCallback(
              body,
              request.headers.get(NOTIFICATION_TOKEN_HEADER)
            )
          );
          return new Response(null, { status: 202 });
        }

        // Anything else is a call this harness did not expect. 404 rather than
        // pass through: a spec that silently reaches the real network is a spec
        // that passes for the wrong reason.
        return new Response(`unexpected outbound fetch: ${url}`, {
          status: 404
        });
      }) as typeof fetch;

      return {
        [Symbol.dispose]() {
          globalThis.fetch = original;
        }
      };
    }
  };
}
