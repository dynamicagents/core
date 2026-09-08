# AGENTS.md — working in `@dynamicagents/core`

This package is the mandatory floor under every Dynamic Agent. It is
consumed by [`plugins`](https://github.com/dynamicagents/plugins) (optional,
composable capabilities) and
[`starter`](https://github.com/dynamicagents/starter) (the app that composes
them).

Because this is a **published npm package**, most mistakes are invisible in this
repo and only fail at a consumer's build. The constraints below exist for that
reason.

---

## The zero-trust constraints — non-negotiable

These arrived byte-identical from two independently-evolved predecessor agents.
They are the reason this package exists.

1. **Never weaken `src/a2a/verify.ts`.** The four checks — `jku` present → origin
   allowlist → `iss` origin equals `jku` origin → `jwtVerify` pinned to EdDSA —
   are the whole contract. Do not make any of them optional, do not reorder the
   allowlist check after the JWKS fetch, and **do not add a local-development
   bypass**; run a local gatekeeper instead. `verify.spec.ts` asserts each one
   negatively, including that an unlisted `jku` is rejected before any fetch.

2. **EdDSA (Ed25519) only.** Both the gatekeeper JWT and the AgentCard signature.
   Any other algorithm is rejected.

3. **Zero shared secrets, in either direction.** The agent verifies the gatekeeper
   against the gatekeeper's public JWKS; the gatekeeper verifies the agent against the
   agent's, pinned on first registration (Trust-On-First-Use). Nothing symmetric
   ever crosses the boundary. The only two secrets an agent carries are
   `A2A_SIGNING_KEY` (its own private JWK) and `GATEKEEPER_ORIGINS`.

4. **`GATEKEEPER_ORIGINS` is the allowlist boundary.** Normalized to exact origins,
   never matched by suffix or pattern. An empty or unparseable value fails loudly
   rather than degrading to an allowlist that rejects everything identically.

5. **The served AgentCard is a fixed point under repeated `fromJSON`.** A
   verifier re-encodes what it fetched before checking the signature, so a
   document that decodes differently the second time fails in production while
   every local round-trip looks fine. `card.spec.ts` pins this.

Generate a keypair with `npm run keys`.

---

## Publishing constraints

The package has no root barrel; every area is its own subpath export. Four rules
follow from that, and all four have already been violated once:

- **Always write `.js` on relative imports.** `moduleResolution: "Bundler"`
  typechecks extensionless specifiers, but `tsc` emits them verbatim and Node ESM
  then throws `ERR_MODULE_NOT_FOUND` at the consumer.

- **Never mix realms in one module graph.** `@dynamicagents/core/testing` is the
  workerd half (may reach `cloudflare:test`); `@dynamicagents/core/testing/node` and
  `/testing/vcr-global-setup` are the Node half (may reach `node:fs`).
  `src/testing/vcr-shared.ts` is the only module both may load, and it must stay
  dependency-free. **No runtime subpath may reach any of them.**

  Specs follow the same split: `*.spec.ts` runs inside workerd, `*.node.spec.ts`
  runs in Node. `vitest.config.ts` is two projects for that reason.

- **Never name a consumer's ambient `Env`.** Core declares its own env slices in
  `src/env.ts` and takes bindings as parameters. The one exception is the
  namespaced `Cloudflare.Env`, which is a declaration-merging seam the Agents SDK
  itself constrains its base class to — see the note in `tsconfig.json`.

- **Never import a package this one does not declare.** npm hoists a transitive
  dependency into a flat `node_modules`, so an undeclared import resolves here
  and nowhere stricter — pnpm and Yarn PnP both refuse it, and so does npm the
  moment the intermediate package restructures. Two imports once reached a
  published subpath this way: `@ai-sdk/provider` into `/testing` (through `ai`'s
  copy) and `@typescript-eslint/utils` into `/eslint` (through
  `typescript-eslint`). Both were fixed, and between them they show the two
  remedies available. Prefer the re-export from a package already declared —
  `APICallError` comes from `ai` now, which is why `@ai-sdk/provider` is not a
  dependency here at all any more — and where the import is genuinely needed,
  declare it as an **optional peer**, as `/eslint` does. `verify:exports` fails
  on this.

Adding an export subpath means adding it to `package.json`'s `exports` **and**
confirming it emits: a subpath that resolves to a missing file is invisible until
someone imports it.

---

## Contract changes

`PLUGIN_CONTRACT_VERSION` in `src/contract/plugin.ts` is asserted at DO start, so
a plugin built against a different core fails with a readable message instead of
a structural-type error several frames away.

