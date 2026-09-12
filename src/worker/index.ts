import { AGENT_CARD_PATH, SendMessageRequest } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  validateVersion
} from "@a2a-js/sdk/server";
import { RequestMalformedError, toJsonRpcError } from "@a2a-js/sdk/errors";
import {
  HITL_RESPONSE_TYPE,
  HITL_TIMEOUT_TYPE,
  JWKS_PATH,
  endpointUrl
} from "@dynamicagents/g2a-protocol";
import {
  A2A_RPC_PATH,
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard,
  signCardInPlace,
  type AgentManifest
} from "../a2a/card.js";
import { buildCallContext, extensionHeaders } from "../a2a/context.js";
import {
  GatekeeperAuthError,
  bearerToken,
  verifyGatekeeperToken,
  type GatekeeperIdentity
} from "../a2a/verify.js";
import {
  A2AExecutor,
  type TurnResumer,
  type TurnStarter
} from "../a2a/executor.js";
import { readHumanReply } from "../a2a/hitl.js";
import { inboundTextError } from "../a2a/parts.js";
import { DurableTaskStore } from "../a2a/task-store.js";
import type { AgentResolver } from "../a2a/agent-stub.js";
import { parseGatekeeperOrigins, type A2ASecretsEnv } from "../env.js";
import type { MountedAgent } from "./define-agent.js";

/**
 * The A2A Worker: the zero-trust, no-shared-secrets edge every Dynamic Agent
 * puts in front of its Durable Object.
 *
 * Trust flows entirely on domains and asymmetric (Ed25519) signatures over
 * public JWKS: a gatekeeper verifies and pins this agent's identity from its signed
 * card at registration ("G knows R"), and this Worker verifies the gatekeeper's
 * identity JWT on every JSON-RPC call ("R knows G"). No secret is ever shared in
 * either direction.
 *
 * **Several agents share one Worker, addressed by `tenant`.** They share one
 * origin, one endpoint, one signing key and one card at the well-known path;
 * what differs is the tenant id on every request. That is the A2A mechanism for
 * exactly this — `AgentInterface.tenant` is "an opaque string used for routing
 * requests to a specific agent or tenant when multiple agents are served behind
 * a single A2A endpoint", and §8.3.2 requires a client to send the value the
 * selected interface declared.
 *
 * A tenant is **required on every request**. There is no default and no
 * implicit routing: an absent tenant is an error, because guessing one would
 * mean picking an agent the caller never named.
 *
 * This replaces mounting a handler per path prefix. That could not work: the
 * card is a **well-known URI**, which RFC 8615 defines per-authority, so only
 * one card per origin is discoverable at the registered path — a gatekeeper
 * resolving `…/.well-known/agent-card.json` against the origin found whichever
 * agent owned the bare path and pinned *its* key for all of them.
 *
 * Three routes:
 *
 *  1. `GET jwksPath` — the card-signing public JWKS, resolving every card's
 *     `jku`.
 *  2. `GET …/.well-known/agent-card.json` — the signed **stub** card for the
 *     origin. Matched by suffix, since that path is fixed by the spec.
 *  3. `POST rpcPath` — gatekeeper-authenticated JSON-RPC, routed to the named
 *     tenant. `GetExtendedAgentCard` returns that tenant's own signed card;
 *     everything else runs a turn against its Durable Object.
 *
 * Two independent checks keep one tenant's traffic out of another's:
 * `audience` proves the token was minted for this deployment, and
 * {@link file://../a2a/verify.ts TENANT_CLAIM} proves it was minted for *this
 * agent on it*. The second is what makes `tenant` more than an unauthenticated
 * routing hint in the request body.
 */

export {
  defineAgent,
  type AgentDefinition,
  type DefineAgentOptions,
  type MountedAgent
} from "./define-agent.js";

