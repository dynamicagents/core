/**
 * `@dynamicagents/core/host` — the Durable Object half of an agent.
 *
 * {@link DynamicAgent} is the DO body every Dynamic Agent has whatever loop it
 * runs: the runtime and database built once per instance, the one continuous
 * Session per verified caller, the gatekeeper callback channel, and the task
 * lifecycle RPC surface a Workflow drives. {@link PluginHost} is what it hands
 * the plugins.
 *
 * Its own subpath rather than part of `/agent` on purpose. `/agent` is the
 * primitives a *loop* is built from — session, model pair, budget, control tools
 * — and a loop module should be able to import those without pulling a Durable
 * Object base class and drizzle into its graph.
 *
 * Core still ships **no loop and no prompt copy**. Nothing here decides how a
 * turn is shaped or what ends it; see `@dynamicagents/core/round` for the delegating
 * round loop, which is opt-in and takes its prompt copy from the agent.
 */

export { DynamicAgent } from "./agent.js";
export type { PluginHost } from "./plugin-host.js";