The contract is **additive-only within a major**: new capabilities arrive as
optional fields on `AgentPlugin`. Removing or re-typing an existing field needs a
core major and a version bump. Remember that a contract change is a three-repo
publish train (core → plugins → starter), so one repo is always briefly behind.

> **v1 was amended in 0.1.2, before its first consumer.** `shouldHandleTurn` and
> `workspaceBacking` were added and `mainAgentTools` was re-typed from
> `() => ToolSet` to `(ctx) => ToolSet | Promise<ToolSet>`. The re-type would
> normally require the bump above; it was skipped deliberately, because that rule
> exists to stop a _published_ plugin failing with a structural-type error several
> frames from its cause, and at 0.1.2 no plugin had been published against v1.
> This is the one such amendment. Treat v1 as frozen from here.

`FINGERPRINT_VERSION` in `src/subagent/fingerprint.ts` works the same way and is
even sharper: bumping it invalidates every cached subagent result and every
in-flight run's checkpoint. Note that recipe limits are hashed **as declared, not
as merged** — that is deliberate, so moving a baseline default in a patch release
cannot strand in-flight runs.

### The migration journal

`src/db/schema.ts` holds core's three tables and **only** core's — the journal is
a flat integer sequence over one shared `__drizzle_migrations` table, and two
independently-versioned packages writing to it will collide. A plugin owns its
tables through `PluginStore`.

Changing the schema means `npm run db:generate`, which runs `drizzle-kit generate`
and then rebuilds `src/db/migrations/index.ts` from the `.sql` files. That index is
generated — never hand-edit it. Rename the generated `.sql` to say what it does and
fix its `tag` in `meta/_journal.json` before rebuilding, so the journal reads as
intent rather than as drizzle's word generator.

---

## The platform bounds

`src/platform.ts` holds time and step limits, and the one thing to know before
touching it is that **`STEP_TIMEOUT_MS` is not a platform fact.** Ten minutes is
Workflows' _default_ step timeout, not its ceiling; core passes its own on every
step that can hold a model call or a container command. Both sites are in
`round/workflow.ts`: `CHUNK_STEP` carries `STEP_TIMEOUT_MS` for the chunk steps,
and `turnStep(config)` widens it to `max(mainAgentLimits.maxWallMs,
STEP_TIMEOUT_MS)` for a round — a round has no soft deadline, so what bounds it
is its turn count, not a chunk boundary. Wall-clock per step is effectively
unlimited — a step is bounded by CPU, and the chunk steps use milliseconds of
it — so the value is a ceiling we choose, to turn a hung container into a retry
rather than a task that never ends.

`CHUNK_SOFT_MS` is sized against it, and the sizing is the part that bit us. The
soft deadline is checked **between turns**, so a turn already in flight when it
trips still runs to completion, and a turn is a model call plus a tool call. The
headroom therefore has to cover a whole turn — `MAX_TOOL_CALL_MS` plus room for
the model — not a nominal minute. `platform.spec.ts` asserts that relationship;
raise the step timeout before raising the chunk deadline.

`MAX_TOOL_CALL_MS` is a **contract, not a mechanism** — core installs no tools,
so it cannot enforce it. A host that installs something which can block (a shell,
a container command, a fetch with no ceiling) must bound it at or below that
value, or it reintroduces the step-timeout kill invisibly, from inside a plugin.

---

## The line core does not cross

The old rule was "core ships no loop." That was the right instinct at the wrong
granularity, and 0.4.0 sharpens it: **core ships no prompt copy and no policy.**

`@dynamicagents/core/round` now ships the whole delegating loop — concurrent subtask
execution, chunked subagent runs, cancellation ordering, the
primary→fallback→repair ladder. Keeping that out of core did not make agents more
expressive; it made every consumer fork ~2,700 lines of durable-execution logic
they could not receive fixes for. The starter's own two agents, written against a
documented invariant by people who knew it, still drifted apart: the second copy
discarded `markWorking`'s cancellation verdict and probed with `getTask` before
writing a terminal Task, so a canceled task burned a model call and could still
produce a `completed` callback.

What is genuinely per-agent is now explicit and mandatory:

- **`RoundPolicy`** — the round contract, a note per reason a round can be forced
  to answer, and the three user-facing strings. Nothing has a default. A lent-out
  round contract is exactly the house prompt copy `validateRecipe` already refuses
  for a subagent soul.
- **The loop itself, if you want a different one.** `/round` is opt-in and its own
  subpath. An agent whose turn is a single inference extends `DynamicAgent` from
  `/host`, writes its own loop, and carries none of the delegation machinery.

