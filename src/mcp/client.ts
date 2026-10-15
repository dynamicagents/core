/**
 * Calling an MCP server from a Worker, over the official SDK.
 *
 * The protocol is `@modelcontextprotocol/client`'s — the handshake, the session,
 * Streamable HTTP's choice of JSON or SSE, the JSON-RPC framing. What is here is
 * only what a caller of ours needs on top of it, and every piece of it is policy
 * or shape rather than protocol:
 *
 * - **A failure is a value.** The SDK throws; a tool hands the model a sentence.
 *   Each caller has its own to add, so this returns {@link McpAnswer} rather than
 *   rejecting.
 * - **One connection per caller instance.** A plugin's `tools(ctx)` is rebuilt
 *   every turn, so the connection is kept against an object the caller names.
 * - **The text block is the answer.** See {@link toolAnswer}.
 * - **No `tools/list`.** A caller names the tool; the model never sees one.
 *
 * Here rather than in a plugin for the reason
 * {@link file://../tool-output.ts truncateOutput} is: two plugins can share code
 * only through this package.
 *
 * ## The credential, and why no `authProvider`
 *
 * The SDK has an `authProvider` seam and it is documented for exactly a bearer
 * token. This sets `Authorization` from the `fetch` seam instead, deliberately:
 *
 * 1. **Every re-authorization branch in the transport is guarded on an
 *    `authProvider` being configured.** With none, a `401` is an HTTP failure and
 *    nothing reads `WWW-Authenticate`, resolves protected-resource metadata or
 *    reaches an authorization server. For a caller whose whole trust boundary is
 *    "this token, this host", being unable to take another route is worth more
 *    than using the seam built for it.
 * 2. **A credential that cannot be read is the caller's sentence, verbatim.**
 *    Read here, inside this module's own `try`, it comes back as written. Read
 *    inside the SDK it arrives wrapped, and the wrapping is not ours to predict.
 *
 * ## Headers, and which of them are not a caller's to set
 *
 * `requestInit.headers` does reach the wire — the transport spreads it *over* its
 * own in `_commonHeaders()` — which is the hazard rather than the feature: a
 * caller could replace `mcp-session-id` or `authorization` and break the
 * transport from outside it. So nothing here passes it, and
 * {@link McpClientConfig.headers} is applied per request instead, after the
 * protocol has spoken, where its own names survive. {@link RESERVED_HEADERS} is
 * refused on top of that, so a caller that believes it is setting one is told
 * rather than quietly ignored.
 */
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { withAbort } from "../abort.js";
import { truncateOutput } from "../tool-output.js";

/** What a call answers with. A failure is a value, not a rejection. */
export type McpAnswer =
  { ok: true; data: unknown } | { ok: false; message: string };

/**
 * Header names the protocol owns, which {@link McpClientConfig.headers} may not
 * set.
 *
 * **A loud refusal, not the thing that keeps these off the wire.** Through this
 * module's seam none of them could land in the first place: `policyFetch`
 * applies a caller's headers only where the transport has not spoken, and by
 * then it has spoken for every name here — `authorization` is then set from
 * {@link McpClientConfig.token}, which is the way to send one. The list is here
 * so a caller that believes it is setting one of these finds out, and so the
 * rule still holds if anything ever passes `requestInit.headers`, where the
 * replacement hazard in this module's header is real.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id"
]);

/**
 * Ceiling on one call, handshake included, when a caller names none.
 *
 * What is not negotiable is that there is a ceiling: it is what makes a server
 * that stops answering cost a tool call rather than the task. A cold call pays
 * the handshake as well, and the one retry below shares this deadline rather
 * than being given a fresh one.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How much of a server's own text may reach an {@link McpAnswer} message.
 *
 * Not a budget — a budget is an agent's, and core sets none. Structural: a
 * message here is one sentence for a model to read, while the SDK puts a non-OK
 * response's *entire body* on the error it throws, and a tool's unparseable
 * answer is as long as the tool made it. Unbounded, a proxy's HTML error page
 * spends the turn's context on itself. Middle-out, so the front of the text and
 * anything conclusive at its end both survive.
 */
const MESSAGE_LIMIT = 2_000;

/** A server's own words, bounded — see {@link MESSAGE_LIMIT}. */
const theirs = (text: string): string => truncateOutput(text, MESSAGE_LIMIT);