/**
 * Default path serving the card-signing public JWKS (the card's `jku`).
 *
 * From `@dynamicagents/g2a-protocol`, because the gatekeeper serves its own JWKS at
 * the same path and fetches ours from whatever `jku` says — see
 * {@link file://../a2a/verify.ts} for why the two sides share a package rather
 * than a comment. Re-exported so this stays importable from
 * `@dynamicagents/core/worker`, where it has always lived.
 */
export { JWKS_PATH } from "@dynamicagents/g2a-protocol";

/** The JSON-RPC method carrying a turn (v1.0 renamed v0.3's `message/send`). */
const SEND_MESSAGE_METHOD = "SendMessage";

/** The JSON-RPC method that cancels a Task. */
const CANCEL_TASK_METHOD = "CancelTask";

/** The two secrets a mount signs and verifies with, already read off `env`. */
export interface A2ASecrets {
  /** Ed25519 private JWK, as JSON. See {@link A2ASecretsEnv.A2A_SIGNING_KEY}. */
  signingKey: string;
  /** Origin allowlist. See {@link A2ASecretsEnv.GATEKEEPER_ORIGINS}. */
  gatekeeperOrigins: string;
}

/** One agent served on this origin — everything that differs between tenants. */
export interface TenantAgent {
  /** The transport-independent half of this agent's card. */
  manifest: AgentManifest;
  /** Resolve the agent DO stub for a verified caller. */
  resolveAgent: AgentResolver;
  /** Start the durable turn. Must be idempotent — see {@link TurnStarter}. */
  startTurn: TurnStarter;
  /**
   * Wake a Task's run once a question it asked is answered — see
   * {@link TurnResumer}. Absent, a message on one of this agent's Tasks is
   * refused, which is right for an agent whose Tasks never ask.
   */
  resumeTurn?: TurnResumer;
}