So when adding to `/round` or `/host`, the test is not "does an agent vary here"
but "**could an agent vary here and still be correct**". A cancellation ordering
cannot. A sentence the model reads always can.

Two consequences for exports:

- `/round` must **never** be re-exported from the root barrel, or a non-delegating
  agent pays for a delegating loop it never runs. `verify:isolation` in the starter
  asserts the proactive agent's graph is free of `core/dist/round/`.
- `/host` is separate from `/agent` for the same reason: `/agent` is loop
  primitives, and a loop module should not drag a Durable Object base class and
  drizzle into its graph.

### Model providers

A provider is a **sibling directory under `src/agent/`** exporting one
`ModelRuntimeFactory`. `src/agent/model.ts` is the contract and holds no
implementation — the Workers AI factory used to live in it, and a contract that
ships one implementation inline reads as _the_ runtime with an escape hatch
rather than as one of N. `src/agent/errors.ts` is its neutral companion: a
rejected credential is a fact about the path to a model, not about any vendor.

Three rules follow, and they are what keep a third provider cheap:

- **Nothing neutral may import a provider directory.** `inference.ts` classifies
  a dead credential by `CredentialRejectedError`, which is structurally matched,
  so a provider written _outside_ core raises one and gets the same
  fallback-skipping treatment with nothing in core to change.
- **A subpath only when the peer is optional.** `workers-ai` has none because
  `workers-ai-provider` is a required peer and every consumer's graph holds it
  already. A provider behind an _optional_ peer gets its own subpath instead, so
  an agent never calling it does not pay for it — and **no runtime subpath may
  import such a subpath.** `/anthropic` was the one worked example until 0.8.0,
  when it was removed with the only deployment that used it.
- **`DynamicAgent.modelRuntime` and `RecipeSubagentHost.modelRuntime` are
  overridden together.** They take identical arguments so one factory can serve
  both. A facet left on the default while its parent runs elsewhere executes
  every delegated subtask on a different model than the round that delegated it,
  and does so silently, because both satisfy `ModelRuntime`. Overriding neither
  is the cheapest way to satisfy this, and what an agent on the default does.

Everything deployment-specific stays out, as everywhere else here: which AI
Gateway path, which credential, and how to classify a `401` are the agent's to
supply, from its own `ModelRuntime`. Core recognised one particular
intermediary's error body once; that is the shape of mistake this section exists
to prevent. Two things went in 0.8.0 for the same reason, once the deployment
that needed them was gone: `ModelConfig.aiGatewayProvider`, which core never
read, and the `"proxy"` arm of `CredentialRejectedBy`, which no provider core
ships could raise.

---

## Package Bumping

Read the changelog for every **non-patch bump** — any minor or any major. The
reason is not only compatibility: a minor often carries a new API that
simplifies a pattern already written here, and a major sometimes requires one.
A bump that typechecks and passes tests can still leave the better shape on the
table, so the changelog is where the refactor opportunity is found, not the
build.

Two dependencies are exempt:

- **wrangler** — minors go in without a changelog read. Run `npm run types` and
  commit the regenerated `worker-configuration.d.ts`: a wrangler bump moves the
  bundled workerd, so the committed runtime types go stale and `npm run check`
  fails on its `types:check` step until they are refreshed. That is the point —
  new platform types land in front of the typechecker rather than in front of a
  consumer.
- **eslint** — goes in without a deep changelog read.

Verify with `npm run check`, preceded by `npm run types` when wrangler moved.
Run `npm test` as well: `check` catches the type and lint fallout of a bump,
and only the suite catches a behavioural one.

---

## Working here

```bash
npm run check     # types:check + prettier + eslint + tsc (src) + tsc (test) + build
npm test          # vitest, inside real workerd
npm run keys      # generate an Ed25519 A2A_SIGNING_KEY
npm run types     # regenerate worker-configuration.d.ts, then commit it
```

`worker-configuration.d.ts` is generated but **committed**: it is an input to
`tsc` and to eslint's type-aware pass, so a fresh clone must be able to
typecheck without running a script first. `npm run types:check` — the first step
of `check` — fails when the committed copy drifts from `wrangler.jsonc` or the
installed workerd, and `scripts/verify-runtime-types.mjs` fails when it was
regenerated without `--include-env=false` and so carries a global `Env`.

Specs live next to the code they test (`src/**/*.spec.ts`) and run inside
workerd, because `AgentDB` drives `ctx.storage.sql` and the Agents SDK `Session`
has no Node-side stand-in. `wrangler.jsonc` and `test/worker.ts` exist only to
give the plugin something to bind — they are dev-only and excluded from the
published tarball.

