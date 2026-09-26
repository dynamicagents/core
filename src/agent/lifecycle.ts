/**
 * Start Think's lifecycle from a raw Durable Object RPC.
 *
 * A native RPC lands on the object without the lifecycle having started, so
 * `this.session` — and the submission ledger under it — does not exist yet.
 * Every RPC entry point core calls starts it first, the way Think's own entry
 * points do. The method is internal to agents, so its name has this one home.
 */
export async function ensureStarted(agent: {
  __unsafe_ensureInitialized(): Promise<void>;
}): Promise<void> {
  await agent.__unsafe_ensureInitialized();
}