export interface A2AWorkerOptions<TEnv = A2ASecretsEnv> {
  /**
   * The **stub** card served at the well-known path.
   *
   * It describes the origin, not an agent. Every agent here is a tenant and its
   * card is reached through `GetExtendedAgentCard`, so this card exists to be
   * the one conformant, signed AgentCard at the URI RFC 8615 and the A2A IANA
   * registration reserve — advertising the endpoint, the protocol binding and
   * `extendedAgentCard`.
   *
   * It cannot enumerate the tenants: a card carries one interface entry and
   * spec §8.3.2 has clients take the first, so listing siblings there would
   * just make every client address the same one. Put their names in
   * `description` for a human, and register them out of band.
   */
  manifest: AgentManifest;
  /**
   * The agents on this origin, keyed by tenant id.
   *
   * The id is opaque to the protocol — "an opaque string used for routing
   * requests to a specific agent or tenant when multiple agents are served
   * behind a single A2A endpoint". A caller names one on every request and this
   * Worker refuses a request that does not.
   *
   * The tenant chooses *which agent*; the verified `identity.key` still chooses
   * *which instance of it*, so two callers of one tenant stay in separate
   * Durable Objects exactly as before.
   *
   * The escape hatch, and still fully supported: use it for an agent whose
   * routing or turn-start is genuinely its own. {@link A2AWorkerOptions.agents}
   * is the shorter form for the ordinary case. Supply at least one of the two.
   */
  tenants?: Record<string, TenantAgent>;
  /**
   * The agents on this origin, each declared once with
   * {@link file://./define-agent.ts defineAgent}.
   *
   * Prefer this to {@link A2AWorkerOptions.tenants}: one declaration produces the
   * tenant entry here *and* the resolver the agent's Workflow entrypoint uses, so
   * the two cannot drift, and the binding names are type-constrained to bindings
   * of the right kind. Merged over `tenants`, which is checked for duplicate
   * tenant ids rather than silently overriding.
   */
  agents?: readonly MountedAgent<TEnv>[];
  /** Path serving the public JWKS. Defaults to {@link JWKS_PATH}. */
  jwksPath?: string;
  /** Path this agent answers JSON-RPC on. Defaults to `/a2a`. */
  rpcPath?: string;
  /**
   * Where to read this deployment's two secrets. Defaults to the documented
   * names, `env.A2A_SIGNING_KEY` and `env.GATEKEEPER_ORIGINS`.
   *
   * There is **one signing key per origin**, not one per tenant: the card is
   * per-origin now, so the key the gatekeeper pins is too. Nothing was lost — the
   * tenants share a Worker and an `env`, so they could always read each other's
   * secrets, and separate keys never expressed a boundary that existed.
   *
   * ```ts
   * secrets: (env) => ({
   *   signingKey: env.AGENT_KEY,
   *   gatekeeperOrigins: env.ALLOWED_GATEKEEPERS
   * })
   * ```
   *
   * Renaming does not weaken anything: the same key is still Ed25519, still
   * signs the cards and every callback JWT, and its public half is still what
   * the gatekeeper pins. Only where it is read from changes.
   */
  secrets?: (env: TEnv) => A2ASecrets;
  /**
   * The audience a gatekeeper JWT must carry.
   *
   * Defaults to this deployment's **own endpoint** — `${origin}${rpcPath}`, the
   * same URL its cards advertise as their interface — and that default is
   * almost certainly what you want. Setting this is for a gatekeeper that mints
   * something else.
   *
   * The audience is one half of a two-sided contract: whatever is required here
   * has to be exactly what the calling gatekeeper *mints*, and a mismatch is a 401
   * on every request. slack-gatekeeper mints
   * `new URL(agent.a2aEndpoint).origin + pathname`, which is what this default
   * matches.
   *
   * It proves the token was minted for **this deployment**, and deliberately
   * says nothing about which agent on it — every tenant shares one endpoint and
   * therefore one audience. {@link file://../a2a/verify.ts TENANT_CLAIM} is what
   * separates them, and is the check to look at when reasoning about one agent
   * spending another's token.
   */
  audience?: string | ((url: URL) => string);
  /**
   * Advertise `securitySchemes` on the card. **Defaults to `false`** — see
   * `BuildCardOptions.advertiseSecuritySchemes` for why, and read that note
   * before turning it on.
   */
  advertiseSecuritySchemes?: boolean;
  /** Claim carrying the caller identity. Defaults to the Dynamic Agents namespace. */
  identityClaim?: string;
  /**
   * Claim carrying the authorized tenant. Defaults to the Dynamic Agents namespace.
   *
   * Both claim names are one side of the same contract as `audience`: whatever
   * is named here has to be exactly what the calling gatekeeper *mints*. Override
   * them together, or not at all — a deployment fronted by something other than
   * slack-gatekeeper that renames only the identity claim keeps reading the
   * tenant from a key its gatekeeper never sets, and every request 401s on the
   * empty-tenant comparison below.
   */
  tenantClaim?: string;
  /**
   * Require a `taskPushNotificationConfig` on every `SendMessage`.
   *
   * Defaults to `true`, which is the accept-and-notify contract: the agent
   * accepts synchronously and delivers out of band, so a send with nowhere to
   * call back is a request that can never be answered. Set `false` only for an
   * agent that replies inline.
   */
  requirePushConfig?: boolean;
}

function unauthorized(reason: string): Response {
  return new Response(`unauthorized: ${reason}`, {
    status: 401,
    headers: { "www-authenticate": 'Bearer error="invalid_token"' }
  });
}

/**
 * A JSON-RPC error envelope for a failure raised before the SDK handler ran,
 * echoing the request's `id` so a conformant client can correlate it. Errors are
 * transported at HTTP 200 per JSON-RPC 2.0, matching what the SDK handler
 * returns for the failures it maps itself.
 *
 * Takes an already-mapped `error` because the mapper has to match the error's
 * origin: `@a2a-js/sdk/errors` and `@a2a-js/sdk/server` are separately bundled
 * entry points that each carry their own copy of the error hierarchy, so a
 * mapper only recognizes errors its own bundle constructed — the other one fails
 * its `instanceof` check and flattens every semantic error to a generic internal
 * error. Each call site below picks accordingly.
 */