Two things `npm test` alone will not catch, so run `npm run check` before
pushing: vitest transpiles specs without typechecking them, and formatting and
the type-aware `no-deprecated` rule only run under `check`.

---

## Comments

This repo comments heavily, and that is deliberate: a lot of what is here was
expensive to learn and invisible in the code. The cost is that comments rot, so
they are held to the same bar as the code.

A comment states a **constraint, a measurement, or a coupling** — something that
changes a decision. Not what changed, not when, not what a previous version said;
`git log` owns that. In particular:

- **No changelog.** "This used to…", "removed in 0.8.2", "the design plan called
  for…", "this is not a reversal of…" are all history. Write the rule that
  survives it. A measurement is worth keeping; the date it was taken is not.
- **No package versions or dates** in prose. They are stale on the next bump and
  nothing checks them.
- **One home per fact.** Put the explanation in the file somebody edits when they
  change that behaviour, and a pointer everywhere else — core's comments have
  `{@link file://../path/to.ts Name}` for exactly this. Four copies of the same
  paragraph in four files do not stay in step: they diverge, and then the reader
  cannot tell which one is current.
- **No counts.** "the three tables", "the four values below", module counts, spec
  counts. Every one of these was wrong within a release. Name the thing, not how
  many there are.
- **Cross-file references name a real path**, and a path in a comment is
  checkable — so check it before you write it. Nothing in `check` verifies these
  for you here.

If a comment is longer than the code it explains, ask what decision it is
protecting. Usually one paragraph of that is doing the work.

---

## The VCR harness

Core publishes it, so core must run it. It shipped broken once — installed as
Miniflare's `fetchMock`, an option `@cloudflare/vitest-pool-workers` 0.20 had
removed — and nothing here noticed, because core had no recorded spec of its own.
An unknown key in the `miniflare` options is _ignored_, not rejected, so every
request escaped to the real network and died as `internal error; reference = …`,
naming nothing. It surfaced in a consumer.

Four rules follow, and the specs pin all of them:

- **The recorder is an `outboundService`, never `fetchMock`.** That is the hook
  `fetchMock` was one line of sugar over (`outboundService = (req) => fetch(req,
{ dispatcher: fetchMock })`), it is identical in Miniflare 4 and 5, and it has
  no `instanceof` check in either direction — which is why the plugin peer is
  left open and why core declares no `undici` at all. Do not reintroduce either
  pin. `setupRecording()` proves the recorder answered before any test runs, so
  the silent-no-op failure cannot recur.

- **Cassettes match on method + URL + body. Never on headers.** undici's
  `SnapshotAgent` hashed every non-excluded request header, so a cassette carried
  `cf-worker` and `user-agent: undici` in its key and stopped matching the moment
  miniflare or workerd changed what it sent. That made every committed cassette
  version-locked and is half the reason the pool could not be bumped.

- **Playback writes nothing.** `SnapshotAgent` re-saved on close, persisting the
  `callCount` it mutated on every replay, so a plain `npm test` left committed
  cassettes dirty in git. The sequence counter is in memory now; if `git status`
  is ever dirty after a playback run, that regressed.

- **The on-disk format owes `SnapshotAgent` nothing**, and there is no reader for
  what it wrote. That is a deliberate cut, not an oversight: its recorder keyed on
  `String(opts.body)`, and a Worker's POST body reaches a dispatcher as a
  `ReadableStream`, so every streamed request it captured stored the literal text
  `[object ReadableStream]` where the payload belonged. Those bodies are
  unrecoverable, so any reader for them would have to match such entries on
  method + URL alone — reintroducing exactly the ambiguity the second rule above
  removes. A cassette from before core 0.3.1 gets re-recorded, not migrated.

A cassette is a flat array of `{ request, responses }`. Two entries that key the
same are rejected on load rather than merged, because a request issued twice
belongs in one entry with two `responses` — merging would let a hand-edit slip
serve the wrong response on the second call, silently.

Cassettes under `test/snapshots/` are hand-written and committed, so core needs
no credentials and no network to test its own harness.

> **0.3.1 carries a breaking change, deliberately.** Dropping the reader would
> normally be a minor bump on 0.x. It was skipped for the same reason the v1
> amendment above was: 0.3.0 had been published hours earlier and nothing
> resolved it — both consumers were still on `^0.2.0` — so 0.3.0 and 0.3.1 are
> one change that happened to cross a publish. Treat the format as frozen from
> here; the next one that breaks it takes a minor.
