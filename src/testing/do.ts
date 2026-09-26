/**
 * Durable Object test helpers. A consumer binds their namespace once.
 */

export interface DoTestHelpers<T extends Rpc.DurableObjectBranded | undefined> {
  /** Fresh, unique DO stub per test — state never leaks between tests. */
  freshStub(label: string): DurableObjectStub<T>;
}

/**
 * `ctx` is protected in the DO type system but public at runtime. Cast once so
 * callers don't repeat the assertion.
 */
export function doStorage(instance: unknown): DurableObjectStorage {
  return (instance as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

/**
 * Bind the helpers to a consumer's DO namespace.
 *
 * ```ts
 * const { freshStub } = makeDoHelpers(env.MyAgent);
 * ```
 */
export function makeDoHelpers<
  T extends Rpc.DurableObjectBranded | undefined = undefined
>(ns: DurableObjectNamespace<T>): DoTestHelpers<T> {
  return {
    freshStub: (label: string) =>
      ns.get(ns.idFromName(`test:${label}:${crypto.randomUUID()}`))
  };
}
