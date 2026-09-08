/**
 * `@dynamicagents/core/alarm` — many deadlines over a Durable Object's one alarm.
 *
 * A Durable Object has exactly **one** alarm, and an object that needs to wake
 * for more than one reason cannot simply call `setAlarm` from each of them: the
 * last writer silently wins, and whatever the loser was waiting on never
 * happens. This module is the fix, and it is now a thin assembly over the
 * `agents` SDK rather than an implementation of its own.
 *
 * **Why this stopped being hand-rolled.** The predecessor kept every pending
 * deadline in one storage row and was the only thing in the object that called
 * `setAlarm`. It existed because the SDK sold the same mechanism only as a
 * method on `Agent`, so adopting it meant the object *became* an `Agent` —
 * `cf_agents_state`, `cf_agents_mcp_servers` and `cf_agents_queues` in its
 * SQLite, an `MCPClientManager`, and prototype-patching of every public method.
 * That objection was correct when it was written and no longer holds: the SDK
 * split the machinery apart, so a `Lifecycle` installs on a **plain**
 * `DurableObject` and a `Scheduler` is one capability composed onto it.
 *
 * What that buys, beyond the deletion: retries with backoff, cron and interval
 * schedules, a hung-callback timeout, and per-schedule rows instead of one
 * shared blob. What it costs is named under "The two sharp edges" below and in
 * {@link installScheduler} — this is not a drop-in for a keyed map.
 *
 * **Its own subpath, still deliberately, but the claim is weaker now.** This is
 * useful to a plain `DurableObject`, not only to a {@link DynamicAgent}. It no
 * longer imports *nothing*, though: it pulls `agents`. That is far smaller than
 * the whole `Agent` base class, and it is not zero.
 *
 * **Experimental, and that reaches consumers.** Every type in `agents/schedules`
 * carries "The API surface may change before stabilizing", the same caveat this
 * package already accepts for `agents/experimental/memory/*`. The difference is
 * that `/alarm` is a published subpath, so the churn is inherited rather than
 * absorbed. Keeping the assembly here is what makes that one file's problem.
 *
 * ## The two sharp edges
 *
 * **1. A host that defines its own handlers is skipped in silence.**
 * `Lifecycle.installHandlers()` only defines `fetch`, `alarm` and the WebSocket
 * handlers that the host does not already have — by design, so a framework can
 * keep its own dispatch. An object that overrides `alarm()` therefore installs
 * a `Scheduler` that never fires, with no error anywhere. {@link
 * installScheduler} turns that into a throw at construction: a host with its own
 * handler must list it in `delegates` and call through.
 *
 * **2. There is no "move this deadline".** The predecessor's `set` was an upsert
 * on a caller-chosen key, so pushing a deadline later was one call. A schedule
 * is a row with an id, and rescheduling means {@link Scheduler.cancel} then
 * {@link Scheduler.set}. One-shot schedules are also **not** idempotent by
 * default, so calling `set` again makes a *second* row rather than replacing the
 * first — which on a hot path is how an object ends up with thousands of them.
 * Hold the id and cancel it; do not schedule twice and hope.
 *
 * **3. A bare number is a delay in seconds, not a moment.** `set(when)` reads a
 * `Date` as an instant, a string as a cron expression, and a **number as a delay
 * in seconds**. A Durable Object's own currency is epoch milliseconds — what
 * `Date.now()` and `storage.setAlarm()` both speak — so passing one straight
 * through schedules roughly fifty thousand years out, and nothing rejects it.
 * Cross every deadline as a `Date`.
 *
 * This owns *when* an object wakes. What it owes on waking is the object's own,
 * and now says so by name: a callback is registered under a name in
 * {@link SchedulerOptions.callbacks}, and the payload is typed against it.
 */
