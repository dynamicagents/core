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

**Development lands on `main`, and a release is a PR that bumps the version.** npm is
the released line, not a branch: a merge without a bump ships nothing, so changes
batch on `main` until someone decides to release them, and a bump is a deliberate act
rather than something that rides every merge.

A version bump reaching `main` is what ships it: on the first green Test run for
a commit carrying that version, `.github/workflows/release.yml` publishes it to
npm over OIDC and only then cuts the tag. The bump is the decision to ship, and `prepack` and
`prepublishOnly` are the last gate a tarball passes before it is immutable on the
registry. The workflow comments hold the rest.

The release gate reads the **registry**, not the commit log — it asks whether
`name@version` is already published — so a merge of many commits and one bump
publishes once, and a merge with no bump does nothing. That is what makes batching a
release safe.

`prepare` runs `build`, which is what lets a consumer depend on this package by git
ref while it is still unreleased: `dist/` is not committed, and npm runs `prepare`
when installing a git dependency. `husky || true` because husky exits non-zero
outside a git checkout, which is exactly the consumer-install case.

The root carries only the plugin contract; every other area is its own subpath
export. Four rules follow from that, and all four have already been violated once:

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
  `/testing` takes the mock model from `ai/test` rather than `@ai-sdk/provider`
  — and where the import is genuinely needed, declare it as an **optional
  peer**, as `/eslint` does. `verify:exports` fails on this.

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

> **A contract version no plugin has been published against can still change
> without a bump.** The bump exists to stop a _published_ plugin failing with a
> structural-type error several frames from its cause; until one exists, there is
> nothing for it to protect. Check the registry, not `main`, before deciding.

---

## The line core does not cross

**Core owns the A2A↔Think lifecycle, and ships no prompt copy and no numbers.**

Think runs the turn — the loop, recovery, compaction, agent tools, actions.
Core wraps it in the A2A task: the guarded ledger (`src/think/tasks.ts`), the mapping
from a turn's outcome to a task state, the durable delivery outbox, cancellation
fan-out, and a task that outlives its turn through open work. Every one of those
is an ordering an agent cannot vary and still be correct: a cancel decided by a probe
instead of the guarded write's verdict is a canceled task that still calls back
`completed`.

What is genuinely per-agent is explicit and mandatory:

- **The words.** `A2AAgent.copy` (the failed, empty and expired messages), the soul,
  every block the model reads. Nothing has a default.
- **The numbers.** The model, compaction thresholds, an output ceiling. Core sets no
  budget at all: the gatekeeper cancels a task that has not settled within the hour,
  so a ceiling below that is arbitrary, and one above it is never reached.

So when adding to `/think`, the test is not "does an agent vary here" but "**could an
agent vary here and still be correct**". A cancellation ordering cannot. A sentence
the model reads always can.

**Build on Think's primitives in a shape Think could absorb.** Where core is ahead of
Think — a task spanning turns, the A2A edge — it is written on Think's own hooks
(`onSubmissionStatus`, `runAgentTool`'s `onFinish`, `schedule`, `queue`) rather than
around them, and named the way Think names things, so the day Think grows the same
feature the port is a deletion.

### Model providers

A provider is a function returning one `LanguageModel` for `getModel()`.
`workersAIModel` in `src/model/` is the one core ships. There is no fallback model:
a transient failure is retried by the AI SDK (`maxRetries`, which `beforeTurn` can
tune) and an interrupted turn is continued by Think's chat recovery.

Everything deployment-specific stays out: which AI Gateway, which credential, how to
classify an error beyond the context-overflow classifier. Those are the agent's.

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

A bump also moves what the peer ranges describe, and a peer range is the one
field in `package.json` that nothing else reads — npm resolves the root's peers
for _consumers_ and never turns them back on the root, so a range and the
devDependency beside it drift apart with a green build the whole way.
`npm run verify:peer-ranges` is in `check` for that. Its `--latest` mode is run
by hand, since `check` has no network, and reports the two ways a range and
reality come apart: a published release the range excludes, and a published
release the range admits that nothing here has ever run.

**Bound a peer ceiling only where the package has actually been breaking.** Open
is the default — the vitest plugin peer under _The VCR harness_ is the worked
example, and it says why. `agents` and `@cloudflare/think` have ceilings because both
have broken across most of their recent minors and core is coupled to them about
as deeply as a consumer can be — Think's base class and hooks, `Agent`, `Session`,
and the experimental subpaths. That ceiling is not a number anyone has to remember to revisit:
`--latest` reports when a release lands outside it, so widening it becomes a
deliberate act after a green suite rather than a guess made in advance.

---

## Working here

```bash
npm run check     # peer ranges + types:check + prettier + eslint + tsc x2 + build
npm test          # vitest, inside real workerd
npm run keys      # generate an Ed25519 A2A_SIGNING_KEY
npm run types     # regenerate worker-configuration.d.ts, then commit it
```

`worker-configuration.d.ts` is generated but **committed**: it is an input to
`tsc` and to eslint's type-aware pass, so a fresh clone must be able to
typecheck without running a script first. `npm run types:check` — part of
`check` — fails when the committed copy drifts from `wrangler.jsonc` or the
installed workerd, and `scripts/verify-runtime-types.mjs` fails when it was
regenerated without `--include-env=false` and so carries a global `Env`.

Specs live next to the code they test (`src/**/*.spec.ts`) and run inside
workerd, because a Think agent drives `ctx.storage.sql`, alarms and facets, none
of which have a Node-side stand-in. `wrangler.jsonc` and `test/worker.ts` exist
only to give the pool something to bind — they are dev-only and excluded from the
published tarball. `src/think/agent.spec.ts` drives every lifecycle scenario
through the real A2A edge and asserts on the push callbacks.

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
