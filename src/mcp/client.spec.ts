import { describe, it, expect, afterEach, vi } from "vitest";
import { mcpClient } from "./client.js";

/**
 * The transport's behaviour, asserted on the wire.
 *
 * `fetch` is stubbed globally rather than injected, because the global is what
 * `mcpClient` hands the SDK and the whole point of these is what reaches the
 * server: the credential, the caller's headers, the protocol's own, the session.
 * Stubbing is also the only route — `vitest.config.ts` wires the VCR recorder as
 * Miniflare's `outboundService`, so an un-cassetted request is blocked.
 *
 * These run inside workerd, which is load-bearing beyond convention: the SDK
 * picks its JSON-schema validator by export condition, and the `workerd` one
 * preloads its schemas because the runtime compiles nothing lazily. A handshake
 * that completes here is the evidence that condition was the one selected — the
 * `node` build pulls ajv, which workerd refuses at runtime rather than at build.
 */

const URL_A = "https://mcp.test/readonly";
const URL_B = "https://other.test/readonly";
const PROTOCOL = "2025-06-18";

interface Seen {
  method: string;
  rpc: string | undefined;
  url: string;
  headers: Headers;
  body: unknown;
}

/** How the fake answers one JSON-RPC method. */
type Reply = (rpc: {
  id: unknown;
  params: unknown;
  seen: Seen[];
}) => Response | Promise<Response>;

function json(
  id: unknown,
  result: unknown,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
}

/** A text content block, the shape a tool answers in. */
function content(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/**
 * A server that answers by JSON-RPC method name.
 *
 * `initialize` has a default because every test needs it and almost none is
 * about it; a test that *is* about it overrides the key.
 */
function server(
  replies: Record<string, Reply>,
  sessionId: string | null = "s-1"
) {
  const seen: Seen[] = [];
  const base: Record<string, Reply> = {
    initialize: ({ id }) =>
      json(
        id,
        {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" }
        },
        sessionId ? { "mcp-session-id": sessionId } : {}
      ),
    // 200 rather than 202 deliberately: a 202 is what tells the transport to go
    // and open the event stream, and `policyFetch`'s refusal of a non-POST is
    // asserted on its own below rather than relied on here.
    "notifications/initialized": () => new Response(null, { status: 200 })
  };
  const answer = { ...base, ...replies };
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    const rpc = (body as { method?: string } | undefined)?.method;
    seen.push({
      method,
      rpc,
      url,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body
    });
    if (method !== "POST") return new Response(null, { status: 405 });
    const handler = rpc ? answer[rpc] : undefined;
    if (!handler) return new Response("no such method", { status: 501 });
    return handler({
      id: (body as { id?: unknown } | undefined)?.id,
      params: (body as { params?: unknown } | undefined)?.params,
      seen
    });
  });
  return seen;
}

/** A client with the fields every test wants and nothing it does not. */
function client(over: Partial<Parameters<typeof mcpClient>[0]> = {}) {
  return mcpClient({
    url: URL_A,
    keyedOn: {},
    token: () => "tok",
    clientInfo: { name: "spec", version: "1" },
    ...over
  });
}

const calls = (seen: Seen[]) => seen.map((s) => s.rpc);

/**
 * Yield until `done`, or give up.
 *
 * A bounded microtask spin rather than one `await`: how many turns the SDK takes
 * to put the handshake on the wire is its business, and a spec that pins the
 * number fails on an upgrade that is not a regression.
 */