export interface McpClientConfig {
  /** The server's Streamable HTTP endpoint. */
  url: string;
  /**
   * The object a connection is kept against.
   *
   * A caller that rebuilds its client every turn — which `AgentPlugin.tools(ctx)`
   * does — passes the object that identifies its instance, so the handshake is
   * paid once per instance rather than once per turn. A `WeakMap`, so a discarded
   * instance takes its connections with it.
   *
   * **It has to identify the credential and the header policy too, not just the
   * instance.** A connection is shared by everything that keys to it at one
   * `url`, and the `token` and `headers` on the wire are those of whichever
   * client opened it — the transport holds one `fetch`, built once. Two clients
   * on one `keyedOn` and one `url` that answer `token` differently would
   * therefore both call as the first; give them separate objects. The consumer
   * in this train passes the config that carries the credential, which makes
   * that true by construction.
   */
  keyedOn: object;
  /**
   * The bearer, read before every request so a rotated credential is never
   * cached. A throw is the caller's own sentence and comes back as
   * `{ ok: false, message }` unchanged.
   *
   * Read by the client that opened the connection — see
   * {@link McpClientConfig.keyedOn} for what that means for a key two clients
   * share.
   */
  token: () => string | Promise<string>;
  /**
   * Headers the caller's own policy adds — an allowlist header, a user agent.
   * Read per request, by the same client the token is, and applied only where
   * the protocol has not already spoken.
   *
   * `accept`, `authorization`, `content-type`, `mcp-protocol-version` and
   * `mcp-session-id` are the protocol's own: naming one fails the call rather
   * than being dropped quietly. {@link RESERVED_HEADERS} says why.
   */
  headers?: () => Record<string, string>;
  /** How this client names itself on `initialize`. */
  clientInfo?: { name: string; version: string };
  /**
   * Ceiling on one call, handshake included; thirty seconds if unset. What is
   * not negotiable is that there is one — {@link DEFAULT_TIMEOUT_MS} says why.
   */
  timeoutMs?: number;
}

/** A connection, and the transport underneath it that knows the session id. */
interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

/**
 * Connections, per caller instance and then per URL.
 *
 * Two URLs under one `keyedOn` keep separate connections: the key identifies the
 * caller, not the server.
 */
const pools = new WeakMap<object, Map<string, Promise<Connection>>>();

/**
 * A failure that belongs to the caller's own thunk, carried out through the SDK
 * so the message reaches {@link McpAnswer} as written.
 */
class McpCallerError extends Error {}

/**
 * A caller's thunk failing, as the sentence the model will read.
 *
 * An `Error` the caller threw owns its own wording: a host explaining that a
 * secret is unbound has written that for a model, and framing it again would
 * bury it. Anything else — a thrown string, a rejected value — gets this
 * module's framing, because there is no sentence in it to keep.
 */
function fromCaller(err: unknown, framing: string): McpCallerError {
  return new McpCallerError(
    err instanceof Error && err.message
      ? err.message
      : `${framing}: ${String(err)}`
  );
}