function jsonRpcErrorResponse(
  body: unknown,
  error: { code: number; message: string }
): Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  return Response.json({ jsonrpc: "2.0", id, error });
}

/**
 * Why a `SendMessage` fails the async-only contract, or `undefined` when it
 * holds. (Other methods carry no config and are always fine.)
 *
 * Checked here, before the SDK handler, rather than in the executor: an executor
 * throw is turned into a `failed` task, which a client reads as an accepted turn
 * that never calls back. A rejected send has to surface as a JSON-RPC error.
 */
function pushConfigError(rpcBody: {
  method?: string;
  params?: unknown;
}): string | undefined {
  if (rpcBody.method !== SEND_MESSAGE_METHOD) return undefined;

  // Decode through the generated codec rather than reading the raw body: the
  // wire form is protobuf-JSON, so this is what normalizes field naming and
  // oneof shapes into the typed request the SDK handler will also see.
  let params: SendMessageRequest;
  try {
    params = SendMessageRequest.fromJSON(rpcBody.params);
  } catch (err) {
    return `params are not a valid SendMessageRequest: ${(err as Error).message}`;
  }

  const pushConfig = params.configuration?.taskPushNotificationConfig;
  if (!pushConfig?.url) {
    return (
      "configuration.taskPushNotificationConfig.url is required: this agent " +
      "replies asynchronously via push notification (A2A §13.2)"
    );
  }
  if (!pushConfig.token) {
    return (
      "configuration.taskPushNotificationConfig.token is required: the gatekeeper " +
      "uses it to correlate the callback to the pending task (A2A §13.2)"
    );
  }
  try {
    new URL(pushConfig.url);
  } catch {
    return `configuration.taskPushNotificationConfig.url is not a valid URL: ${pushConfig.url}`;
  }
  return undefined;
}

/**
 * Why a `SendMessage`'s text is refused for its size, or `undefined` when it may
 * go on. Applies to a message that begins a Task and to one answering a question
 * alike: the bound is on any text crossing the link.
 *
 * Here rather than at the executor for the reason {@link continuationError}
 * gives, and for one more. The text of a message that begins a Task goes into a
 * Workflow's parameters, which the platform caps: past this point the failure is
 * an instance that will not start, reported against a Task the caller was told
 * it had. The same sentence, said here, is a caller that can send a shorter one.
 */
function messageTextError(rpcBody: {
  method?: string;
  params?: unknown;
}): string | undefined {
  if (rpcBody.method !== SEND_MESSAGE_METHOD) return undefined;
  let params: SendMessageRequest;
  try {
    params = SendMessageRequest.fromJSON(rpcBody.params);
  } catch {
    // A malformed request is the handler's to refuse, with its own message.
    return undefined;
  }
  return params.message ? inboundTextError(params.message) : undefined;
}

/**
 * Why a `SendMessage` naming an existing Task is refused, or `undefined` when it
 * may go on. A message naming no Task begins one, and is no concern of this.
 *
 * A message on a Task is only ever the answer to a question that Task asked, and
 * only an agent that can wake the run waiting on it may take one. Refused here as
 * a JSON-RPC error, because past this point a refusal would be an executor throw —
 * which the handler turns into a failed Task, ending the Task the person was
 * answering.
 */
function continuationError(
  rpcBody: { method?: string; params?: unknown },
  resumable: boolean
): string | undefined {
  if (rpcBody.method !== SEND_MESSAGE_METHOD) return undefined;
  let params: SendMessageRequest;
  try {
    params = SendMessageRequest.fromJSON(rpcBody.params);
  } catch {
    // A malformed request is the handler's to refuse, with its own message.
    return undefined;
  }
  const message = params.message;
  if (!message?.taskId) return undefined;
  if (!resumable) {
    return (
      "this agent takes no messages on an existing task: none of its tasks " +
      "asks a question to be answered"
    );
  }
  if (!readHumanReply(message)) {
    return (
      "a message on an existing task must answer the question the task asked, " +
      `in a ${HITL_RESPONSE_TYPE} or ${HITL_TIMEOUT_TYPE} data part`
    );
  }
  return undefined;
}

