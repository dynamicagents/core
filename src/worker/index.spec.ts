import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  AgentCard,
  TaskState,
  verifyAgentCardSignature,
  type Task
} from "@a2a-js/sdk";
import {
  HITL_RESPONSE_TYPE,
  MAX_MESSAGE_TEXT_BYTES
} from "@dynamicagents/g2a-protocol";
import { createA2AWorker, defineAgent, JWKS_PATH } from "./index.js";
import type { AgentManifest } from "../a2a/card.js";
import type { A2ASecretsEnv } from "../env.js";
import type { AgentResolver, TaskAgent } from "../a2a/agent-stub.js";
import type { AcceptedTurn } from "../a2a/executor.js";
import type { TurnWake } from "../a2a/hitl.js";
import type { PlainTask } from "../a2a/task.js";
import { makeGatekeeperToken, TEST_TENANT } from "../testing/auth.js";
import {
  AGENT_ORIGIN,
  GATEKEEPER_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  gatekeeperPublicJwks,
  testStatus,
  testTask
} from "../testing/fixtures.js";

/**
 * The Worker edge, route by route.
 *
 * Everything asserted here happens *before* a Durable Object is addressed, which
 * is the interesting half: an unauthenticated or malformed call must be refused
 * at the edge rather than becoming a `failed` task a client reads as an accepted
 * turn that never calls back.
 */

