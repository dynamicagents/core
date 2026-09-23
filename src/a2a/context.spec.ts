import { describe, it, expect } from "vitest";
import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  HTTP_EXTENSION_HEADER,
  TaskState
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  STATE_HEADERS_KEY,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type RequestHeaders
} from "@a2a-js/sdk/server";
import { buildCallContext, extensionHeaders } from "./context.js";
import { buildBaseCard, type AgentManifest } from "./card.js";
import type { GatekeeperIdentity } from "./verify.js";
import { AGENT_ORIGIN, testTask } from "../testing/fixtures.js";

/**
 * The `fetch`-side call-context seam.
 *
 * One fact is pinned here from both ends: the context leaves this Worker with no
 * tenant on it, and the object it leaves on is the object that comes back. The
 * SDK's JSON-RPC transport lifts `params.tenant` onto the context it was handed
 * and refuses a context that already carries one, so constructing the tenant
 * here fails every call; and an activated extension is recorded on whatever
 * object the transport dispatched with, so if that is not this one the response
 * can never echo it.
 *
 * The round trip below is what proves the second half. A unit assertion on
 * `activatedExtensions` would pass against a context the transport had already
 * replaced.
 */

const identity: GatekeeperIdentity = {
  key: "custom:1:test-agent",
  name: "Test Agent",
  kind: "custom",
  workspaceId: 1
};

/** The tenant these specs address. Named on `params`, never on the context. */
const TENANT = "context-spec-agent";

const post = (headers: Record<string, string> = {}) =>
  new Request(`${AGENT_ORIGIN}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}"
  });

describe("buildCallContext", () => {
  it("leaves the tenant unset, for the transport to lift off params", () => {
    // The SDK's own JSON-RPC binding builds its context this way. A tenant set
    // here throws "Tenant is already set." inside the transport, which reaches
    // the caller as an internal error on every single call.
    expect(buildCallContext(post(), identity).tenant).toBeUndefined();
  });

  it("carries the verified caller as the SDK's authenticated user", () => {
    // `userName` is the canonical instance key the agent Durable Object is
    // keyed by, so the SDK's owner-scoped bookkeeping and this Worker's routing
    // isolate on the same value.
    const { user } = buildCallContext(post(), identity);

    expect(user?.isAuthenticated).toBe(true);
    expect(user?.userName).toBe(identity.key);
  });

  it("stashes the request headers where the Express binding stashes them", () => {
    // An executor reaches the raw headers through the state bag under both
    // bindings, or it reaches them under one and not the other.
    const context = buildCallContext(
      post({ "x-correlation-id": "abc123" }),
      identity
    );
    const headers = context.state.get(STATE_HEADERS_KEY) as RequestHeaders;

    expect(headers["x-correlation-id"]).toBe("abc123");
    expect(headers["content-type"]).toBe("application/json");
  });
});

/**
 * The URI a spec agent declares and activates. Opaque to everything here — what
 * matters is that the same string makes it out to the response header.
 */
const SPEC_EXTENSION = "https://dynamicagents.test/ext/spec/v1";

const manifest: AgentManifest = {
  name: "context-spec-agent",
  description: "an agent that activates the extension it was asked for",
  version: "0.1.0",
  capabilities: {
    streaming: false,
    pushNotifications: true,
    // Declared, because the request handler filters the requested set down to
    // what the card exposes before the executor ever sees it.
    extensions: [
      {
        uri: SPEC_EXTENSION,
        description: "echoed back when a caller asks for it",
        required: false,
        params: undefined
      }
    ]
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

/**
 * Activates {@link SPEC_EXTENSION} when the caller asked for it, then answers
 * with a submitted Task. Activation is the agent's to do — the SDK filters the
 * requested set and never activates anything itself — so an executor is what a
 * spec of the echo needs.
 */
const activating: AgentExecutor = {
  execute: async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const { context } = requestContext;
    if (context.requestedExtensions?.includes(SPEC_EXTENSION)) {
      context.addActivatedExtension(SPEC_EXTENSION);
    }
    eventBus.publish(
      AgentEvent.task(
        testTask(
          requestContext.taskId,
          requestContext.contextId,
          TaskState.TASK_STATE_SUBMITTED
        )
      )
    );
    eventBus.finished();
  },
  cancelTask: async (
    _taskId: string,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    eventBus.finished();
  }
};

/**
 * Send one `SendMessage` through the SDK exactly as the Worker does — a context
 * from {@link buildCallContext}, a `JsonRpcTransportHandler` over a
 * `DefaultRequestHandler` — and return both the response and the context the
 * Worker would build its response headers from.
 */
const send = async (requested?: string) => {
  const rpc = new JsonRpcTransportHandler(
    new DefaultRequestHandler(
      buildBaseCard(manifest, { origin: AGENT_ORIGIN, tenant: TENANT }),
      new InMemoryTaskStore(),
      activating
    )
  );
  const context = buildCallContext(
    post({
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
      ...(requested ? { [HTTP_EXTENSION_HEADER]: requested } : {})
    }),
    identity
  );
  const result = await rpc.handle(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "SendMessage",
      params: {
        tenant: TENANT,
        message: {
          messageId: "m1",
          role: "ROLE_USER",
          parts: [{ text: "hello" }]
        }
      }
    },
    context
  );
  return { context, result: result as { error?: unknown; result?: unknown } };
};

describe("an activated extension", () => {
  it("is echoed on the response the Worker sends back", async () => {
    const { context, result } = await send(SPEC_EXTENSION);

    // The tenant reached the handler even though the context was built without
    // one — lifted off `params.tenant` onto *this* object.
    expect(result.error).toBeUndefined();
    expect(context.tenant).toBe(TENANT);

    // …and so did the activation, which is only true while the transport
    // dispatches with the context it was handed rather than a copy of it. A
    // copy leaves this empty and the caller never learns the extension ran.
    expect(context.activatedExtensions).toContain(SPEC_EXTENSION);
    expect(extensionHeaders(context)).toEqual({
      [HTTP_EXTENSION_HEADER]: SPEC_EXTENSION
    });
  });

  it("is absent when the caller asked for nothing", async () => {
    // The other half: the header is echoed because something activated, not
    // because a request went through.
    const { context, result } = await send();

    expect(result.error).toBeUndefined();
    expect(extensionHeaders(context)).toEqual({});
  });

  it("is absent when the card does not expose what was asked for", async () => {
    // The request handler filters the requested set to the card's own, so an
    // extension this agent never declared cannot be activated by asking.
    const { context } = await send("https://dynamicagents.test/ext/other/v1");

    expect(extensionHeaders(context)).toEqual({});
  });
});