async function settle(done: () => boolean, turns = 50): Promise<void> {
  for (let i = 0; i < turns && !done(); i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mcpClient", () => {
  it("handshakes once and carries the session on every later call", async () => {
    const seen = server({
      "tools/call": ({ id }) => json(id, content('{"a":1}'))
    });
    const call = client();

    expect(await call("pull_request_read", { method: "get" })).toEqual({
      ok: true,
      data: { a: 1 }
    });
    expect(await call("issue_read", { method: "get" })).toEqual({
      ok: true,
      data: { a: 1 }
    });

    expect(calls(seen).filter((m) => m === "initialize")).toHaveLength(1);
    expect(calls(seen)[0]).toBe("initialize");
    for (const at of seen.filter((s) => s.rpc === "tools/call")) {
      expect(at.headers.get("mcp-session-id")).toBe("s-1");
      expect(at.headers.get("mcp-protocol-version")).toBe(PROTOCOL);
    }
    expect(seen.filter((s) => s.rpc === "tools/call")).toHaveLength(2);
  });

  it("sends the credential and the caller's headers, and never lets a caller take the protocol's", async () => {
    const seen = server({ "tools/call": ({ id }) => json(id, content("{}")) });
    const call = client({
      token: () => "secret-token",
      headers: () => ({ "x-mcp-tools": "a,b", "user-agent": "da-coder" })
    });

    expect(await call("a", {})).toEqual({ ok: true, data: {} });

    for (const at of seen) {
      expect(at.headers.get("authorization")).toBe("Bearer secret-token");
      expect(at.headers.get("x-mcp-tools")).toBe("a,b");
      expect(at.headers.get("user-agent")).toBe("da-coder");
      // The transport's own, which a caller must not be able to narrow.
      expect(at.headers.get("accept")).toContain("application/json");
      expect(at.headers.get("accept")).toContain("text/event-stream");
      expect(at.headers.get("content-type")).toBe("application/json");
    }
  });

  it.each([
    ["authorization", "Bearer other"],
    ["accept", "application/json"],
    ["mcp-session-id", "forged"],
    ["mcp-protocol-version", "1999-01-01"],
    ["content-type", "text/plain"]
  ])("refuses the call when a caller supplies %s", async (name, value) => {
    server({ "tools/call": ({ id }) => json(id, content("{}")) });
    const call = client({ headers: () => ({ [name]: value }) });

    const answered = await call("a", {});

    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.message).toContain(name);
  });

  it("reads the credential before every request, so a rotated one is used", async () => {
    const seen = server({ "tools/call": ({ id }) => json(id, content("{}")) });
    let n = 0;
    const call = client({
      token: () => `tok-${++n}`
    });

    await call("a", {});
    await call("b", {});

    const sent = seen.map((s) => s.headers.get("authorization"));
    expect(new Set(sent).size).toBe(sent.length);
  });

  it("returns a credential failure as the caller wrote it", async () => {
    server({ "tools/call": ({ id }) => json(id, content("{}")) });
    const call = client({
      token: () => {
        throw new Error("GITHUB_TOKEN is not bound — ask the operator");
      }
    });

    const answered = await call("a", {});

    // Equality, not a substring: a caller's `Error` message is the whole
    // sentence, unframed. A host writes that wording for a model to read.
    expect(answered).toEqual({
      ok: false,
      message: "GITHUB_TOKEN is not bound — ask the operator"
    });
  });

  it("frames a thrown value that carries no sentence of its own", async () => {
    server({ "tools/call": ({ id }) => json(id, content("{}")) });
    const call = client({
      token: () => {
        throw "nope";
      }
    });

    const answered = await call("a", {});

    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.message).toBe(
      "the credential for https://mcp.test/readonly could not be read: nope"
    );
  });

  it("hands a concurrent caller the same handshake", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = server({
      initialize: async ({ id }) => {
        await held;
        return json(
          id,
          {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" }
          },
          { "mcp-session-id": "s-1" }
        );
      },
      "tools/call": ({ id }) => json(id, content("{}"))
    });
    const call = client();

    const both = Promise.all([call("a", {}), call("b", {})]);
    // Nothing may be on the wire past the handshake while it is unanswered.
    await settle(() => seen.length > 0);
    expect(calls(seen)).toEqual(["initialize"]);
    release();
    expect(await both).toEqual([
      { ok: true, data: {} },
      { ok: true, data: {} }
    ]);

    expect(calls(seen).filter((m) => m === "initialize")).toHaveLength(1);
    expect(calls(seen).filter((m) => m === "tools/call")).toHaveLength(2);
  });

  it("does not cache a failed handshake", async () => {
    let attempt = 0;
    const seen = server({
      initialize: ({ id }) => {
        attempt += 1;
        return attempt === 1
          ? new Response("nope", { status: 500 })
          : json(
              id,
              {
                protocolVersion: PROTOCOL,
                capabilities: { tools: {} },
                serverInfo: { name: "fake", version: "1" }
              },
              { "mcp-session-id": "s-1" }
            );
      },
      "tools/call": ({ id }) => json(id, content("{}"))
    });
    const call = client();

    expect((await call("a", {})).ok).toBe(false);
    expect(await call("a", {})).toEqual({ ok: true, data: {} });

    expect(calls(seen).filter((m) => m === "initialize")).toHaveLength(2);
  });

  it("reads an answer the server streamed instead of returning as JSON", async () => {
    server({
      "tools/call": ({ id }) =>
        new Response(
          // One logical message, split across `data:` lines. Joined with a
          // newline rather than last-wins, which is what the spec says and what
          // a naive reader gets wrong.
          `event: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(id)},\ndata: "result":${JSON.stringify(
            content('{"split":true}')
          )}}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    });

    expect(await client()("a", {})).toEqual({
      ok: true,
      data: { split: true }
    });
  });

  it("works against a server that keeps no session", async () => {
    const seen = server(
      { "tools/call": ({ id }) => json(id, content("{}")) },
      null
    );

    expect(await client()("a", {})).toEqual({ ok: true, data: {} });
    for (const at of seen) expect(at.headers.get("mcp-session-id")).toBeNull();
  });

  it("renegotiates once for a session the server forgot", async () => {
    let seenSession = 0;
    const seen = server({
      initialize: ({ id }) => {
        seenSession += 1;
        return json(
          id,
          {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" }
          },
          { "mcp-session-id": `s-${seenSession}` }
        );
      },
      "tools/call": ({ id, seen: so_far }) =>
        so_far.filter((s) => s.rpc === "tools/call").length === 1
          ? new Response("no such session", { status: 404 })
          : json(id, content('{"after":"retry"}'))
    });

    expect(await client()("a", {})).toEqual({
      ok: true,
      data: { after: "retry" }
    });

    expect(calls(seen).filter((m) => m === "initialize")).toHaveLength(2);
    expect(calls(seen).filter((m) => m === "tools/call")).toHaveLength(2);
    expect(
      seen
        .filter((s) => s.rpc === "tools/call")
        .at(-1)
        ?.headers.get("mcp-session-id")
    ).toBe("s-2");
  });

  it("does not retry a 404 from a server that never gave a session", async () => {
    const seen = server(
      { "tools/call": () => new Response("nowhere", { status: 404 }) },
      null
    );

    const answered = await client()("a", {});

    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.message).toContain("404");
    expect(calls(seen).filter((m) => m === "tools/call")).toHaveLength(1);
  });

  /**
   * The trust boundary, not just a status code.
   *
   * Every re-authorization branch in the transport is guarded on an
   * `authProvider` being configured, and this client configures none — so a
   * `401` carrying a `WWW-Authenticate` challenge must not send this token's
   * holder off to resolve protected-resource metadata or talk to an
   * authorization server. One failure, one host.
   */
  it("answers a 401 challenge without reaching any other host", async () => {
    const seen = server({
      "tools/call": () =>
        new Response("no", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://elsewhere.test/.well-known/oauth-protected-resource", scope="read"'
          }
        })
    });

    const answered = await client()("a", {});

    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.message).toContain("401");
    expect(new Set(seen.map((s) => new URL(s.url).host))).toEqual(
      new Set(["mcp.test"])
    );
  });

  it("reports a tool the server never registered as a refusal, not as nothing there", async () => {
    server({
      "tools/call": ({ id }) =>
        rpcError(id, -32602, "Tool pull_request_write not found")
    });

    const answered = await client()("pull_request_write", {});

    expect(answered.ok).toBe(false);
    // "refused", not "could not reach": the server answered, and said no. Its
    // `error` arrives as a `ProtocolError`, which is `SdkError`'s sibling rather
    // than its subclass — matching the wrong one of the two sends a reader off
    // to check whether the server is up.
    expect(answered.ok === false && answered.message).toBe(
      "https://mcp.test/readonly refused pull_request_write: Tool pull_request_write not found"
    );
  });

  it("says so when the server answers in an encoding it cannot read", async () => {
    server({
      "tools/call": () =>
        new Response("hello", {
          status: 200,
          headers: { "content-type": "text/plain" }
        })
    });

    const answered = await client()("a", {});

    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.message).toContain(
      "could not read"
    );
  });

  it.each([
    [
      "a tool that reported a failure",
      content("no permission to read this", true),
      /no permission/
    ],
    ["an answer that is not JSON", content("not json at all"), /did not parse/]
  ])("reports %s as a failure", async (_label, result, matches) => {
    server({ "tools/call": ({ id }) => json(id, result) });

    const answered = await client()("a", {});

    expect(answered.ok).toBe(false);
    expect(answered.ok === false && answered.message).toMatch(matches);
  });

  it("answers an empty result with an empty object", async () => {
    server({ "tools/call": ({ id }) => json(id, { content: [] }) });

    expect(await client()("a", {})).toEqual({ ok: true, data: {} });
  });

  it("ignores structuredContent beside a text block", async () => {
    server({
      "tools/call": ({ id }) =>
        json(id, {
          content: [{ type: "text", text: '{"from":"text"}' }],
          structuredContent: { get: { from: "structured" } }
        })
    });

    expect(await client()("a", {})).toEqual({
      ok: true,
      data: { from: "text" }
    });
  });

  it("keeps a separate connection per URL under one key", async () => {
    const seen = server({ "tools/call": ({ id }) => json(id, content("{}")) });
    const keyedOn = {};

    await client({ keyedOn })("a", {});
    await client({ keyedOn, url: URL_B })("a", {});

    expect(calls(seen).filter((m) => m === "initialize")).toHaveLength(2);
    expect(new Set(seen.map((s) => new URL(s.url).host)).size).toBe(2);
  });

  it("reuses one connection across clients built on the same key", async () => {
    const seen = server({ "tools/call": ({ id }) => json(id, content("{}")) });
    const keyedOn = {};

    // What a plugin does: `tools(ctx)` runs again every turn and builds a new
    // client over the same config object.
    await client({ keyedOn })("a", {});
    await client({ keyedOn })("b", {});

    expect(calls(seen).filter((m) => m === "initialize")).toHaveLength(1);
  });

  it("stops when the caller's signal aborts", async () => {
    server({
      "tools/call": () => new Promise<Response>(() => {})
    });
    const controller = new AbortController();
    const answered = client()("a", {}, { signal: controller.signal });
    await settle(() => false, 5);
    controller.abort(new Error("the turn was cancelled"));

    const result = await answered;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      "stopped before https://mcp.test/readonly answered"
    );
    expect(result.ok === false && result.message).toContain(
      "the turn was cancelled"
    );
  });

  it("negotiates the legacy era, with no discovery probe", async () => {
    const seen = server({ "tools/call": ({ id }) => json(id, content("{}")) });

    await client()("a", {});

    expect(calls(seen)).not.toContain("server/discover");
    expect(calls(seen)[0]).toBe("initialize");
  });

  it("never opens the server's event stream", async () => {
    const seen = server({
      // A `202` is what invites the transport to open the GET stream.
      "notifications/initialized": () => new Response(null, { status: 202 }),
      "tools/call": ({ id }) => json(id, content("{}"))
    });

    expect(await client()("a", {})).toEqual({ ok: true, data: {} });

    expect(seen.every((s) => s.method === "POST")).toBe(true);
  });

  it("never asks the server what tools it has", async () => {
    const seen = server({ "tools/call": ({ id }) => json(id, content("{}")) });

    await client()("a", {});
    await client()("b", {});

    expect(calls(seen)).not.toContain("tools/list");
  });
});

/**
 * The SDK picks its JSON-schema validator by **export condition**, and getting
 * the wrong one fails at runtime rather than at build.
 *
 * `@modelcontextprotocol/client/_shims` resolves to a Workers shim under
 * `workerd` and to a Node one otherwise. The Node shim is ajv-backed, and ajv
 * compiles schemas with `new Function`, which workerd refuses — so a build that
 * resolved the wrong condition produces a bundle that typechecks, passes a Node
 * test run, and throws the first time a schema is compiled in production.
 *
 * Asserted here, inside workerd, both ways round: the name of what resolved, and
 * that it can actually compile a schema. The name alone would not catch a future
 * Workers shim that delegated to ajv, and the compile alone would not say which
 * one answered.
 */
describe("the SDK's Workers export condition", () => {
  it("resolves the Workers validator, which can compile a schema here", async () => {
    const shims = (await import("@modelcontextprotocol/client/_shims")) as {
      DefaultJsonSchemaValidator: new () => {
        getValidator: (schema: unknown) => (value: unknown) => unknown;
      };
    };

    expect(shims.DefaultJsonSchemaValidator.name).toBe(
      "CfWorkerJsonSchemaValidator"
    );

    const validate = new shims.DefaultJsonSchemaValidator().getValidator({
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"]
    });
    expect(() => validate({ n: 1 })).not.toThrow();
  });
});