const manifest = (name: string): AgentManifest => ({
  name,
  description: "an agent behind the A2A edge",
  version: "0.1.0",
  capabilities: {
    streaming: false,
    pushNotifications: true,
    extensions: []
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
});

/** The stub card for the origin — describes the deployment, not an agent. */
const hostManifest = manifest("worker-spec-host");

const env: A2ASecretsEnv = {
  A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  GATEKEEPER_ORIGINS: JSON.stringify([GATEKEEPER_ORIGIN])
};

/** Never reached by these specs — every one is refused before dispatch. */
const resolveAgent: AgentResolver = () => {
  throw new Error("resolveAgent must not be reached in these specs");
};

const tenantAgent = (name: string) => ({
  manifest: manifest(name),
  resolveAgent,
  startTurn: async () => {}
});

/**
 * An `Env` shaped like a real one, for the `defineAgent` specs.
 *
 * The namespace is over a class carrying the task lifecycle, because that is the
 * contract: `createA2AWorker` builds a `DurableTaskStore` over whatever
 * `resolveAgent` returns, so a Durable Object without these four methods is not
 * mountable — and the compiler is where that is caught. Nothing here is called;
 * these specs are about what is refused at construction.
 */
declare class SpecAgent implements TaskAgent {
  __DURABLE_OBJECT_BRAND: never;
  beginTask(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): Promise<PlainTask>;
  getTask(taskId: string): Promise<PlainTask | null>;
  saveTask(task: Task): Promise<boolean>;
  cancelTask(taskId: string): Promise<PlainTask | null>;
}

interface TestEnv extends A2ASecretsEnv {
  AGENT_DO: DurableObjectNamespace<SpecAgent>;
  TURN_WORKFLOW: Workflow<AcceptedTurn>;
}

const worker = createA2AWorker({
  manifest: hostManifest,
  tenants: {
    [TEST_TENANT]: tenantAgent("worker-spec-agent"),
    sibling: tenantAgent("worker-spec-sibling")
  }
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${AGENT_ORIGIN}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

/**
 * A `SendMessage` addressed at a tenant. Every request carries one: there is no
 * default agent, so an omitted tenant is a rejection rather than a fallback.
 */
const sendMessage = (params: object, tenant: string = TEST_TENANT) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "SendMessage",
  params: { tenant, ...params }
});

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${GATEKEEPER_ORIGIN}/.well-known/jwks.json`) {
      return new Response(gatekeeperPublicJwks(), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterAll(() => vi.unstubAllGlobals());

describe("discovery routes", () => {
  it("serves the card-signing public JWKS, with no private component", async () => {
    const res = await worker(new Request(`${AGENT_ORIGIN}${JWKS_PATH}`), env);
    const body = await res.json<{ keys: Record<string, unknown>[] }>();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(body.keys[0].kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("serves the stub card at the well-known path, not any tenant's", async () => {
    // RFC 8615 reserves this URI per *authority*, so exactly one card is
    // discoverable here however many agents the origin serves. Serving a
    // tenant's card would make that tenant the one every gatekeeper pinned.
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<{
      name: string;
      capabilities: { extendedAgentCard: boolean };
      supportedInterfaces: { tenant: string }[];
    }>();

    expect(res.status).toBe(200);
    expect(card.name).toBe("worker-spec-host");
    // It names no tenant — a caller reaches a real agent by asking for one.
    expect(card.supportedInterfaces[0].tenant ?? "").toBe("");
    // …and advertises the route for doing so. The SDK refuses
    // `GetExtendedAgentCard` outright when this is unset (spec §3.3.4).
    expect(card.capabilities.extendedAgentCard).toBe(true);
  });

  it("signs the stub card with a jku pointing back at its own JWKS route", async () => {
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<Record<string, unknown>>();

    expect(res.status).toBe(200);
    expect(Array.isArray(card.signatures)).toBe(true);

    const [sig] = card.signatures as { protected: string }[];
    const header = JSON.parse(
      atob(sig.protected.replace(/-/g, "+").replace(/_/g, "/"))
    );
    // A gatekeeper resolves the card's key from this, so it has to be this agent's.
    expect(header.jku).toBe(`${AGENT_ORIGIN}${JWKS_PATH}`);
    expect(header.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(header.alg).toBe("EdDSA");
  });

  it("advertises the interface at the origin the request arrived on", async () => {
    // The card is built per request, so one deployment serves a correct card on
    // whatever hostname is in front of it.
    const res = await worker(
      new Request(`https://elsewhere.test/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<{
      supportedInterfaces: { url: string; protocolVersion: string }[];
    }>();

    expect(card.supportedInterfaces[0].url).toBe("https://elsewhere.test/a2a");
    expect(card.supportedInterfaces[0].protocolVersion).toBe(
      A2A_PROTOCOL_VERSION
    );
  });

  it("404s an unknown route", async () => {
    const res = await worker(new Request(`${AGENT_ORIGIN}/nope`), env);
    expect(res.status).toBe(404);
  });

  it("404s a POST to a path that is not this agent's rpcPath", async () => {
    // The JSON-RPC branch matches the advertised path, not merely the method.
    // Accepting every POST made `rpcPath` decorative — a call to any URL on the
    // origin was served as JSON-RPC, so a mounted agent's isolation rested
    // entirely on an outer router matching first, and a typo'd endpoint quietly
    // worked instead of failing.
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/not-the-rpc-path`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sendMessage({}))
      }),
      env
    );
    expect(res.status).toBe(404);
  });
});

describe("gatekeeper authentication", () => {
  it("refuses a call with no bearer token", async () => {
    const res = await worker(post(sendMessage({})), env);

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("refuses a token from an origin outside GATEKEEPER_ORIGINS", async () => {
    const token = await makeGatekeeperToken();
    const res = await worker(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      { ...env, GATEKEEPER_ORIGINS: JSON.stringify(["https://other.test"]) }
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/not in the allowed gatekeeper origins/);
  });

  it("refuses a verified token that carries no identity key", async () => {
    // Without it the executor cannot route to a DO instance. Refusing beats
    // falling back to a shared instance, which would cross callers' tasks.
    const token = await makeGatekeeperToken({
      identity: { name: "anonymous" }
    });
    const res = await worker(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });
});

/**
 * What `createA2AWorker` refuses to build at all.
 *
 * A registry that cannot serve anybody is a deployment mistake, and the useful
 * time to say so is at module scope — where it takes the Worker down on the
 * first request and names the cause — rather than per request, where it reads
 * to a caller as an ordinary rejection.
 */
describe("startup validation", () => {
  it("refuses an empty registry", () => {
    expect(() =>
      createA2AWorker({ manifest: hostManifest, tenants: {} })
    ).toThrow(/at least one agent/);
  });

  it("refuses a registry with neither `agents` nor `tenants`", () => {
    expect(() => createA2AWorker({ manifest: hostManifest })).toThrow(
      /at least one agent/
    );
  });

  it("refuses a tenant declared by both `agents` and `tenants`", () => {
    // Letting one win silently is how a deployment ends up serving an agent
    // nobody meant to mount — and which one wins would be an implementation
    // detail of a merge order, invisible at the call site.
    expect(() =>
      createA2AWorker({
        manifest: hostManifest,
        tenants: { twice: tenantAgent("twice") },
        agents: [
          defineAgent({
            tenant: "twice",
            manifest: hostManifest,
            agent: (env: TestEnv) => env.AGENT_DO,
            workflow: (env: TestEnv) => env.TURN_WORKFLOW
          })
        ]
      })
    ).toThrow(/declare each agent once/);
  });

  it("refuses a tenant registered under the empty id", () => {
    // `{ "": agent }` passes a bare length check while being unroutable: a
    // request must name its tenant, and `""` is how "named none" is spelled, so
    // every call to it is refused as a missing tenant before the registry is
    // ever consulted. Without this the "at least one tenant" guarantee is about
    // entries rather than reachable agents.
    expect(() =>
      createA2AWorker({
        manifest: hostManifest,
        tenants: { "": tenantAgent("nameless") }
      })
    ).toThrow(/tenant id to be non-empty/);
  });
});

/**
 * The two options that describe the *deployment* rather than an agent.
 *
 * Both are one-shot: a Worker that reads the wrong binding or demands the wrong
 * audience fails on its first real call, and both failures reach the operator as
 * a 401 that looks like the gatekeeper's fault. Neither has a cheap runtime signal,
 * so the coverage has to be here.
 */
describe("worker-level configuration", () => {
  /**
   * An `env` carrying neither documented name, deliberately. A reader that
   * silently fell back to the defaults would find `undefined` and throw in
   * `parsePrivateJwk`, so every assertion below distinguishes "the reader ran"
   * from "a default happened to work".
   */
  interface RenamedEnv {
    AGENT_KEY: string;
    ALLOWED_GATEKEEPERS: string;
  }

  const renamedEnv: RenamedEnv = {
    AGENT_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
    ALLOWED_GATEKEEPERS: JSON.stringify([GATEKEEPER_ORIGIN])
  };

  const renamed = createA2AWorker<RenamedEnv>({
    manifest: hostManifest,
    tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
    secrets: (e) => ({
      signingKey: e.AGENT_KEY,
      gatekeeperOrigins: e.ALLOWED_GATEKEEPERS
    })
  });

  it("signs with the key the secrets reader selected", async () => {
    const res = await renamed(
      new Request(`${AGENT_ORIGIN}${JWKS_PATH}`),
      renamedEnv
    );
    const body = await res.json<{ keys: Record<string, unknown>[] }>();

    expect(res.status).toBe(200);
    expect(body.keys[0].kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("verifies against the allowlist the secrets reader selected", async () => {
    const token = await makeGatekeeperToken({
      identity: { name: "anonymous" }
    });
    const res = await renamed(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      renamedEnv
    );

    // 400, not 401: the token verified against `ALLOWED_GATEKEEPERS` and died one
    // step later on the keyless identity. A 401 would mean the reader never
    // supplied the allowlist and every caller was refused identically.
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });

  it("refuses a gatekeeper outside the selected allowlist", async () => {
    const token = await makeGatekeeperToken();
    const res = await renamed(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      {
        ...renamedEnv,
        ALLOWED_GATEKEEPERS: JSON.stringify(["https://other.test"])
      }
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/not in the allowed gatekeeper origins/);
  });

  /**
   * The audience override, both branches.
   *
   * The audience is a two-sided contract — whatever is required here has to be
   * exactly what the gatekeeper mints — so the load-bearing assertion is that
   * setting it *stops* accepting the default. An override that were quietly
   * ignored would still pass every "accepts the right token" test, because the
   * default endpoint audience is what the tests mint by default.
   */
  const OVERRIDE_AUDIENCE =
    "https://gatekeeper.test/minted-for-this-deployment";

  const overridden = createA2AWorker({
    manifest: hostManifest,
    tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
    audience: OVERRIDE_AUDIENCE
  });

  it("rejects the default endpoint audience once an override is set", async () => {
    const token = await makeGatekeeperToken(); // the default `${origin}/a2a`
    const res = await overridden(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      env
    );

    expect(res.status).toBe(401);
  });

  it("accepts a token minted for the overridden audience", async () => {
    const token = await makeGatekeeperToken({
      audience: OVERRIDE_AUDIENCE,
      identity: { name: "anonymous" }
    });
    const res = await overridden(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });

  it("passes the full request URL to an audience callback", async () => {
    // The callback form exists for a deployment whose audience depends on where
    // the request arrived — so what it receives is the whole `URL`, not just the
    // origin, and it is called per request rather than once at construction.
    const seen: string[] = [];
    const byCallback = createA2AWorker({
      manifest: hostManifest,
      tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
      audience: (url) => {
        seen.push(url.href);
        return `${url.origin}/from-callback`;
      }
    });

    const token = await makeGatekeeperToken({
      audience: `${AGENT_ORIGIN}/from-callback`,
      identity: { name: "anonymous" }
    });
    const res = await byCallback(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      env
    );

    expect(seen).toEqual([`${AGENT_ORIGIN}/a2a`]);
    // The returned string is what was actually enforced, not merely computed.
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });
});

/**
 * Several agents on one origin, addressed by `tenant`.
 *
 * They share an endpoint, so they share an `aud` — the audience proves a token
 * was minted for this *deployment* and can say nothing about which agent on it.
 * Everything below is about the claim that can.
 */
describe("tenant routing", () => {
  const call = (body: unknown, token: string): Promise<Response> =>
    worker(post(body, { authorization: `Bearer ${token}` }), env);

  it("refuses a request that names no tenant", async () => {
    // No default agent: picking one would mean serving a caller an agent it
    // never asked for.
    const token = await makeGatekeeperToken();
    const res = await call(
      { jsonrpc: "2.0", id: 7, method: "SendMessage", params: {} },
      token
    );
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/params\.tenant is required/);
    // The error has to say how to recover, since the stub card cannot list them.
    expect(body.error.message).toMatch(/GetExtendedAgentCard/);
  });

  it("refuses a tenant no agent is registered under", async () => {
    const token = await makeGatekeeperToken({ tenant: "ghost" });
    const res = await call(sendMessage({}, "ghost"), token);
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/unknown tenant 'ghost'/);
  });

  it.each(["toString", "constructor", "__proto__"])(
    "refuses the inherited property name '%s' as a tenant",
    async (name) => {
      // The tenant id reaches this lookup as a caller-supplied string, so the
      // registry is read by *own* property. Plain indexing would hand back
      // something off `Object.prototype` — truthy, and not an agent — which
      // reaches past the guard and dies reading `.manifest` off it: a 500 in
      // place of the 400 this names.
      //
      // Reachable without a hostile gatekeeper. A tenant id is whatever an agent
      // was registered under, and `constructor` is a plausible name.
      const token = await makeGatekeeperToken({ tenant: name });
      const res = await call(sendMessage({}, name), token);
      const body = await res.json<{ error: { message: string } }>();

      expect(body.error.message).toMatch(`unknown tenant '${name}'`);
    }
  );

  it("refuses a token minted for a sibling tenant", async () => {
    // The replay this design has to stop. The token is entirely valid — right
    // gatekeeper, right signature, right audience, and the audience *cannot*
    // distinguish siblings because they share one endpoint. Only the tenant
    // claim separates them, so if this ever returns anything but 401, one agent
    // can spend another's token by editing a field in the request body.
    const token = await makeGatekeeperToken({ tenant: "sibling" });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/authorizes tenant 'sibling'/);
  });

  it("refuses a token carrying no tenant claim at all", async () => {
    // A gatekeeper too old to scope its tokens. Treating an absent claim as a
    // wildcard would silently reopen the replay above for every such caller.
    const token = await makeGatekeeperToken({ tenant: "" });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/authorizes tenant '<none>'/);
  });

  it("accepts a token whose tenant matches the one addressed", async () => {
    const token = await makeGatekeeperToken({
      identity: { name: "anonymous" }
    });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    // 400, not 401: the token verified and the tenant matched, so the call died
    // one step later on the keyless identity. Anything 401 would mean the
    // tenant check rejected a legitimate call.
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });
});

describe("claim-name overrides", () => {
  // For a deployment fronted by something other than slack-gatekeeper, which
  // names these claims in its own namespace.
  const identityClaim = "https://elsewhere.test/identity";
  const tenantClaim = "https://elsewhere.test/tenant";

  const renamedClaims = createA2AWorker({
    manifest: hostManifest,
    tenants: { [TEST_TENANT]: tenantAgent("worker-spec-renamed") },
    identityClaim,
    tenantClaim
  });

  const call = (body: unknown, token: string): Promise<Response> =>
    renamedClaims(post(body, { authorization: `Bearer ${token}` }), env);

  it("reads both claims from the configured names", async () => {
    const token = await makeGatekeeperToken({ identityClaim, tenantClaim });
    const res = await renamedClaims(
      post(
        sendMessage({
          request: {
            messageId: "m1",
            role: "ROLE_USER",
            parts: [{ text: "hello" }]
          }
        }),
        {
          authorization: `Bearer ${token}`,
          "A2A-Version": A2A_PROTOCOL_VERSION
        }
      ),
      env
    );
    const body = await res.json<{ error: { message: string } }>();

    // Asserted on the push-config contract rather than anything nearer, because
    // that check sits past *both* claim reads: getting here means the identity
    // was found under its configured name (an unread identity has no key, which
    // 400s first) and the tenant matched under its own. A 401 is the tenant
    // claim not reaching `verifyGatekeeperToken` — it falls back to the default
    // name, finds nothing, and refuses a legitimate call as carrying no tenant.
    expect(res.status).toBe(200);
    expect(body.error.message).toMatch(/taskPushNotificationConfig/);
  });

  it("refuses a token naming the tenant under the default claim", async () => {
    // The override moves the name rather than adding an alternative: this token
    // carries a perfectly good tenant, just under the Dynamic Agents name this worker
    // was configured away from. Accepting it would mean a renamed deployment
    // still honours whatever the default namespace says.
    //
    // The identity claim is minted at the configured name on purpose, so the
    // keyless-identity 400 cannot mask what this is asserting.
    const token = await makeGatekeeperToken({ identityClaim });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/authorizes tenant '<none>'/);
  });
});

describe("GetExtendedAgentCard", () => {
  const getCard = async (tenant: string, tokenTenant = tenant) => {
    const token = await makeGatekeeperToken({ tenant: tokenTenant });
    return worker(
      post(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "GetExtendedAgentCard",
          params: { tenant }
        },
        {
          authorization: `Bearer ${token}`,
          "A2A-Version": A2A_PROTOCOL_VERSION
        }
      ),
      env
    );
  };

  it("returns the addressed tenant's own signed card", async () => {
    // The only way to get a tenant's card, since the well-known path serves the
    // stub. A gatekeeper registering an agent pins the key from exactly this.
    const res = await getCard(TEST_TENANT);
    const body = await res.json<{
      result: {
        name: string;
        supportedInterfaces: { tenant: string; url: string }[];
        signatures: { protected: string }[];
      };
    }>();

    expect(body.result.name).toBe("worker-spec-agent");
    expect(body.result.supportedInterfaces[0].tenant).toBe(TEST_TENANT);
    // Every tenant answers on the one endpoint — that is what tenant is for.
    expect(body.result.supportedInterfaces[0].url).toBe(`${AGENT_ORIGIN}/a2a`);

    const header = JSON.parse(
      atob(
        body.result.signatures[0].protected
          .replace(/-/g, "+")
          .replace(/_/g, "/")
      )
    );
    expect(header.jku).toBe(`${AGENT_ORIGIN}${JWKS_PATH}`);
  });

  it("distinguishes tenants", async () => {
    const res = await getCard("sibling");
    const body = await res.json<{ result: { name: string } }>();
    expect(body.result.name).toBe("worker-spec-sibling");
  });

  it("survives the SDK re-encoding the card it returns", async () => {
    // The transport runs `AgentCard.toJSON()` over whatever the provider
    // returns, so returning an already-encoded wire card would encode twice.
    //
    // `advertiseSecuritySchemes` is on here deliberately, and this spec is
    // close to worthless without it: `securitySchemes` is the card's only
    // protobuf *oneof*, and the second encode is what collapses
    // `{ gatekeeperJwt: { httpAuthSecurityScheme: … } }` to `{ gatekeeperJwt: {} }`.
    // With schemes off — the default — encoding twice is a no-op and this
    // passes against the broken implementation too.
    const advertising = createA2AWorker({
      manifest: hostManifest,
      tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
      advertiseSecuritySchemes: true
    });

    const res = await advertising(
      post(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "GetExtendedAgentCard",
          params: { tenant: TEST_TENANT }
        },
        {
          authorization: `Bearer ${await makeGatekeeperToken()}`,
          "A2A-Version": A2A_PROTOCOL_VERSION
        }
      ),
      env
    );
    const { result } = await res.json<{ result: Record<string, unknown> }>();

    // The scheme survived the round trip at all — if this collapsed, the
    // signature check below would fail for a reason worth naming separately.
    expect(result.securitySchemes).toMatchObject({
      gatekeeperJwt: { httpAuthSecurityScheme: { scheme: "bearer" } }
    });

    // Verified exactly as slack-gatekeeper does: decode what arrived, re-encode,
    // check the detached JWS. Rejects if the served document is not the one
    // that was signed.
    const { d: _d, ...publicJwk } = TEST_AGENT_PRIVATE_JWK;
    void _d;
    const verify = verifyAgentCardSignature(async () => publicJwk);
    await expect(
      verify(AgentCard.toJSON(AgentCard.fromJSON(result)) as AgentCard)
    ).resolves.not.toThrow();
  });

  it("is refused when the token names a different tenant", async () => {
    // Fetching a card is authorized the same way sending a message is; a
    // caller cannot enumerate its siblings' cards with its own token.
    const res = await getCard("sibling", TEST_TENANT);
    expect(res.status).toBe(401);
  });
});

describe("the accept-and-notify contract", () => {
  const authed = async (params: object) =>
    worker(
      post(sendMessage(params), {
        authorization: `Bearer ${await makeGatekeeperToken()}`,
        "A2A-Version": A2A_PROTOCOL_VERSION
      }),
      env
    );

  const message = {
    messageId: "m1",
    role: "ROLE_USER",
    parts: [{ text: "hello" }]
  };

  it("rejects a send with no push-notification config as a JSON-RPC error", async () => {
    // Deliberately a JSON-RPC error and not a failed task: a failed task reads
    // to a client as an accepted turn that will never call back.
    const res = await authed({ request: { message } });
    const body = await res.json<{ id: number; error: { message: string } }>();

    expect(res.status).toBe(200);
    expect(body.id).toBe(7);
    expect(body.error.message).toMatch(/taskPushNotificationConfig\.url/);
  });

  it("rejects a push config with a url but no correlation token", async () => {
    const res = await authed({
      request: { message },
      configuration: {
        taskPushNotificationConfig: { url: "https://gatekeeper.test/cb" }
      }
    });
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/taskPushNotificationConfig\.token/);
  });

  it("rejects a push config whose url is not a URL", async () => {
    const res = await authed({
      request: { message },
      configuration: {
        taskPushNotificationConfig: { url: "not a url", token: "t" }
      }
    });
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/not a valid URL/);
  });

  /** A push config the contract check passes, so a send reaches the next one. */
  const pushed = {
    taskPushNotificationConfig: {
      url: "https://gatekeeper.test/cb",
      token: "t"
    }
  };

  it("rejects a message whose text is over the bound both ends enforce", async () => {
    // Split across two parts, one of them exactly at the bound: the agreement is
    // that the parts are summed with no separator, so this is over it by a byte
    // and a reader that measured per part would take it.
    const res = await authed({
      message: {
        ...message,
        parts: [{ text: "x".repeat(MAX_MESSAGE_TEXT_BYTES) }, { text: "y" }]
      },
      configuration: pushed
    });
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/message text exceeds/);
  });

  it("takes a message whose text is exactly at the bound", async () => {
    // The other half of the same agreement. A sender that stops one byte short
    // of what the receiver takes throws away the top of the range for nothing,
    // so the boundary byte has to be spelled the same on both sides.
    const res = await authed({
      message: {
        ...message,
        parts: [{ text: "x".repeat(MAX_MESSAGE_TEXT_BYTES) }]
      },
      configuration: pushed
    });
    const body = await res.json<{ error?: { message: string } }>();

    expect(body.error?.message ?? "").not.toMatch(/message text exceeds/);
  });

  it("echoes the request id so a client can correlate the rejection", async () => {
    const res = await authed({ request: { message } });
    expect((await res.json<{ id: number }>()).id).toBe(7);
  });

  it("can be turned off for an agent that replies inline", async () => {
    const inline = createA2AWorker({
      manifest: hostManifest,
      tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
      requirePushConfig: false
    });

    const res = await inline(
      post(sendMessage({ request: { message } }), {
        authorization: `Bearer ${await makeGatekeeperToken()}`,
        "A2A-Version": A2A_PROTOCOL_VERSION
      }),
      env
    );

    // Past the contract check, so it reaches dispatch — which these specs
    // deliberately do not provide. The point is only that it got that far.
    const body = await res.json<{ error?: { message: string } }>();
    expect(body.error?.message ?? "").not.toMatch(/taskPushNotificationConfig/);
  });
});

describe("protocol version negotiation", () => {
  it("refuses a caller that does not ask for a version the card advertises", async () => {
    // An absent header is read as 0.3 by the SDK, which a v1.0-only card does
    // not advertise — rejected here rather than silently mis-served.
    const res = await worker(
      post(sendMessage({}), {
        authorization: `Bearer ${await makeGatekeeperToken()}`
      }),
      env
    );
    const body = await res.json<{ id: number; error: { code: number } }>();

    expect(body.error).toBeDefined();
    expect(body.id).toBe(7);
  });
});

/**
 * A message on a Task that already exists.
 *
 * The only one a Task takes is the answer to a question it asked, and the Worker
 * is where anything else is refused: past it, a refusal is an executor throw,
 * and the handler turns that into a failed Task — ending the Task a person was
 * in the middle of answering.
 */
describe("a message on an existing task", () => {
  const parkedId = "t-parked";
  const wake: TurnWake = { messageId: "m-original", eventType: "hitl-q1" };

  /** A tenant whose one Task is parked on a question, recording what reaches it. */
  function parkedTenant(options: { resumable?: boolean } = {}) {
    const answered: unknown[] = [];
    const woken: TurnWake[] = [];
    // What the handler last wrote, so a read after its own write sees it — a
    // cancel reads the Task back to confirm it took.
    let stored: Task = testTask(
      parkedId,
      "ctx-1",
      TaskState.TASK_STATE_INPUT_REQUIRED
    );
    const agent = {
      async beginTask(): Promise<never> {
        throw new Error("a reply must never begin a task");
      },
      async getTask(taskId: string) {
        return taskId === parkedId ? structuredClone(stored) : null;
      },
      async saveTask(task: Task) {
        stored = structuredClone(task);
        return true;
      },
      async cancelTask() {
        return null;
      },
      async answerTask(input: unknown) {
        answered.push(input);
        return {
          task: {
            ...testTask(parkedId, "ctx-1", TaskState.TASK_STATE_WORKING),
            status: testStatus(TaskState.TASK_STATE_WORKING)
          },
          wake
        };
      },
      async humanWake() {
        return wake;
      }
    };
    const handler = createA2AWorker({
      manifest: hostManifest,
      tenants: {
        [TEST_TENANT]: {
          manifest: manifest("worker-spec-parked"),
          resolveAgent: () => agent as never,
          startTurn: async () => {
            throw new Error("a reply must never start a turn");
          },
          ...(options.resumable === false
            ? {}
            : {
                resumeTurn: async (w: TurnWake) => {
                  woken.push(w);
                }
              })
        }
      }
    });
    const call = async (body: unknown) =>
      handler(
        post(body, {
          authorization: `Bearer ${await makeGatekeeperToken()}`,
          "A2A-Version": A2A_PROTOCOL_VERSION
        }),
        env
      );
    return { call, answered, woken };
  }

  /** A `SendMessage` onto the parked Task, carrying `parts`. */
  const onto = (parts: unknown[]) =>
    sendMessage({
      message: {
        messageId: "gk-token:r:q1",
        role: "ROLE_USER",
        taskId: parkedId,
        parts
      },
      configuration: {
        taskPushNotificationConfig: {
          url: "https://gatekeeper.test/cb",
          token: "gk-token"
        }
      }
    });

  const answer = [
    { text: "org/web" },
    {
      data: {
        type: HITL_RESPONSE_TYPE,
        requestId: "q1",
        optionId: "option_2",
        answeredBy: "U1"
      },
      mediaType: "application/json"
    }
  ];

  it("hands an answer to the waiting task and wakes its run", async () => {
    const { call, answered, woken } = parkedTenant();

    const res = await call(onto(answer));
    const body = await res.json<{
      error?: { message: string };
      result?: { task?: { id: string; status: { state: string } } };
    }>();

    expect(body.error).toBeUndefined();
    expect(body.result?.task?.id).toBe(parkedId);
    expect(body.result?.task?.status.state).toBe("TASK_STATE_WORKING");
    expect(answered).toEqual([
      expect.objectContaining({
        taskId: parkedId,
        messageId: "gk-token:r:q1",
        reply: expect.objectContaining({ kind: "answer", requestId: "q1" })
      })
    ]);
    expect(woken).toEqual([wake]);
  });

  it("refuses an ordinary message on a task, and leaves the task waiting", async () => {
    const { call, answered, woken } = parkedTenant();

    const res = await call(onto([{ text: "and one more thing" }]));
    const body = await res.json<{ error?: { message: string } }>();

    expect(body.error?.message).toMatch(
      /must answer the question the task asked/
    );
    expect(answered).toEqual([]);
    expect(woken).toEqual([]);
  });

  it("refuses an over-long answer, and leaves the task waiting", async () => {
    // The case the bound is written down for. A person answers, the gatekeeper
    // marks the question answered and forwards the text; a refusal that arrives
    // after that leaves the question spent and the answer nowhere, and the only
    // repair is to ask again. As a JSON-RPC error it is a refusal of the
    // message, and the Task is still waiting for a shorter one.
    const { call, answered, woken } = parkedTenant();

    const res = await call(
      onto([{ text: "x".repeat(MAX_MESSAGE_TEXT_BYTES + 1) }, answer[1]])
    );
    const body = await res.json<{ error?: { message: string } }>();

    expect(body.error?.message).toMatch(/message text exceeds/);
    expect(answered).toEqual([]);
    expect(woken).toEqual([]);
  });

  it("refuses a message on a task when the agent's tasks never ask", async () => {
    const { call, answered } = parkedTenant({ resumable: false });

    const res = await call(onto(answer));
    const body = await res.json<{ error?: { message: string } }>();

    expect(body.error?.message).toMatch(
      /takes no messages on an existing task/
    );
    expect(answered).toEqual([]);
  });

  it("wakes the run of a task canceled while it waited", async () => {
    // The cancel reaches the Durable Object through the task store, where
    // nothing can reach a Workflow. Without this the run sits on its question
    // until the question expires.
    const { call, woken } = parkedTenant();

    const res = await call({
      jsonrpc: "2.0",
      id: 9,
      method: "CancelTask",
      params: { tenant: TEST_TENANT, id: parkedId }
    });
    const body = await res.json<{ error?: { message: string } }>();

    expect(body.error).toBeUndefined();
    expect(woken).toEqual([wake]);
  });
});
