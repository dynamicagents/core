# @dynamicagents/core

**The mandatory foundation for a Dynamic Agent on Cloudflare Workers.**

Zero-trust A2A (signed AgentCard, gatekeeper-JWT verification, no shared secrets), the
durable task lifecycle, the delegation and subagent runtime, and the test harness.

You bring the loop and the prompts. Core brings everything you cannot choose not to have.

```bash
npm install @dynamicagents/core
```

> Part of a three-package split:
> **`@dynamicagents/core`** (this) ·
> [`plugins`](https://github.com/dynamicagents/plugins) (optional, composable capabilities) ·
> [`starter`](https://github.com/dynamicagents/starter) (a working agent that composes them).

---

## Why this exists

An agent that talks to other agents has to answer one question before anything else:
_is the caller who they claim to be, and can they prove it without a shared secret?_
That answer — and the durable machinery for accepting a turn, decomposing it, and
delivering a result out of band — is identical for every agent. It is also the part
that is easy to get subtly and silently wrong.

So it ships once, here, with the security-critical paths pinned by tests. Anything
optional is a plugin. Anything opinionated belongs to your app.

---

## Quick start

### 1. Generate a signing key

```bash
npx da-keys
```

Set the private JWK as `A2A_SIGNING_KEY` (`.env` locally; `wrangler deploy
--secrets-file .env` or `wrangler secret put` when deployed) and the origins you accept
calls from as `GATEKEEPER_ORIGINS`:

```ini
# .env
A2A_SIGNING_KEY={"crv":"Ed25519","d":"…","x":"…","kty":"OKP","kid":"a2a-2026-08-01"}
GATEKEEPER_ORIGINS=["https://gatekeeper.example.com"]
```

The public half is never configured anywhere — the Worker derives it from the private
key and serves it at the card's `jku`.

### 2. Put the A2A edge in front of your Durable Object

```ts
import { createA2AWorker } from "@dynamicagents/core/worker";

const manifest = {
  name: "my-agent",
  description: "Does a useful thing.",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

export default {
  fetch: createA2AWorker({
    // The stub card at /.well-known/agent-card.json. It describes the origin,
    // not an agent — see below.
    manifest: hostManifest,
    tenants: {
      "my-agent": {
        manifest,
        // One DO instance per verified caller — this is what makes a task
        // unreachable from any other caller by construction.
        resolveAgent: (identity) =>
          env.MY_AGENT.get(env.MY_AGENT.idFromName(identity.key!)),
        // Must be idempotent: the gatekeeper retries dispatch.
        startTurn: async (turn) => {
          await env.TURN_WORKFLOW.create({ id: turn.messageId, params: turn });
        }
      }
    }
  })
} satisfies ExportedHandler<Env>;
```

That handler serves three routes: the public JWKS, a **signed** stub AgentCard at
`/.well-known/agent-card.json`, and gatekeeper-authenticated JSON-RPC. Every POST is verified
before a Durable Object is ever addressed.

#### Agents are tenants

Agents are keyed by **tenant id**, and one is required on every request — there is no
default agent and no implicit routing. This is the A2A mechanism for exactly this case:
`AgentInterface.tenant` is _"an opaque string used for routing requests to a specific agent
or tenant when multiple agents are served behind a single A2A endpoint"_, and §8.3.2
requires a client to send the value the interface it selected declared.

So one origin serves any number of agents over **one endpoint, one signing key and one
card** at the well-known path. It works the same for one agent as for twenty; nothing about
the shape changes.

The card is the reason it has to be this way rather than a path prefix per agent. Its
location is a **well-known URI**, which RFC 8615 defines per-authority, so exactly one card
per origin is discoverable at the path A2A registered with IANA. A gatekeeper resolving
`/.well-known/agent-card.json` against the origin finds that one card whatever prefix an
agent is mounted behind — and pins its key for all of them.

Which is why the card served there is a **stub**: it describes the deployment, advertises
the endpoint and `extendedAgentCard`, and names no tenant. A tenant's real card — its name,
skills and signature — comes from `GetExtendedAgentCard`, the spec's own tenant-aware card
method:

```jsonc
// POST /a2a
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "GetExtendedAgentCard",
  "params": { "tenant": "my-agent" }
}
```

A card carries one interface entry and clients take the first, so the stub cannot list its
siblings — put their names in `description` for a human, and register them out of band.

Two independent checks keep one tenant's traffic out of another's:

| check        | proves                                       |
| ------------ | -------------------------------------------- |
| `aud`        | the token was minted for **this deployment** |
| tenant claim | …and for **this agent on it**                |

The second is load-bearing. Every tenant shares one endpoint and therefore one audience, so
the audience cannot distinguish them: without the claim, `tenant` would be an
unauthenticated field in the request body and a token minted for one agent could be replayed
against any sibling. A token carrying no tenant claim is rejected rather than treated as a
wildcard.

> **Breaking.** Requires a gatekeeper that mints both the endpoint audience and the tenant
> claim, and registers agents with a tenant id — slack-gatekeeper
> [#62](https://github.com/dynamicagents/slack-gatekeeper/pull/62). The two sides do not
> interoperate across this change in either direction, so they deploy together and
> registered agents are re-registered.

### 3. Write your Durable Object

`DynamicAgent` is the DO body every agent has: the runtime and database built once
per instance, one continuous Session per verified caller, the gatekeeper callback
channel, and the task lifecycle a Workflow drives. Three seams are yours.

```ts
import { DynamicAgent, type PluginHost } from "@dynamicagents/core/host";

export class MyAgent extends DynamicAgent<Env> {
  protected agentConfig() {
    return {
      model: {
        chatModelId: "@cf/zai-org/glm-5.2",
        fallbackChatModelId: "@cf/meta/llama-4-scout-17b-16e-instruct"
      }
    };
  }
  protected agentPlugins(host: PluginHost<Env>) {
    return [scraper({ apiKey: host.env.SCRAPER_API_KEY })];
  }
  protected agentSoul(capabilities: string) {
    return soulPrompt(capabilities);
  }
}
```

Everything that would otherwise be a module-level constant is resolved from those,
once per instance. Resolving a registry at _import_ time is the one thing this
package exists to prevent: it freezes the registry before `env` exists (which on
Workers is always), defeats tree-shaking, and makes runtime plugin selection
impossible.

`createAgentRuntime` and `AgentDB` are still exported and still work on a bare
`Agent<Env>` — but everything the base class does is lifecycle with an ordering
that is load-bearing and invisible (migrations awaited before the first RPC, the
guarded terminal write, the cancellation verdict that must be read and not
probed for), and hand-rolling it is how two agents in one repo drift apart.

### 4. Delegate, if your agent delegates

`@dynamicagents/core/round` adds the other half: durable Subtasks, concurrent
execution, isolated subagents, and the round loop over them.

```ts
import { RoundAgentBase, type RoundPolicy } from "@dynamicagents/core/round";

export class MyAgent extends RoundAgentBase<Env> {
  // …the three seams above, plus:
  protected roundPolicy(): RoundPolicy {
    return policy;
  }
  protected subagentClass() {
    return MySubagent;
  }
}
```

#### The round policy

Core ships the machine and none of the words. `RoundPolicy` is every string the
loop emits — the round contract the model is held to, the note appended when the
loop forces a round to answer, and the three user-facing messages. Nothing has a
default: a lent-out round contract is exactly the house prompt copy this package
refuses to have.

The loop forces an answer for more than one reason, so `finalRoundNote` is handed
the one that applies:

```ts
finalRoundNote: (limits, reason) =>
  reason === "no-progress"
    ? "\n\n# This keeps coming back the same way\n…"
    : `\n\n# Your budget is spent\n…${limits.maxTurns} turns…`;
```

`budget` is the Task's turns or wall clock running out. `no-progress` is several
rounds in a row whose every subtask failed with the identical message: the budget
is intact, and a round told otherwise passes that on to the user as the
explanation for what went wrong. An implementation that ignores the argument
still satisfies the interface and gets one note for both — accurate about the
constraint, wrong about the cause.

#### What a round remembers

A round is one `generateText` call, so the work tools it uses and the results
they return live inside it. What reaches the Session is the round's _ending_ —
the acknowledgment the user read. Left there, every round inherits its
predecessors' claims and none of their evidence, and a loop that cannot see what
it already tried repeats it: one deployed task delegated thirteen times over
twelve minutes and re-made the same rejected clone URL in every round, because
the rejection was a tool result and tool results did not survive a round.

So a delegating round's work-tool exchanges are persisted alongside its Subtask
rows and restored for the rounds after it, as the call-and-result pairs they
actually were — the same reconstruction the `delegate` call itself already gets.
`roundObservationWindow` is how many earlier rounds a round can still see, and
the carried rounds are elided against one another, so a tool called three times
costs roughly one result rather than three:

```ts
resolveConfig({
  model: MODELS,
  // Two is enough for the case this exists for: the wall a round just hit is the
  // wall it is about to hit again. Zero opts out entirely.
  roundObservationWindow: 2,
  toolOutputWindow: 4
});
```

The rows are core's third table, they are never written into the Session — history
stays text-only — and they age out on the same 30-day clock as the rest of a
Task's state.

---

## Exports

No root barrel. Each area is its own subpath, so importing the delegation layer does
not drag in the A2A adapter, and the test harness cannot reach a production bundle.

| Subpath                            | What's in it                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `@dynamicagents/core`              | `createAgentRuntime`, the plugin contract, config shapes, platform facts     |
| `@dynamicagents/core/a2a`          | card signing, JWKS, gatekeeper-JWT verify, push notify, task store, executor |
| `@dynamicagents/core/worker`       | `createA2AWorker()` — the whole zero-trust edge                              |
| `@dynamicagents/core/agent`        | session, history, models + Workers AI, inference, budget, control tools      |
| `@dynamicagents/core/host`         | `DynamicAgent` — the Durable Object body — and `PluginHost`                  |
| `@dynamicagents/core/round`        | the delegating round loop: `RoundAgentBase`, `runHandleTask`, `runTurn`      |
| `@dynamicagents/core/subtasks`     | delegation types, decomposition, the `delegate` tool                         |
| `@dynamicagents/core/subagent`     | `RecipeSubagentBase`, resumable runs, fingerprinting, workspace              |
| `@dynamicagents/core/db`           | `AgentDB`, the three-table schema, migrations, `PluginStore`                 |
| `@dynamicagents/core/testing`      | VCR, `FakeSession`, `mockModel`, DO helpers, JWK fixtures — _workerd realm_  |
| `@dynamicagents/core/testing/node` | the VCR recorder + cassette store — _Node realm, never import from a spec_   |
| `@dynamicagents/core/eslint`       | the `no-deprecated-object-properties` rule                                   |

`/testing*` and `/eslint` are structurally incapable of entering a runtime graph, and
`npm run verify:exports` asserts exactly that before every publish.

---

## The zero-trust model

No secret ever crosses the boundary, in either direction.

```
Gatekeeper ──── EdDSA JWT, jku → its public JWKS ────▶ Agent    "the agent knows the gatekeeper"
Agent   ──── signed AgentCard, jku → its JWKS  ────▶ Gatekeeper  "the gatekeeper knows the agent"
```

`verifyGatekeeperToken` runs four checks, in this order, on every single call:

1. **`jku` present** in the protected header (RFC 7515 §4.1.2).
2. **`jku` origin is allowlisted** — validated _before_ the fetch, so an attacker
   cannot point `jku` at a JWKS they control.
3. **`iss` origin equals `jku` origin** — one listed gatekeeper cannot impersonate another.
4. **`jwtVerify` pinned to EdDSA.**

All four are load-bearing. Do not make any of them optional, and do not add a
local-development bypass — run a local gatekeeper instead. `verify.spec.ts` asserts each
one negatively, including that an unlisted `jku` is rejected _before_ any network
call happens.

The agent's card is signed over its **wire (protobuf-JSON) encoding**, which is what
makes the served document a fixed point under the repeated decoding a verifier
performs. A gatekeeper pins the card's `kid` + `jku` on first registration
(Trust-On-First-Use).

### Calling out, and knowing your own origin

The same key proves this agent to services that are not the gatekeeper — another agent,
or any service that verifies against the published JWKS. `signCallerToken` mints the
short-lived token for that: `iss` is
this deployment's origin, `jku` is derived from it, and the audience is normalized to a
bare origin because the far side compares it byte-for-byte.

Its `iss` is **not** something to configure. Inside a Durable Object it is:

```ts
protected override modelRuntime(model: ModelConfig): ModelRuntime {
  return myProvider(this.env, model, () => this.requireSelfOrigin());
}
```

`requireSelfOrigin()` (and `selfOrigin()`, which returns `undefined` instead of
throwing) answer with the origin core already delivers: the executor computes the
callback `jku` from `new URL(request.url).origin`, and it rides every turn into the DO
and on into each subagent facet. A `SELF_ORIGIN` secret only restates that, and has to
be kept byte-identical with the verifier's allowlist by hand in every environment.

The first turn an instance serves **pins** it, and nothing is persisted. Pinning is
what makes it safe to read: turns run concurrently in one Durable Object and a
credential thunk fires several frames below the turn that set the value, so a mutable
field could hand one turn another's origin. An agent has one endpoint anyway — the one
its card advertises and a verifier allowlists — and a fresh isolate on deploy re-learns
it.

It is known **inside a turn or a chunk**: `onStart`, a constructor and a scheduled
callback all run before any request has said what this deployment is called, and
`requireSelfOrigin()` throws there saying so.

---

## Plugins

A capability is a plugin. Core never imports one — your app registers it, which keeps
bundle size proportional to what you actually installed.

```ts
import { definePlugin } from "@dynamicagents/core";

export const scraper = (config: { apiKey: string }) =>
  definePlugin({
    key: "scraper",
    subtaskType: {
      key: "scrape",
      description: "fetch a page and summarize it",
      params: z.object({ url: z.string().describe("page to fetch") }),
      recipe
    },
    toolFamilies: { web: (ctx) => ({ tools: { fetchPage: /* … */ } }) },
    capability: "You can scrape a page and summarize it.",
    requires: { secrets: ["SCRAPER_API_KEY"] },
    store: { plugin: "scraper", version: 1, ensureTables: (sql, from) => { /* … */ } }
  });
```

`createAgentRuntime` fails at DO start — never mid-request — on a duplicate plugin
key, a duplicate tool family, a missing declared binding, or a
`PLUGIN_CONTRACT_VERSION` mismatch. Because core, plugins, and starter publish from
separate repos, one of them is always briefly behind; that version assert turns the
skew into a readable sentence instead of a structural-type error several frames from
its cause.

The contract is **additive-only within a major**: new capabilities arrive as optional
fields on `AgentPlugin`.

### Plugin-owned tables

A plugin owns its tables outright, through `store: PluginStore` — but it must stay out of
core's migration journal. `drizzle-orm/durable-sqlite/migrator` keeps one flat integer
journal and one global `__drizzle_migrations` table, and two independently-versioned
packages cannot share that index space.

That is a prohibition on exactly **one import**, not on drizzle. The query builder holds
no journal and no connection state, so a plugin declares its tables with `sqliteTable`,
writes idempotent DDL in `ensureTables`, and queries through its own handle:

```ts
export const scrapes = sqliteTable("scraper_scrapes", { url: text("url").primaryKey() });

store: {
  plugin: "scraper",
  version: 1,
  // Re-run on every hibernation wake-up, so it must be idempotent.
  ensureTables: (sql) => sql.exec(`CREATE TABLE IF NOT EXISTS scraper_scrapes (…)`)
}

// …and anywhere the plugin queries:
const db = drizzle(storage, { schema: { scrapes } });
```

Core records each store's version in a `plugin_migrations` row, so `ensureTables` receives
the version last seen on disk and an upgrade path can branch on it.

### Session hooks

`onMessagesDisplaced` hands over the raw messages a compaction is about to fold into a
summary. Core performs the compaction, so core announces the loss; it neither stores the
messages nor knows who wants them. An episodic-memory plugin, an audit log, and a
cold-storage dump all want exactly this callback, and each gets it:

```ts
// in your DO, wiring the runtime's fan-out into the session
buildAgentSession(this, model, {
  …,
  onMessagesDisplaced: this.runtime.onMessagesDisplaced
});
```

Best-effort in both directions — a listener that throws never aborts compaction (history
must still shorten when a side store is down), and the fan-out is `Promise.allSettled`, so
one plugin's outage cannot cost another its notification.

`shouldHandleTurn` is the other side of the session: a gate that decides whether a turn
runs at all, before the loop builds or calls anything. An agent that sees every message in
its channels is mostly seeing messages that are not for it, and asking a model already
trying to be helpful to stay quiet degrades _invisibly_ — failing to call a decline-tool
looks identical to deciding not to. Every declaring plugin is consulted and the answers are
AND-ed, so any one gate may decline.

```ts
if (!(await this.runtime.shouldHandleTurn({ history }))) return; // declined
```

It **fails open**: a gate that throws is counted as `true`. The two mistakes are not
symmetric — a wrong reply is noise the user can see and ignore, while a wrong silence is
invisible to the person who needed an answer.

### The workspace backend

Core declares the `WorkspaceBacking` shape and enforces the caps, but ships no backend —
the predecessor's was `@cloudflare/shell`, which is experimental, and an agent that never
delegates file work should not carry it. A plugin supplies one via `workspaceBacking`; at
most one may, and an agent that installs none gets `memoryWorkspaceBacking`. So
`runtime.workspaceBacking` is always defined and your `SubagentRuntime` never needs a null
check.

---

## Testing

The harness both predecessor agents grew, shipped so you don't grow it a third time.

```ts
import {
  FakeSession,
  mockModel,
  makeGatekeeperToken,
  makeDoHelpers
} from "@dynamicagents/core/testing";

const { withDb } = makeDoHelpers(env.MY_AGENT);

await withDb("accepts a turn once", async (db) => {
  await db.ensureReady();
  db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c1" });
});
```

- **VCR** — record/replay real HTTP against on-disk cassettes, split across the Node
  and workerd realms because specs run in workerd, which has no filesystem. The
  recorder is a Miniflare `outboundService`, so it works on any
  `@cloudflare/vitest-plugin` and needs no `undici`:

  ```ts
  // vitest.config.ts
  const vcr = createVcr({
    snapshotsDir: path.resolve(import.meta.dirname, "test/snapshots"),
    record: recordFromEnv(), // RECORD=1
    excludeHeaders: ["authorization", "x-api-key"] // never written to a cassette
  });

  cloudflareTest({ miniflare: { outboundService: vcr.outboundService } });
  ```

  Then `setupRecording()` at the top of a spec gives every `it` its own cassette,
  auto-named from the file + describe + test names. Cassettes match on method, URL
  and body — never on headers, so a runtime upgrade cannot invalidate them — and a
  request with no active cassette is blocked rather than reaching the network.
  Point vitest's `globalSetup` at `@dynamicagents/core/testing/vcr-global-setup`.

- **Fakes** — `FakeSession` (a `SessionLike` reference implementation) and `mockModel`
  (a scripted `LanguageModel`), so a loop can be driven with no model call at all.
- **Fixtures** — Ed25519 keypairs and a gatekeeper-JWT signer, so the zero-trust path is
  exercisable end to end without a real gatekeeper.
- **`createAgentHarness`** — the assembly of all of the above: send one A2A turn the
  way a gatekeeper does, and capture what comes back.

  ```ts
  const harness = createAgentHarness({ worker, env, tenant: "reactive" });
  using _ = harness.interceptGatekeeper();

  const accepted = await harness.send("what's the weather?");
  expect(accepted.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  ```

  It exists because the pieces above were never the hard part. The audience is the
  **endpoint**, not the origin; the tenant claim has to match the tenant in the
  body; `SendMessage` is refused without a push config; and the gatekeeper's JWKS has
  to be reachable or every spec below it reports a 401 about something else. Four
  facts, wrong the first time in every consumer that wrote this by hand.

---

## What core deliberately does _not_ contain

- **Prompt copy of any kind.** Not a soul, not a round contract, not a user-facing
  failure message. `@dynamicagents/core/round` ships the whole delegating loop but takes
  every word it says from a [`RoundPolicy`](#the-round-policy) you write, because a
  run must never execute under an identity nobody chose.
- **A loop you cannot replace.** `/round` is opt-in and its own subpath. An agent
  whose turn is a single inference extends `DynamicAgent` directly, writes its own
  loop, and carries none of the delegation machinery in its bundle.
- The main agent's soul. Core ships no prompt copy.
- Config _values_ — model ids, budgets, limits. Core ships the shapes and safe
  defaults, and `resolveConfig` validates your overrides.
- Vectorize recall, browser tools, shell. All optional → plugins. Core contains no
  embedding code at all: it ships the `onMessagesDisplaced` hook and nothing about what
  a listener does with the messages — no embedding model, no index, no dimension.

---

## Requirements

- **Node** ≥ 24 (for build and test only — the package itself runs on workerd)
- **Bindings:** `AI`, one Durable Object, one Workflow
- **Secrets:** `A2A_SIGNING_KEY`, `GATEKEEPER_ORIGINS`
- **Peers, never bundled:** `agents`, `ai`, `workers-ai-provider`

That last point is not stylistic: two copies of `agents` in one Worker breaks the
`Session` / `SessionMessage` types and every `instanceof`. For local development
across the three repos use `file:` overrides, or `npm pack` plus a tarball install —
**not `npm link`**, which duplicates peer dependencies.

---

## Contributing

[`AGENTS.md`](./AGENTS.md) documents the constraints this package is guardian of.

```bash
npm run check           # prettier + eslint + tsc (src) + tsc (test) + build
npm test                # vitest, inside real workerd
npm run verify:exports  # the publish gate: subpaths, ESM specifiers, realm isolation
```

## License

[Apache-2.0](./LICENSE).
