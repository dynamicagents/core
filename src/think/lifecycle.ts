/**
 * Start Think's lifecycle before a raw Durable Object RPC touches anything.
 *
 * **A native RPC does not start it.** `this.session` — and the submission ledger
 * under it — does not exist until something does, and Think's own entry points
 * (`fetch`, the chat WebSocket, the agent-tool adapter) all call the internal
 * `__unsafe_ensureInitialized()` first. A method core's executor or task store
 * calls lands on the object without any of them having run, so it has to do the
 * same thing.
 *
 * It is here rather than inlined at each call site so the internal name has one
 * home: the underscore prefix is the SDK saying it may move, and when it does,
 * this is the file that changes.
 */

/** The internal entry point, narrowed off the agent rather than cast at each use. */
interface Initializable {
  __unsafe_ensureInitialized(): Promise<void>;
}

export async function ensureStarted(agent: Initializable): Promise<void> {
  await agent.__unsafe_ensureInitialized();
}