/** The caller's sentence, if one of its thunks is why this failed. */
function callerFailure(err: unknown): string | undefined {
  // Walked rather than matched directly: the SDK is entitled to wrap what a
  // `fetch` implementation throws, and `cause` is where it would put it.
  for (let at: unknown = err, depth = 0; at != null && depth < 8; depth += 1) {
    if (at instanceof McpCallerError) return at.message;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

/** An `SdkHttpError` anywhere in the chain, for the status it carries. */
function httpFailure(err: unknown): SdkHttpError | undefined {
  for (let at: unknown = err, depth = 0; at != null && depth < 8; depth += 1) {
    if (at instanceof SdkHttpError) return at;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether the call ran out of time or was cancelled.
 *
 * Both arrive, and by more than one route: the SDK's own deadline rejects with
 * `RequestTimeout`, while an abort that reaches `fetch` first comes back as the
 * signal's bare reason, unwrapped. So the signal is asked as well as the error —
 * which is also the only honest order, since the signal is the fact and the
 * error's shape is an implementation detail of whoever noticed first.
 */
function stopped(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout)
  );
}

/**
 * What a tool returned, as text.
 *
 * MCP answers a tool with content blocks rather than a value, and an *error from
 * the tool* is a normal result carrying `isError` — distinct from a JSON-RPC
 * error, which is the call itself failing and arrives as a rejection. Both have
 * to be reported: reading `content` straight through turns "no permission to read
 * this" into a result the model treats as the answer.
 *
 * **The text block is the contract, and `structuredContent` deliberately is not
 * read.** They are not two encodings of one value. A server whose tool marshals
 * its own result into the text block while the typed output beside it wraps that
 * in the method's name would hand each caller a differently-shaped object
 * depending on whether typed schemas were switched on — which shows up as an
 * empty render rather than an error.
 *
 * **The text block has to parse as JSON.** A tool answering prose comes back as
 * a failure carrying that prose, not as data — so this suits a server whose
 * tools return records, which is what the callers here point at. Content with
 * no text block at all answers `{}`, and a caller that can tell "nothing there"
 * from "nothing readable" should check for it.
 */
function toolAnswer(result: {
  content?: readonly { type: string; text?: string }[];
  isError?: boolean;
}): McpAnswer {
  const text = (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  if (result.isError) {
    return {
      ok: false,
      message: theirs(text) || "the tool reported a failure"
    };
  }
  if (!text) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      message: `the tool's answer did not parse: ${theirs(text)}`
    };
  }
}

/** The session the server forgot, which is the one failure worth retrying. */
const FORGOTTEN = Symbol("mcp.session.forgotten");

/**
 * One MCP client, for one caller instance.
 *
 * Returns the call. A tool body reads the same whichever server it is pointed at,
 * which is the point of this living here rather than in the plugin that needs it.
 */
export function mcpClient(config: McpClientConfig) {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientInfo = config.clientInfo ?? {
    name: "dynamicagents-core",
    version: "1"
  };

  /** The caller's policy headers, checked. */
  const policyHeaders = (): Record<string, string> => {
    let supplied: Record<string, string>;
    try {
      supplied = config.headers?.() ?? {};
    } catch (err) {
      throw fromCaller(err, `the headers for ${config.url} could not be read`);
    }
    for (const name of Object.keys(supplied)) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        throw new McpCallerError(
          `"${name}" is the MCP transport's own header and cannot be set by a ` +
            `caller — a credential goes through this client's token instead`
        );
      }
    }
    return supplied;
  };

  /**
   * Every request the transport makes, with the credential and the caller's
   * policy on it.
   *
   * The transport has already built its own headers by the time this runs, so the
   * caller's are applied where it has not spoken and `authorization` is set here
   * because nothing else sets it.
   */
  const policyFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    // A call is a POST and its response. The transport may also try to open the
    // server's event stream with a `GET` — after a `202` to
    // `notifications/initialized` — and nothing here has any use for a
    // server-initiated message: no sampling, no elicitation, no notification
    // acted on. Opening it would leave a Worker holding a long-lived connection
    // for the life of an object that will never read it, so it is refused here
    // rather than merely discouraged. `405` is what the spec has a client
    // expect from a server that does not offer the stream, and the transport
    // reads it as exactly that: it stops trying to open one and raises nothing.
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed"
      });
    }
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    for (const [name, value] of Object.entries(policyHeaders())) {
      if (!headers.has(name)) headers.set(name, value);
    }
    let token: string;
    try {
      token = await config.token();
    } catch (err) {
      throw fromCaller(
        err,
        `the credential for ${config.url} could not be read`
      );
    }
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  const negotiate = async (): Promise<Connection> => {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: policyFetch,
      // **Load-bearing for the POST, not only for the stream the GET would
      // open.** The transport serves a POST's own SSE response through the same
      // reader, and a stream that ends after an event carrying an `id` but
      // before the result schedules a reconnection from there. Refusing to
      // schedule means a Worker can never be left holding a timer past the
      // request that created it; what it costs is that such a call waits out
      // the deadline below instead of being resumed.
      reconnectionScheduler: () => undefined
    });
    const client = new Client(clientInfo, {
      // Pinned rather than defaulted. `legacy` is the plain handshake this is
      // written against; `auto` would probe the server with `server/discover`
      // first, which is traffic a caller's allowlist never asked for. The
      // default is `legacy` today, and that is not a reason to leave it unsaid.
      versionNegotiation: { mode: "legacy" }
    });
    // Bounded, but deliberately not given the calling turn's signal: the
    // handshake is shared, so one caller cancelling must not take it out from
    // under another. The caller stops waiting instead — see `withAbort` below.
    await client.connect(transport, { timeout: timeoutMs });
    return { client, transport };
  };

  const pool = (): Map<string, Promise<Connection>> => {
    const held = pools.get(config.keyedOn);
    if (held) return held;
    const fresh = new Map<string, Promise<Connection>>();
    pools.set(config.keyedOn, fresh);
    return fresh;
  };

  /**
   * The connection, negotiating one if there is none.
   *
   * **The handshake in flight is what is held, not the connection it produces.**
   * A model step may call two tools at once, and both would otherwise open their
   * own — or worse, the second would send a `tools/call` while the first's
   * handshake was still on the wire, which a server is entitled to reject.
   */
  const open = (): Promise<Connection> => {
    const held = pool().get(config.url);
    if (held) return held;
    const opening = negotiate();
    pool().set(config.url, opening);
    // A handshake that failed must not be the answer the next call gets.
    // Guarded on identity so a rejection arriving after somebody else has stored
    // a fresh promise does not take theirs out.
    opening.catch(() => {
      if (pool().get(config.url) === opening) pool().delete(config.url);
    });
    return opening;
  };

  const forget = (opening: Promise<Connection>): void => {
    if (pool().get(config.url) === opening) pool().delete(config.url);
  };

  const failure = (name: string, err: unknown, signal: AbortSignal): string => {
    const http = httpFailure(err);
    if (http) {
      return `${config.url} answered ${http.status} for ${name}: ${theirs(http.message)}`;
    }
    if (stopped(err, signal)) {
      // Said as "stopped before it answered" rather than as a failure of the
      // server, because that is what a caller needs to know: nothing is known
      // to have happened there, and the clock or the turn is why.
      const reason = signal.reason ?? err;
      return (
        `the call to ${name} stopped before ${config.url} answered: ` +
        `${reason instanceof Error ? reason.message : String(reason)}`
      );
    }
    // A JSON-RPC error response, which is what a tool the server never
    // registered looks like — an enable-list refusal above all. Said as a
    // refusal because the alternatives are both worse: "could not reach" reads
    // as the server being down, and an empty render reads to a model as "there
    // is nothing there", which on a busy review is the dangerous one.
    //
    // `ProtocolError` rather than `SdkError`: the two are siblings, not parent
    // and child, and it is this one the server's own `error` arrives as.
    if (err instanceof ProtocolError) {
      return `${config.url} refused ${name}: ${theirs(err.message)}`;
    }
    // The client's own protocol complaint — an encoding it could not read, a
    // transport that was not connected. Not the server refusing, and not the
    // network failing, so it says neither.
    if (err instanceof SdkError) {
      return `${config.url} answered ${name} in a way this client could not read: ${err.message}`;
    }
    return `could not reach ${config.url} for ${name}: ${String(err)}`;
  };

  const once = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<McpAnswer | typeof FORGOTTEN> => {
    // Asked before `open`, which would otherwise put a handshake on the wire
    // for a turn that is already over. Nobody is waiting for the answer, and
    // pooling the connection for a later caller does not pay for traffic this
    // caller's allowlist never asked for.
    if (signal.aborted) {
      return { ok: false, message: failure(name, signal.reason, signal) };
    }
    const opening = open();
    let connection: Connection;
    try {
      connection = await withAbort(signal, opening);
    } catch (err) {
      const caller = callerFailure(err);
      return { ok: false, message: caller ?? failure(name, err, signal) };
    }
    try {
      const result = await connection.client.callTool(
        { name, arguments: args },
        { timeout: timeoutMs, signal }
      );
      return toolAnswer(result);
    } catch (err) {
      const caller = callerFailure(err);
      if (caller) return { ok: false, message: caller };
      // Only with a session to have forgotten. A `404` without one is the wrong
      // endpoint, and renegotiating against it would just fail twice.
      //
      // **De-pooled but not closed, and that is the whole of it.** This
      // connection is shared — `open` exists so a model step's parallel tool
      // calls join one handshake — and `close()` aborts the transport's
      // controller, rejecting every *sibling* call in flight with
      // `ConnectionClosed`. That reaches the caller as "answered in a way this
      // client could not read", which is the one framing `failure` below says
      // a session invalidation must not get. Left unclosed it holds nothing:
      // `reconnectionScheduler` refuses to schedule, the GET stream is refused,
      // and once it is out of the pool nothing can reach it. A sibling that
      // then takes the same `404` renegotiates on its own retry.
      if (httpFailure(err)?.status === 404 && connection.transport.sessionId) {
        forget(opening);
        return FORGOTTEN;
      }
      return { ok: false, message: failure(name, err, signal) };
    }
  };

  /**
   * One tool call.
   *
   * `signal` is the turn's, where the caller has one: a cancelled turn stops
   * waiting on the server. It is combined with this call's own deadline, and the
   * retry below shares that deadline rather than starting a new one.
   */
  return async function mcp(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<McpAnswer> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal
      ? AbortSignal.any([deadline, options.signal])
      : deadline;
    try {
      const answered = await once(name, args, signal);
      if (answered !== FORGOTTEN) return answered;
      // The one retry, and only for a session the server forgot: `once` has
      // already dropped the connection, so this renegotiates rather than
      // repeating. These are the server's own idempotency rules, not ours — a
      // caller that must not repeat a write does not reach for this client.
      const again = await once(name, args, signal);
      return again === FORGOTTEN
        ? {
            ok: false,
            message: `${config.url} would not keep a session for ${name}`
          }
        : again;
    } catch (err) {
      // `once` answers with a value; reaching here is this module having a bug,
      // and a sentence is still better than a rejection a tool body cannot use.
      return { ok: false, message: failure(name, err, signal) };
    }
  };
}

/** What {@link mcpClient} returns, for a context that carries one. */
export type McpCall = ReturnType<typeof mcpClient>;