// The class from `cloudflare:workers`, not the ambient global of the same name:
// the global is a non-generic interface describing the runtime's handler shape,
// while a lifecycle installs on the *class* and is generic in `Env`.
import type { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import {
  Scheduler,
  type SchedulerCallbacks,
  type SchedulerHandlers,
  type SchedulerOptions
} from "agents/schedules";

export type {
  Schedule,
  ScheduleCriteria,
  ScheduleOptions,
  SchedulerCallbacks,
  SchedulerEventType,
  SchedulerHandlers,
  SchedulerOptions,
  SchedulerPayload
} from "agents/schedules";
export { Scheduler } from "agents/schedules";

/**
 * The runtime entry points a {@link Lifecycle} wants to own.
 *
 * Spelled out rather than inferred because the whole point is to compare this
 * list against what the host already defines, and an inferred one would shrink
 * silently if the SDK stopped installing something.
 */
export const HOST_HANDLERS = [
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError"
] as const;

/** One of the runtime entry points a host and a `Lifecycle` can both want. */
export type HostHandler = (typeof HOST_HANDLERS)[number];

export interface InstallSchedulerOptions<
  H extends SchedulerHandlers
> extends SchedulerOptions<H> {
  /**
   * Handlers this host defines itself and **promises to delegate**.
   *
   * Required for anything the host already has, because `installHandlers()`
   * skips those without saying so. Listing one is the acknowledgement that the
   * host's own implementation calls the matching method on the returned
   * {@link ScheduledHost} — most importantly `alarm()`, which is the only one
   * scheduling cannot work without.
   */
  readonly delegates?: readonly HostHandler[];
}

/**
 * A `Scheduler` and the `Lifecycle` carrying it, bound to one Durable Object.
 *
 * The delegation targets are methods here rather than on the lifecycle so a host
 * has one object to hold and one name to call, and so this module can keep the
 * SDK's shape from reaching the host directly.
 */
export interface ScheduledHost<
  H extends SchedulerHandlers,
  Env extends object = Cloudflare.Env
> {
  /** Set, list and cancel schedules. The reason this object exists. */
  readonly scheduler: Scheduler<H>;
  /** The escape hatch, for capabilities this assembly does not wrap. */
  readonly lifecycle: Lifecycle<Env>;
  /**
   * Start the lifecycle and its capabilities.
   *
   * The runtime entry points do this themselves, so a host that is reached
   * through `fetch` never needs it. An **RPC-only** host does: native RPC
   * bypasses `fetch` entirely, so without an explicit call the `Scheduler`'s
   * storage is never migrated and the first `set` runs against nothing.
   */
  start(): Promise<void>;
  /** Delegation target for a host that declares `"alarm"`. */
  alarm(): Promise<void>;
  /** Delegation target for a host that declares `"fetch"`. */
  fetch(request: Request): Promise<Response>;
  /**
   * Recompute the physical alarm from every capability.
   *
   * For the one failure a scheduler cannot see from the inside: the runtime
   * retries a throwing `alarm()` a bounded number of times and then stops for
   * good, and a deleted-class migration takes the alarm with the storage. Both
   * leave rows due with nothing coming for them, and the symptom is silence.
   */
  rearm(): Promise<void>;
  /** Permanently disable and clear alarms, for explicit teardown. */
  disableAlarms(): Promise<void>;
  /** Dispose installed capabilities in reverse registration order. */
  dispose(): Promise<void>;
}

/**
 * Compose a {@link Scheduler} onto a plain Durable Object.
 *
 * ```ts
 * class Worker extends DurableObject<Env> {
 *   readonly #wake = installScheduler(this, {
 *     callbacks: { reclaim: (payload: { name: string }) => this.#reclaim(payload) }
 *   });
 *
 *   async touch(): Promise<void> {
 *     await this.#wake.start();
 *     await this.#wake.scheduler.set(Date.now() + 3_600_000, "reclaim", {
 *       name: "w1"
 *     });
 *   }
 * }
 * ```
 *
 * A host that already owns `alarm()` — because it has work of its own to do on
 * waking — declares it and calls through:
 *
 * ```ts
 * readonly #wake = installScheduler(this, {
 *   callbacks: { ... },
 *   delegates: ["alarm"]
 * });
 *
 * override async alarm(): Promise<void> {
 *   await this.#wake.alarm();
 *   // ...the host's own work
 * }
 * ```
 *
 * @throws if the host defines a handler it did not declare in `delegates`. That
 * is the whole reason to call this rather than assembling the two SDK objects by
 * hand: the failure it prevents produces no error of its own, only a schedule
 * that never fires.
 */
export function installScheduler<
  H extends SchedulerHandlers = SchedulerCallbacks,
  Env extends object = Cloudflare.Env
>(
  host: DurableObject<Env>,
  options: InstallSchedulerOptions<H> = {}
): ScheduledHost<H, Env> {
  const { delegates = [], ...schedulerOptions } = options;

  // Read **before** installing, with the same `in` test `installHandlers` uses.
  // Checking own properties afterwards would not be the same question: a host
  // that assigned a handler as an instance field is skipped too, and would look
  // identical to one the lifecycle had just written.
  const declared = new Set<HostHandler>(delegates);
  const undeclared = HOST_HANDLERS.filter(
    (name) => name in host && !declared.has(name)
  );
  if (undeclared.length > 0) {
    throw new Error(
      `${host.constructor.name} defines ${undeclared.map((n) => `"${n}"`).join(", ")} ` +
        `and the lifecycle will not replace ${undeclared.length === 1 ? "it" : "them"}. ` +
        `List ${undeclared.length === 1 ? "it" : "each"} in \`delegates\` and call the ` +
        `matching method on the returned object — an undelegated "alarm" leaves every ` +
        `schedule silently unfired.`
    );
  }

  const scheduler = new Scheduler<H>(schedulerOptions);
  const lifecycle = new Lifecycle<Env>(host);
  lifecycle.use(scheduler);
  lifecycle.installHandlers();

  return {
    scheduler,
    lifecycle,
    start: () => lifecycle.start(),
    alarm: () => lifecycle.alarm(),
    fetch: (request) => lifecycle.fetch(request),
    rearm: () => lifecycle.rearmAlarm(),
    disableAlarms: () => lifecycle.disableAlarms(),
    dispose: () => lifecycle.dispose()
  };
}