/**
 * Wake the run of a Task just canceled while it waited on a question.
 *
 * Needed because the cancel reaches the Durable Object through the task store,
 * and nothing there can reach a Workflow: without this, a canceled Task's run
 * sits waiting on its question until the question expires. Best-effort — a
 * missed wake is read at that expiry instead.
 */
async function wakeCanceled(
  agent: TenantAgent,
  identity: GatekeeperIdentity,
  params: unknown
): Promise<void> {
  const taskId = (params as { id?: unknown } | undefined)?.id;
  if (typeof taskId !== "string" || !taskId || !agent.resumeTurn) return;
  try {
    const stub = agent.resolveAgent(identity);
    if (typeof stub.humanWake !== "function") return;
    const wake = await stub.humanWake(taskId);
    if (wake) await agent.resumeTurn(wake);
  } catch (err) {
    console.warn("[worker] could not wake a canceled task's run", {
      taskId,
      err: String(err)
    });
  }
}

/**
 * Build the Worker `fetch` handler.
 *
 * ```ts
 * const handler = createA2AWorker({
 *   manifest: hostManifest,
 *   tenants: {
 *     reactive: { manifest, resolveAgent: getAgent, startTurn }
 *   }
 * });
 * export default { fetch: handler } satisfies ExportedHandler<Env>;
 * ```
 *
 * Two overloads, because `secrets` is optional for exactly one shape of `env`.
 * An `env` carrying the two documented names needs no reader; anything else has
 * to say where its keys live, and the type system is where that gets enforced —
 * the alternative is a `parsePrivateJwk` failure on the first request, which is
 * both later and much harder to read.
 */
