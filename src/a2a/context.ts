import {
  A2A_VERSION_HEADER,
  Extensions,
  HTTP_EXTENSION_HEADER
} from "@a2a-js/sdk";
import {
  defaultServerCallContextBuilder,
  type RequestHeaders,
  type ServerCallContext,
  type User
} from "@a2a-js/sdk/server";
import type { VerifiedCaller } from "./caller-scope.js";

/**
 * The per-call {@link ServerCallContext} bridge for a Workers `fetch` handler.
 *
 * v1.0 made the call context mandatory on every request-handler and task-store
 * method, and the SDK only ships Express and gRPC bindings that build one; this
 * is the equivalent seam for `fetch`.
 */

/**
 * The verified calling gatekeeper-agent, as the SDK's {@link User}. `userName` is
 * the caller's **scope** (e.g. `https://gatekeeper.example#custom:7:analytics`),
 * which is the name the agent Durable Object is keyed by, so the SDK's
 * owner-scoped bookkeeping lines up with the isolation this Worker enforces by
 * routing. The claimed key alone would not: two listed gatekeepers may name the
 * same one, and {@link file://./caller-scope.ts VerifiedCaller} is what keeps
 * those apart.
 */
class GatekeeperUser implements User {
  constructor(private readonly caller: VerifiedCaller) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.caller.scope;
  }
}

/**
 * Build the call context for one verified JSON-RPC request. The default builder
 * stashes the raw headers in the context's state bag, so an executor can reach
 * them the same way it would under the Express binding.
 *
 * The context carries **no tenant**, exactly as the SDK's own JSON-RPC binding
 * builds it. The transport lifts `params.tenant` onto the context it was handed
 * and refuses to lift it onto one that already has a tenant, so constructing one
 * here is not a shortcut but an error — every call would come back as an
 * internal error. Lifting it there is also what keeps *one* context object
 * across dispatch, which is what {@link extensionHeaders} depends on: the
 * activations it reads are recorded on the object the transport passed down.
 *
 * Nothing is lost by it. The Worker has already parsed, authorized and routed on
 * `params.tenant` before this is called, and the value the transport lifts is
 * that same string — see {@link file://../worker/index.ts createA2AWorker}.
 */
export function buildCallContext(
  request: Request,
  caller: VerifiedCaller
): ServerCallContext {
  const headers: RequestHeaders = {};
  for (const [name, value] of request.headers) headers[name] = value;

  return defaultServerCallContextBuilder({
    extensions: Extensions.parseServiceParameter(
      request.headers.get(HTTP_EXTENSION_HEADER) ?? undefined
    ),
    user: new GatekeeperUser(caller),
    headers,
    requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined
  });
}

/** Echo back the extensions the handler actually activated (spec §14.2.2). */
export function extensionHeaders(context: ServerCallContext): HeadersInit {
  const activated = context.activatedExtensions;
  if (!activated?.length) return {};
  return { [HTTP_EXTENSION_HEADER]: Extensions.toServiceParameter(activated) };
}
