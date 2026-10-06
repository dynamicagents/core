# @dynamicagents/core

**The mandatory foundation for a Dynamic Agent on Cloudflare Workers.**

Zero-trust A2A (signed AgentCard, gatekeeper-JWT verification, no shared secrets), and
the durable task around agents on [`@cloudflare/think`](https://www.npmjs.com/package/@cloudflare/think):
a host that owns the A2A task, a workflow that runs it as a pipeline of steps, and step
agents whose jobs outlive the turns that start them — accept, ask, cancel, delegate,
deliver.

Think runs the turn. You bring the model and the prompts. Core brings everything you
cannot choose not to have.

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
That answer — and the durable machinery for accepting a turn, running it, and
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
import { createA2AWorker, defineAgent } from "@dynamicagents/core/worker";

const manifest = {
  name: "my-agent",
  description: "Does a useful thing.",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

// One task host per verified caller, keyed by the gatekeeper identity — which
// is what makes a task unreachable from any other caller by construction.
const myAgent = defineAgent({
  tenant: "my-agent",
  manifest,
  agent: (env: Env) => env.MyAgentTasks
});

export default {
  // The stub card at /.well-known/agent-card.json describes the origin, not an
  // agent — see below.
  fetch: createA2AWorker<Env>({ manifest: hostManifest, agents: [myAgent] })
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

### 3. Write your host, your pipeline and your agent

A task is a pipeline of steps, and these roles run it, each the only owner of its
state:

| role              | core's class                 | owns                                                                                                                         |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **task host**     | `TaskHost` (`/task`)         | the A2A task: its ledger, the push channel, the delivery outbox, cancellation, the transcript's settle                       |
| **task workflow** | `TaskWorkflow` (`/workflow`) | the sequence of steps and the state between them — one Workflow instance per task, id = task id                              |
| **step agent**    | `StepAgent` (`/agent`)       | a step job and its conversation: a Think agent that runs the job over as many turns as it needs, and reports to the workflow |

`SendMessage` reaches the host, which records the task and starts its workflow. Every
word the gatekeeper hears comes from the host; a step agent speaks no A2A. A tenant
with one agent is a one-step pipeline.

```ts
import { TaskHost } from "@dynamicagents/core/task";
import { TaskWorkflow, type TaskStep } from "@dynamicagents/core/workflow";
import { StepAgent } from "@dynamicagents/core/agent";
import { gatewayLogFields, workersAIModel } from "@dynamicagents/core/model";

export class MyAgentTasks extends TaskHost<Env> {
  protected readonly copy = {
    failed: "Something went wrong on my side.",
    emptyReply: "I finished, but had nothing to say.",
    questionExpired: "Nobody answered in time, so I stopped."
  };
  protected readonly workflowBinding = "MY_AGENT_TASK";
  protected readonly hostBinding = "MyAgentTasks";
}

export class MyAgentTask extends TaskWorkflow<Env> {
  // Required, one line, in every pipeline: see below.
  override run(event, step) {
    return super.run(event, step);
  }

  protected async pipeline(event, step: TaskStep) {
    const plan = await step.agent("plan", {
      agent: "MyAgent",
      role: "plan",
      input: event.payload.text
    });
    const answer = await step.ask("approve", {
      kind: "approval",
      prompt: plan
    });
    if (answer.optionId !== "approve") return { reply: "Stopped at the plan." };
    await step.say("Building it.");
    return {
      reply: await step.agent("build", { agent: "MyAgent", input: plan })
    };
  }
}

export class MyAgent extends StepAgent<Env> {
  protected readonly compactAfterTokens = 100_000;
  protected readonly keepRecentTokens = 20_000;

  getModel() {
    return workersAIModel(this.env, {
      modelId: "@cf/zai-org/glm-5.2",
      sessionAffinity: this.name,
      ...gatewayLogFields({ agent: "my-agent", taskId: this.turnTaskId() })
    });
  }

  configureContext() {
    return [soulBlock, ...super.configureContext()];
  }
}
```

**The pipeline's helpers.** `step.agent(name, { agent, input, role?, key? })` runs a
job on a step agent — `agent` is its binding name, and the instance is always the
caller's — and returns its reply. `step.ask(name, request)` parks the task on a
question of the pipeline's own and returns the answer. `step.say(text)` pushes one
progress line. `step.do` is Workflows' own. A step whose job reports `failed` runs
once more, as `<name>:retry` with `attempt: 2`; a second failure fails the task, and
a step named with that suffix is refused. A name used twice in one run — a loop
without a `key` — fails the task by name, because Workflows would otherwise hand the
second the first one's result. A task holds one question at a time, so a
`step.ask`, or a job's `ask_user`, made while another question waits fails the task.

**Every pipeline declares `run()`,** as the one line above. The agents SDK gives a
workflow its host and its helpers only on a class that defines `run` itself, and an
inherited one would get neither, silently. The base constructor refuses a pipeline
that does not.

**A job spans turns.** It ends the way every Think turn does, when the model stops
calling tools, and its last words are its reply. On top of that, core gives the model
`ask_user` — the job parks, the host asks the caller, and the answer is the job's
next turn — and `search_history` over the conversation's own full-text index. An
`ask_user` naming an `artifact` is an approval of it: the question carries the
artifact's id and link, the caller answers Approve, Reject or with a typed comment,
the answer is filed on the artifact, and approving it locks it. Which artifacts a
model may ask about is `mayAskApproval`'s to say — by default, any still open —
and it is checked when the model calls `ask_user`, so a refusal is an
error the model reads in the same turn.
`check_back` is opt-in: `check_back: this.checkBackTool()` in `getTools()` lets the
model put a job down and pick it up later, as a scheduled wake rather than a wait
inside the turn. A turn runs inside the object's alarm, which the runtime stops after
fifteen minutes. A turn cut there is continued while its job is open, at the cost of
the step in flight, so a turn holds only steps that finish within it: work that can
run longer belongs outside it — a detached sub-agent, or a `check_back` wake. A turn
for a job that has ended — canceled, failed, completed — is not recovered, and every
tool it calls is refused.

What a job's `role` means, and what a retry should look at, are the agent's to say:
`formatStepJobInput(job)` briefs the model ahead of the input, and `turnStepJob()` gives
`beforeTurn` the job, to shape the tools a role may call.

**Wrangler.** Each tenant binds its host, its workflow and its step agents. The host
names its own binding in `hostBinding`, and a workflow's callbacks and steps reach it
through that key; left unnamed, the SDK would look for a binding matching the class
name.

`Env` here is your generated one, and every class constrains it to `CoreEnv` — `AI`,
the two A2A secrets, and the `ARTIFACTS` namespace from step 5.

### 4. Delegate, if your agent delegates

A sub-agent is a Think agent of its own — a `SubAgent` — dispatched through Think's
agent tools. Describe it as a `SubAgentSpec`, bind the spec to a class, and list the
class in `getSubAgents()`; core offers the model one tool per sub-agent.

```ts
import type { SubAgentSpec } from "@dynamicagents/core";
import { SubAgent } from "@dynamicagents/core/subagent";

const RESEARCH: SubAgentSpec<{ task: string }> = {
  name: "research",
  description: "Look something up and report back.",
  inputSchema: z.object({ task: z.string() }),
  soul: "You research one question thoroughly.",
  formatInput: ({ task }) => task
};

export class Researcher extends SubAgent<Env> {
  static override spec = RESEARCH;
  getModel() {
    return workersAIModel(this.env, { modelId: "@cf/zai-org/glm-5.2" });
  }
}
```

**Awaited or detached, nothing in between.** A Think turn lives inside one invocation
and is cut after at most fifteen minutes, and an awaited run in flight at the cut is
lost. So a sub-agent that may run longer declares `detached: true`: the call returns at
once, the job stays `working` while the run is open, and the run's result arrives as a
follow-up turn that answers the job. Every other sub-agent is awaited and finishes
inside the turn. A job settles on the turn that ends with no open work — no detached
run, no pending `check_back`.

`prepare` and `settle` bracket each run on the parent: acquire what the run needs and
no model can supply, and release it once, on every terminal.

### 5. Wire the artifacts binding — it is required

A sub-agent narrates itself: whatever it says before a tool call is a note for the
person following the task. A long run produces dozens. The notes are worth keeping —
they are the only account of what the run actually did — and a thread is the wrong
place to keep them.

`@dynamicagents/core/artifacts` is where they go instead. A note is posted as a link
and nothing else until one such post **reaches** the thread; every note after that is
recorded and not posted at all, and the link streams live and then ends with the
state the task settled in. The agent's own progress is untouched: its step text is the
conversation, not an account of one.

**Every agent binds `ARTIFACTS`**, and the wiring is a binding, a migration, an
export and the route delegation below. A Durable Object that starts without the
binding throws `ArtifactsNotBoundError` naming all of them — the delegation included,
because without it the object starts and every `/a/<token>` link falls through to
your own routes.

```jsonc
// wrangler.jsonc — the tag is the next one in your own migration sequence
"durable_objects": { "bindings": [{ "name": "ARTIFACTS", "class_name": "Artifacts" }] },
"migrations": [{ "tag": "v4", "new_sqlite_classes": ["Artifacts"] }]
```

```ts
import { Artifacts, handleArtifactRoute } from "@dynamicagents/core/artifacts";

export { Artifacts };

export default {
  async fetch(request: Request, env: Env) {
    return (await handleArtifactRoute(request, env)) ?? a2a(request, env);
  }
};
```

There is no unwired mode. A sub-agent's notes go on a transcript on
every path core owns, so "no binding" is not a second behaviour an agent can want —
it is a thread full of the notes the link exists to replace, arrived at by
forgetting a line. Requiring it makes the store a structural assumption core can
write against, instead of an `if` at every site that writes. The binding is on
`CoreEnv`, so a consumer `Env` missing it fails to typecheck, and `onStart` checks
it again at DO start for the `wrangler.jsonc` a type cannot see.

Two things still put the note in the thread instead of a link, and both are facts
about that note rather than about the wiring: this deployment has not learned its
own origin yet (it arrives with the first turn), or retention has already swept the
artifact. An ingest that **fails** is neither, and does not fall back to posting the
note: every note is persisted by the run that wrote it and replayed when the run
finishes, and the artifact's dedupe on the note's key records it once.

Posting is best-effort — `PushChannel.working` swallows a network failure and a
non-2xx, because a turn that cannot report its progress is still a turn that should
deliver its answer. So what ends the posting is a post that **landed**, and the
artifact records that: a link whose only POST was dropped is offered again on the
next note, rather than suppressed by a rule that knew nothing but which note came
first.

An artifact is a **kind**, a long random **token**, an append-only list of labelled
notes, a settle status, whether its link has been delivered, and whether it is
**locked** — refusing every note after the one somebody acted on. The token is id and authorization in one — derived from
nothing, so a link is the whole of what a reader needs and anyone holding one can
read it. `session-transcript` is the first kind and the object holds no code for
it; ingest is RPC over the binding and never a route, so a write is authenticated
by being inside the Worker. A note may carry **one image** beside its text — PNG
or JPEG, within `MAX_ARTIFACT_MEDIA_BYTES`, under a type checked against the bytes
rather than taken on the caller's word, and the text is then its alt text. The
bytes are fetched by URL from `/a/<token>/<sequence>`, so an image never rides a
read of the log, and SVG is refused rather than sanitized. Artifacts
age out on the same 30-day clock as the rest of a Task's state, swept lazily on
the next write rather than by an alarm apiece.

---

## Exports

Each area is its own subpath, so importing the contract does not drag in Think, and the
test harness cannot reach a production bundle.

| Subpath                            | What's in it                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@dynamicagents/core`              | the plugin contract (`definePlugin`, `restrictTools`, `SubAgentSpec`), env slices, `withAbort` |
| `@dynamicagents/core/task`         | `TaskHost`, the owner of a caller's A2A tasks, and `A2ACopy`                                   |
| `@dynamicagents/core/workflow`     | `TaskWorkflow` and its step helpers, the job and report types                                  |
| `@dynamicagents/core/agent`        | `StepAgent`, core's tools (`ask_user`, `check_back`, `search_history`)                         |
| `@dynamicagents/core/subagent`     | `SubAgent`, the child a `StepAgent` dispatches                                                 |
| `@dynamicagents/core/model`        | `workersAIModel`, `gatewayLogFields`                                                           |
| `@dynamicagents/core/a2a`          | card signing, JWKS, gatekeeper-JWT verify, push notify, task store, executor                   |
| `@dynamicagents/core/worker`       | `createA2AWorker()`, `defineAgent()` — the whole zero-trust edge                               |
| `@dynamicagents/core/alarm`        | many deadlines over one Durable Object alarm, for a plain `DurableObject`                      |
| `@dynamicagents/core/job`          | a long job a Durable Object drives through its alarm                                           |
| `@dynamicagents/core/artifacts`    | the `Artifacts` object, its routes and viewer, the transcript emission                         |
| `@dynamicagents/core/testing`      | VCR, scripted models, the A2A harness, DO helpers, fixtures — _workerd realm_                  |
| `@dynamicagents/core/testing/node` | the VCR recorder + cassette store — _Node realm, never import from a spec_                     |
| `@dynamicagents/core/eslint`       | the `no-deprecated-object-properties` rule                                                     |

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

Its `iss` is **not** something to configure. Inside a `StepAgent` it is:

```ts
getModel() {
  return myProvider(this.env, () => this.requireSelfOrigin());
}
```

`requireSelfOrigin()` (and `selfOrigin()`, which returns `undefined` instead of
throwing) answer with the origin core already delivers: the executor computes the
callback `jku` from `new URL(request.url).origin`, and it rides every accepted task
into its workflow, and every job into its step agent. A `SELF_ORIGIN` secret only restates that, and has to
be kept byte-identical with the verifier's allowlist by hand in every environment.

The first job an instance serves **pins** it, and nothing is persisted. Pinning is
what makes it safe to read: one object serves RPCs, queue items and its own turn
concurrently, and a credential thunk fires several frames below the code that set the
value, so a mutable field could hand one call another's origin. An agent has one endpoint anyway — the one
its card advertises and a verifier allowlists — and a fresh isolate on deploy re-learns
it.

It is known **once a job has arrived**: a constructor, and a scheduled callback on a
fresh instance, can run before anything has said what this deployment is called, and
`requireSelfOrigin()` throws there saying so. `onStart` re-learns it from the jobs an
evicted instance still holds open.

---

## Plugins

A capability is a plugin. Core never imports one — your agent installs it in
`getPlugins()`, which keeps bundle size proportional to what you actually installed.
The contract has Think's own shape: tools, actions and prompt blocks.

```ts
import { definePlugin } from "@dynamicagents/core";

export const scraper = (config: { apiKey: string }) =>
  definePlugin({
    name: "scraper",
    tools: (ctx) => ({ fetch_page: fetchPageTool(config, ctx) }),
    context: [
      {
        provider: { get: async () => "You can fetch a page and summarize it." }
      }
    ],
    requires: { secrets: ["SCRAPER_API_KEY"] }
  });
```

`tools` is synchronous, because Think's `getTools()` is. `actions` are Think actions:
tools with an idempotency ledger, so a recovered turn never repeats a side effect. A
plugin's blocks are namespaced under its name. A plugin that describes a sub-agent
exports its `SubAgentSpec` as data; the agent binds it to a class.

The agent assembles its plugins at DO start — never mid-request — and fails on a
duplicate plugin name, a missing declared binding, or a `PLUGIN_CONTRACT_VERSION`
mismatch; two plugins offering one tool fail the first turn. Because core, plugins,
and starter publish from separate repos, one of them is always briefly behind; the
version assert turns the skew into a readable sentence instead of a structural-type
error several frames from its cause.

`restrictTools(plugin, { allow })` narrows what an agent takes from a plugin — "my
sub-agents can run a shell, I cannot" — while the plugin's `requires` still holds.

---

## Testing

The harness both predecessor agents grew, shipped so you don't grow it a third time.

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

- **Fakes** — scripted streaming models, so a Think turn runs with no model call at
  all. `scriptedModel(rule)` answers each call from the message that started the turn,
  which is the shape that survives a task spanning several turns; `mockModel(...steps)`
  plays a fixed sequence.
- **Fixtures** — Ed25519 keypairs and a gatekeeper-JWT signer, so the zero-trust path is
  exercisable end to end without a real gatekeeper.
- **`createAgentHarness`** — the assembly of all of the above: send one A2A turn the
  way a gatekeeper does, and capture what comes back.

  ```ts
  const harness = createAgentHarness({ worker, env, tenant: "generic" });
  using _ = harness.interceptGatekeeper();

  const accepted = await harness.send("what's the weather?");
  const done = await harness.waitForTerminal(accepted.id);
  expect(done.state).toBe("TASK_STATE_COMPLETED");
  ```

  The task runs in its workflow after the accept returns, so a spec waits for its
  effect: `waitForState` and `waitForTerminal` watch the callbacks the host posts. Give
  each spec its own `identity` and it gets its own host and step agents.

  It exists because the pieces above were never the hard part. The audience is the
  **endpoint**, not the origin; the tenant claim has to match the tenant in the
  body; `SendMessage` is refused without a push config; and the gatekeeper's JWKS has
  to be reachable or every spec below it reports a 401 about something else. Four
  facts, wrong the first time in every consumer that wrote this by hand.

---

## What core deliberately does _not_ contain

- **Prompt copy of any kind.** Not a soul, not a user-facing failure message: the
  host's `copy` is abstract, because a run must never execute under an identity
  nobody chose.
- **A loop.** Think runs the turn. Core adds the task host, the workflow and the step
  job around it.
- **Numbers.** Model ids, compaction thresholds, output ceilings are the agent's.
  There are no budgets: the gatekeeper cancels a task that has not settled within the
  hour.
- **A model fallback.** A transient failure is retried by the AI SDK and an
  interrupted turn is continued by Think's recovery.
- Browser tools, shell, a workspace backend. All optional → plugins.

---

## Requirements

- **Node** ≥ 24 (for build and test only — the package itself runs on workerd)
- **Bindings:** `AI`, per tenant a task host, its workflow and its step agents,
  `ARTIFACTS`
- **Secrets:** `A2A_SIGNING_KEY`, `GATEKEEPER_ORIGINS`
- **Peers, never bundled:** `@cloudflare/think`, `agents`, `ai`, `workers-ai-provider`

That last point is not stylistic: two copies of `agents` in one Worker breaks the
`Session` / `SessionMessage` types and every `instanceof`. For local development
across the three repos use `file:` overrides, or `npm pack` plus a tarball install —
**not `npm link`**, which duplicates peer dependencies.

---

## Contributing

[`AGENTS.md`](./AGENTS.md) documents the constraints this package is guardian of.

```bash
npm run check           # peer ranges + runtime types + prettier + eslint + tsc (src) + tsc (test) + build
npm test                # vitest, inside real workerd
npm run verify:exports  # the publish gate: subpaths, ESM specifiers, realm isolation
```

## License

[Apache-2.0](./LICENSE).