// An `env` with the documented names: the default reader works, `secrets` is optional.
export function createA2AWorker<TEnv extends A2ASecretsEnv>(
  options: A2AWorkerOptions<TEnv>
): (request: Request, env: TEnv) => Promise<Response>;
// Anything else — a renamed key — must supply the reader.
export function createA2AWorker<TEnv extends object>(
  options: A2AWorkerOptions<TEnv> & {
    secrets: (env: TEnv) => A2ASecrets;
  }
): (request: Request, env: TEnv) => Promise<Response>;
export function createA2AWorker<TEnv extends object>(
  options: A2AWorkerOptions<TEnv>
): (request: Request, env: TEnv) => Promise<Response> {
  // Normalized once, here, because each of these is used for two things that
  // must agree: routing compares it against `url.pathname`, and `endpointUrl`
  // composes it into the card's interface URL and the expected audience. A
  // configured path written without its leading slash used to satisfy neither —
  // `url.pathname` always has one, so the route simply never matched, and the
  // audience came out as `https://hostpath`. Normalizing at the split keeps the
  // two derivations from disagreeing whichever way it is written.
  const withSlash = (path: string) =>
    path.startsWith("/") ? path : `/${path}`;
  const jwksPath = withSlash(options.jwksPath ?? JWKS_PATH);
  const rpcPath = withSlash(options.rpcPath ?? A2A_RPC_PATH);
  const requirePushConfig = options.requirePushConfig ?? true;
  const declared = options.tenants ?? {};
  const defined = options.agents ?? [];
  // A tenant declared both ways is ambiguous, and silently letting one win is how
  // a deployment serves an agent nobody meant to mount. Caught at startup.
  const duplicate = defined.find((a) => Object.hasOwn(declared, a.tenant));
  if (duplicate) {
    throw new Error(
      `createA2AWorker got tenant '${duplicate.tenant}' from both \`agents\` and ` +
        "`tenants` — declare each agent once"
    );
  }
  // …and the same ambiguity within `agents` alone, which the check above cannot
  // see. `definedByTenant` below is a `Map`, so a repeated id silently keeps the
  // *last* entry: two `defineAgent` calls sharing a tenant would mount one and
  // discard the other with no signal anywhere. That is the identical failure the
  // cross-check exists to prevent, reached by copy-pasting a declaration rather
  // than by mixing the two forms — which is the likelier mistake of the two.
  const seen = new Set<string>();
  for (const agent of defined) {
    if (seen.has(agent.tenant)) {
      throw new Error(
        `createA2AWorker got tenant '${agent.tenant}' twice in \`agents\` — ` +
          "declare each agent once"
      );
    }
    seen.add(agent.tenant);
  }
  // Nothing can be served without at least one agent, and a deployment that
  // configured none is a startup mistake rather than a per-request one.
  const tenantIds = [...Object.keys(declared), ...defined.map((a) => a.tenant)];
  if (tenantIds.length === 0) {
    throw new Error(
      "createA2AWorker requires at least one agent — pass `agents` or `tenants`"
    );
  }
  // …and one registered under `""` is the same mistake wearing a disguise. A
  // request must name a tenant, and the empty string is how "named none" is
  // spelled, so that agent is registered and permanently unreachable — every
  // call to it is refused as a missing tenant before the lookup ever runs. The
  // check above would otherwise report a deployment with no routable agent as
  // satisfying "at least one tenant".
  if (tenantIds.some((id) => !id)) {
    throw new Error(
      "createA2AWorker requires every tenant id to be non-empty: a request " +
        "names its tenant, so an agent registered under '' can never be reached"
    );
  }
  const definedByTenant = new Map(defined.map((a) => [a.tenant, a]));
  // The tenant id is caller-controlled, so the lookup is by *own* property.
  // Plain indexing reaches `Object.prototype`, and every inherited name —
  // `toString`, `constructor`, `__proto__` — comes back truthy, so a tenant
  // called one of those slips past an `if (!agent)` guard and only fails later
  // when a function is read off it. That is a 500 where the whole point of the
  // guard is a 400 naming the unknown tenant. (A `Map` has no such inheritance,
  // so the `agents` half needs no equivalent guard.)
  //
  // Takes `env` because a `defineAgent` entry resolves its bindings from it —
  // there is no `env` at module scope on Workers, so the closure is built per
  // request rather than at construction.
  const tenantAgent = (env: TEnv, id: string): TenantAgent | undefined => {
    if (Object.hasOwn(declared, id)) return declared[id];
    const agent = definedByTenant.get(id);
    if (!agent) return undefined;
    return {
      manifest: agent.manifest,
      resolveAgent: (identity) => agent.resolveAgent(env, identity),
      startTurn: (turn) => agent.startTurn(env, turn),
      ...(agent.resumeTurn
        ? { resumeTurn: (wake) => agent.resumeTurn!(env, wake) }
        : {})
    };
  };
  // Only reachable through the first overload, which has already established
  // that `TEnv` carries the two documented names.
  const readSecrets =
    options.secrets ??
    ((env: TEnv): A2ASecrets => ({
      signingKey: (env as A2ASecretsEnv).A2A_SIGNING_KEY,
      gatekeeperOrigins: (env as A2ASecretsEnv).GATEKEEPER_ORIGINS
    }));

  return async function fetch(request: Request, env: TEnv): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const secrets = readSecrets(env);
    // This agent's own endpoint, which is also exactly what its card advertises
    // as its interface — so the value the gatekeeper was registered with and the
    // value checked here are the same string by construction.
    const audience =
      typeof options.audience === "function"
        ? options.audience(url)
        : (options.audience ?? endpointUrl(origin, rpcPath));
    const privateJwk = parsePrivateJwk(secrets.signingKey);
    const signing = { privateJwk, jku: endpointUrl(origin, jwksPath) };
    const cardFor = (manifest: AgentManifest, tenant?: string) =>
      buildBaseCard(manifest, {
        origin,
        rpcPath: options.rpcPath,
        advertiseSecuritySchemes: options.advertiseSecuritySchemes,
        tenant
      });

    // (1) Card-signing public JWKS — resolves every card's `jku` for the
    // gatekeeper. One key per origin, so one JWKS for every tenant.
    if (request.method === "GET" && url.pathname === jwksPath) {
      return Response.json(publicCardJwks(privateJwk), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // (2) The stub card, at the well-known path. `signCard` returns the
    // protobuf-JSON encoding — the exact document the signature is computed
    // over — so it is serialized here without re-encoding.
    if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
      return Response.json(await signCard(cardFor(options.manifest), signing));
    }

    // (3) A2A JSON-RPC — gatekeeper-authenticated, dispatched into the caller's DO.
    //
    // Matched on `rpcPath`, not on the method alone. Accepting every POST made
    // the path this agent advertises purely decorative: a call to any URL on the
    // origin was served as JSON-RPC, so a mounted agent's isolation rested
    // entirely on an outer router matching first, and a typo'd endpoint quietly
    // worked instead of 404ing.
    if (request.method === "POST" && url.pathname === rpcPath) {
      const token = bearerToken(request);
      if (!token) return unauthorized("missing gatekeeper bearer token");

      let identity: GatekeeperIdentity;
      let authorizedTenant: string;
      try {
        ({ identity, tenant: authorizedTenant } = await verifyGatekeeperToken(
          token,
          {
            allowedOrigins: parseGatekeeperOrigins(secrets.gatekeeperOrigins),
            audience,
            identityClaim: options.identityClaim,
            tenantClaim: options.tenantClaim
          }
        ));
      } catch (err) {
        const message =
          err instanceof GatekeeperAuthError
            ? err.message
            : "verification failed";
        return unauthorized(message);
      }

      // The DO instance is keyed by the verified `identity.key`; without it the
      // executor cannot route the call — refuse rather than fall back to a
      // shared instance. Guaranteed non-null past this point.
      if (!identity.key) {
        return new Response("bad request: gatekeeper identity missing key", {
          status: 400
        });
      }

      const body = await request.json<string | Record<string, unknown>>();
      // `typeof null === "object"`, so the null check is load-bearing: a body of
      // literal `null` is valid JSON and would otherwise make `rpcBody` null,
      // throwing on the property reads below instead of reaching the SDK
      // handler, which maps it to the same -32602 that `[]` or a string gets.
      const rpcBody = (
        typeof body === "object" && body !== null ? body : {}
      ) as { method?: string; params?: unknown };

      // Which agent this call is for. Read straight off the body rather than
      // through a codec: every request message carries `tenant` in the same
      // place, so decoding as one specific request type would mean knowing the
      // method first, and the tenant is needed to pick the handler that would
      // decide that.
      const requestedTenant =
        (rpcBody.params as { tenant?: unknown } | undefined)?.tenant ?? "";
      if (typeof requestedTenant !== "string" || !requestedTenant) {
        return jsonRpcErrorResponse(
          body,
          toJsonRpcError(
            new RequestMalformedError(
              "params.tenant is required: this endpoint serves several agents " +
                "and none is the default. Use the tenant declared on the " +
                "interface of the agent's card (A2A §8.3.2), or call " +
                "GetExtendedAgentCard with it to fetch that card."
            )
          )
        );
      }

      // The token names the tenant the gatekeeper authorized; the body names the
      // one the call addressed. They must agree.
      //
      // This is the check that makes `tenant` more than a routing hint. Every
      // tenant here shares one endpoint and so one `aud`, which means the
      // audience cannot tell them apart — without this, a token legitimately
      // minted for one agent could be replayed against any of its siblings by
      // editing a field in the request body. An absent claim is a rejection
      // rather than a wildcard for the same reason.
      if (authorizedTenant !== requestedTenant) {
        return unauthorized(
          `gatekeeper token authorizes tenant '${authorizedTenant || "<none>"}', ` +
            `but the request addressed '${requestedTenant}'`
        );
      }

      const agent = tenantAgent(env, requestedTenant);
      if (!agent) {
        return jsonRpcErrorResponse(
          body,
          toJsonRpcError(
            new RequestMalformedError(`unknown tenant '${requestedTenant}'`)
          )
        );
      }

      const card = cardFor(agent.manifest, requestedTenant);
      const context = buildCallContext(request, identity, requestedTenant);

      // v1.0 negotiates the protocol version per request via the `A2A-Version`
      // header, and the SDK leaves enforcement to the transport binding (its
      // Express handlers do it; this Worker is the equivalent seam). An absent
      // header is treated as `0.3` by the SDK, which a v1.0-only card does not
      // advertise — so a legacy caller is rejected here rather than silently
      // mis-served.
      try {
        validateVersion(context.requestedVersion, card, "JSONRPC");
      } catch (err) {
        // Thrown by the server bundle — map it with the server bundle's mapper.
        return jsonRpcErrorResponse(
          body,
          JsonRpcTransportHandler.mapToJSONRPCError(err)
        );
      }

      if (requirePushConfig) {
        const contractError = pushConfigError(rpcBody);
        if (contractError) {
          // Constructed from the errors bundle — map it with that bundle's.
          return jsonRpcErrorResponse(
            body,
            toJsonRpcError(new RequestMalformedError(contractError))
          );
        }
      }

      const oversize = messageTextError(rpcBody);
      if (oversize) {
        return jsonRpcErrorResponse(
          body,
          toJsonRpcError(new RequestMalformedError(oversize))
        );
      }

      const continuation = continuationError(
        rpcBody,
        agent.resumeTurn !== undefined
      );
      if (continuation) {
        return jsonRpcErrorResponse(
          body,
          toJsonRpcError(new RequestMalformedError(continuation))
        );
      }

      const handler = new DefaultRequestHandler(
        card,
        new DurableTaskStore(identity, agent.resolveAgent),
        new A2AExecutor({
          identity,
          jku: `${origin}${jwksPath}`,
          resolveAgent: agent.resolveAgent,
          startTurn: agent.startTurn,
          resumeTurn: agent.resumeTurn
        }),
        undefined,
        undefined,
        undefined,
        // `GetExtendedAgentCard` — how a caller gets a *tenant's* card, since
        // only the stub is discoverable at the well-known path.
        //
        // Returns the in-memory card and lets the SDK encode it: its JSON-RPC
        // transport runs `AgentCard.toJSON()` over whatever comes back, so
        // handing it `signCard`'s already-encoded wire card would encode twice
        // and silently break the signature. See {@link signCardInPlace}.
        //
        // The tenant is read off the context rather than the request params
        // because that is all the SDK passes; it is the value this Worker
        // already authorized and routed on.
        async (ctx) => {
          const requested = ctx.tenant ?? "";
          const target = tenantAgent(env, requested);
          if (!target) {
            throw new RequestMalformedError(`unknown tenant '${requested}'`);
          }
          return signCardInPlace(cardFor(target.manifest, requested), signing);
        }
      );
      const rpc = new JsonRpcTransportHandler(handler);
      const result = await rpc.handle(body, context);

      // Streaming is not advertised; reject async generators outright.
      if (Symbol.asyncIterator in result) {
        return new Response("streaming not supported", { status: 501 });
      }
      if (
        rpcBody.method === CANCEL_TASK_METHOD &&
        (result as { error?: unknown }).error === undefined
      ) {
        await wakeCanceled(agent, identity, rpcBody.params);
      }
      return Response.json(result, { headers: extensionHeaders(context) });
    }

    return new Response("not found", { status: 404 });
  };
}
