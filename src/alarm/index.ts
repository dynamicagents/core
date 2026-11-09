/**
 * `@dynamicagents/core/alarm` — many deadlines over a Durable Object's one alarm.
 *
 * A Durable Object has exactly **one** alarm, and an object that needs to wake
 * for more than one reason cannot simply call `setAlarm` from each of them: the
 * last writer silently wins, and whatever the loser was waiting on never
 * happens. This module is the fix: a thin assembly over the `agents` SDK.
 *
 * **Scheduling does not require the `Agent` base class.** A `Lifecycle`
 * installs on a **plain** `DurableObject` and owns its one alarm and a durable
 * job queue, and a `Scheduler` composes onto it, so nothing in this module pulls
 * `cf_agents_state`, an `MCPClientManager`, or the prototype patching that comes
 * with extending `Agent`.
 *
 * There are two ways to wake, and they answer different needs. A **host job**
 * ({@link installLifecycle}) is a deadline under an id the host chooses, which
 * moves by pushing that id again. A **schedule** ({@link installScheduler}) adds
 * cron and interval wakes and callbacks typed by name, and cannot move. Both
 * bring retries, and keep a row per wake rather than one shared blob. Neither
 * times a handler out: one that runs past its hung threshold is reported and
 * left running, and every later job in that alarm waits behind it, so a handler
 * bounds long work itself. What they cost is named under "The sharp edges"
 * below.
 *
 * **Its own subpath, deliberately.** This is for a plain `DurableObject` — the
 * sandbox object in `@dynamicagents/plugins/sandbox` keeps its idle stop and
 * install watch on it — not for an agent, which schedules through
 * Think. It does import `agents` — far smaller than the whole `Agent` base
 * class, and not zero.
 *
 * **The dependency's surface is this subpath's surface.** `Scheduler`, the job
 * queue's types and the scheduler's are re-exported verbatim, so a consumer is
 * typed against `agents`' own declarations and every change to them arrives here
 * first: the churn is inherited rather than absorbed, and one module keeps it
 * one file's problem.
 *
 * ## The sharp edges
 *
 * **1. A host that defines its own handlers is skipped in silence.**
 * `Lifecycle.installHandlers()` only defines `fetch`, `alarm` and the WebSocket
 * handlers that the host does not already have — by design, so a framework can
 * keep its own dispatch. An object that overrides `alarm()` therefore installs
 * a lifecycle whose jobs never fire, with no error anywhere. {@link
 * installLifecycle} turns that into a throw at construction, or at start for a
 * handler a later field defines. A host with its own handler must say so in
 * `hostOwns`, and an `alarm()` it owns must call through.
 *
 * **2. A schedule cannot move; a host job can.** A schedule is a row under an
 * id the scheduler mints, with no keyed upsert, and a one-shot `set` is not
 * idempotent, so calling it again makes a *second* row: on a hot path, that is
 * how an object ends up with thousands of them. A deadline that moves is a host
 * job instead. {@link GuardedLifecycle.jobs}`.push({ id, fn, time })` replaces
 * the job holding that id in one statement, `cancel(id)` clears it, and the
 * host's `onJob({ job })` receives it when it is due, dispatching on `job.fn`.
 * A push made while that job is running wins over what its `onJob` returns, so a
 * handler may move its own deadline. What is easy to miss about the queue:
 *
 * - **Ids are one namespace per object.** A job id is unique across every owner
 *   on the lifecycle, a capability such as a container harness included, and
 *   pushing an id another owner holds throws. Prefix the host's.
 * - **A host without `onJob` loses its jobs.** The lifecycle finds the handler
 *   by name, so it is a public method, and a due host job with nowhere to go is
 *   dropped with a log line and no retry.
 * - **A job that fails for good goes in silence.** A throwing `onJob` is retried
 *   within the alarm and then deleted, and a host has no error hook to hear it,
 *   so `onJob` logs its own failures.
 *
 * **3. A bare number means two different things.** A job's `time` is epoch
 * milliseconds, what `Date.now()` and `storage.setAlarm()` both speak. A
 * scheduler's `set(when)` reads a `Date` as an instant, a string as a cron
 * expression, and a **number as a delay in seconds**, so an epoch-ms value
 * passed straight through schedules roughly fifty thousand years out, and
 * nothing rejects it. Cross every schedule's deadline as a `Date`.
 *
 * This owns *when* an object wakes. What it owes on waking is the object's own,
 * named: the `fn` a host job carries into `onJob`, or a callback registered
 * under a name in {@link SchedulerOptions.callbacks}, its payload typed against
 * it.
 */
// The class from `cloudflare:workers`, not the ambient global of the same name:
// the global is a non-generic interface describing the runtime's handler shape,
// while a lifecycle installs on the *class* and is generic in `Env`.
import type { DurableObject } from "cloudflare:workers";
import { Lifecycle, type LifecycleJobs } from "agents/lifecycle";
import {
  Scheduler,
  type SchedulerCallbacks,
  type SchedulerHandlers,
  type SchedulerOptions
} from "agents/schedules";

export type {
  LifecycleJob,
  LifecycleJobContext,
  LifecycleJobOutcome,
  LifecycleJobPushOptions,
  LifecycleJobs
} from "agents/lifecycle";
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

export interface InstallLifecycleOptions {
  /**
   * Handlers this host defines itself.
   *
   * Required for anything the host already has, because `installHandlers()`
   * skips those without saying so. Listing one is an acknowledgement, not a
   * promise: what the host then does with it is the host's decision, and the
   * two cases genuinely differ.
   *
   * **`alarm` must be delegated.** It is the only one waking cannot work
   * without: a host that owns `alarm()` and never calls {@link
   * GuardedLifecycle.alarm} has jobs and schedules that never fire.
   *
   * **`fetch` and the WebSocket handlers usually should not be.** A lifecycle's
   * `fetch` claims capability routes, falls through to a host's `onRequest`, and
   * declines any upgrade request no installed capability claims — and this
   * assembly installs none that does. A host serving its own protocol over a
   * WebSocket wants none of that, and delegating would refuse the upgrade.
   * Declare it and keep it.
   */
  readonly hostOwns?: readonly HostHandler[];
}

export interface InstallSchedulerOptions<H extends SchedulerHandlers>
  extends SchedulerOptions<H>, InstallLifecycleOptions {}

/**
 * A `Lifecycle` bound to one Durable Object, past the handler guard.
 *
 * The delegation targets are methods here rather than on the lifecycle so a host
 * has one object to hold and one name to call, and so this module can keep the
 * SDK's shape from reaching the host directly.
 */
export interface GuardedLifecycle<Env extends object = Cloudflare.Env> {
  /**
   * The lifecycle itself, for what this assembly does not wrap: installing a
   * capability with `use` before it starts.
   */
  readonly lifecycle: Lifecycle<Env>;
  /**
   * The host's job queue, which is where a deadline that moves lives. Due jobs
   * reach the host's `onJob`; see the "a schedule cannot move" edge above.
   *
   * `lifecycle.jobs`, except that a write starts the lifecycle before it runs.
   */
  readonly jobs: LifecycleJobs;
  /**
   * Start the lifecycle and its capabilities.
   *
   * The runtime entry points do this themselves, so a host that is reached
   * through `fetch` never needs it. An **RPC-only** host does: native RPC
   * bypasses `fetch` entirely, so without an explicit call no capability starts,
   * and a `Scheduler`'s storage is never migrated before its first `set`.
   */
  start(): Promise<void>;
  /**
   * Run the lifecycle's alarm phase, which is where due jobs and schedules
   * execute.
   *
   * A host that owns `alarm()` **must** call this from it. Nothing else does.
   */
  alarm(): Promise<void>;
  /**
   * The lifecycle's request handling — capability routes, `onRequest`, and
   * connection upgrades. A host serving its own protocol over `fetch` should
   * keep its own rather than delegate here; see {@link
   * InstallLifecycleOptions.hostOwns}.
   */
  fetch(request: Request): Promise<Response>;
  /**
   * Recompute the physical alarm from every capability.
   *
   * For the one failure the queue cannot see from the inside: the runtime
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

/** A {@link GuardedLifecycle} carrying a `Scheduler`. */
export interface ScheduledHost<
  H extends SchedulerHandlers,
  Env extends object = Cloudflare.Env
> extends GuardedLifecycle<Env> {
  /** Set, list and cancel schedules. The reason this object exists. */
  readonly scheduler: Scheduler<H>;
}

function undelegated(
  host: object,
  names: readonly HostHandler[],
  how: string
): Error {
  const one = names.length === 1;
  return new Error(
    `${host.constructor.name} defines ${names.map((n) => `"${n}"`).join(", ")} ` +
      `${how}. ` +
      `List ${one ? "it" : "each"} in \`hostOwns\` to say so. ` +
      `An "alarm" the host owns must then call through to this object's \`alarm()\`, ` +
      `or every job and schedule is silently unfired.`
  );
}

/**
 * Install a {@link Lifecycle} on a plain Durable Object, refusing a host whose
 * own handlers would leave it silently unfired.
 *
 * ```ts
 * class Worker extends DurableObject<Env> {
 *   readonly #wake = installLifecycle(this);
 *
 *   async touch(): Promise<void> {
 *     // Epoch ms. Pushing the same id again moves the deadline.
 *     await this.#wake.jobs.push({
 *       id: "worker:reclaim",
 *       fn: "reclaim",
 *       time: Date.now() + 3_600_000
 *     });
 *   }
 *
 *   // Public: the lifecycle finds it by name.
 *   async onJob({ job }: LifecycleJobContext): Promise<void> {
 *     if (job.fn === "reclaim") await this.#reclaim();
 *   }
 * }
 * ```
 *
 * A host that already owns `alarm()`, because it has work of its own to do on
 * waking, declares it and calls through:
 *
 * ```ts
 * readonly #wake = installLifecycle(this, { hostOwns: ["alarm"] });
 *
 * override async alarm(): Promise<void> {
 *   await this.#wake.alarm();
 *   // ...the host's own work
 * }
 * ```
 *
 * @throws if the host defines a handler it did not declare in `hostOwns`. That
 * is the whole reason to call this rather than assembling the lifecycle by
 * hand: the failure it prevents produces no error of its own, only a job that
 * never fires. A handler defined by a field declared after this call's is only
 * there once construction ends, so it is refused at start instead: by
 * `start()`, and by every job write and scheduler call, each of which starts the
 * lifecycle first.
 */
export function installLifecycle<Env extends object = Cloudflare.Env>(
  host: DurableObject<Env>,
  options: InstallLifecycleOptions = {}
): GuardedLifecycle<Env> {
  const { hostOwns = [] } = options;

  // Read **before** installing, with the same `in` test `installHandlers` uses.
  // Checking own properties afterwards would not be the same question: a host
  // that assigned a handler as an instance field is skipped too, and would look
  // identical to one the lifecycle had just written.
  const declared = new Set<HostHandler>(hostOwns);
  const undeclared = HOST_HANDLERS.filter(
    (name) => name in host && !declared.has(name)
  );
  if (undeclared.length > 0) {
    throw undelegated(
      host,
      undeclared,
      `and the lifecycle will not replace ${undeclared.length === 1 ? "it" : "them"}`
    );
  }

  const lifecycle = new Lifecycle<Env>(host);

  // Fields initialize in source order, so a handler field declared after the
  // one that called this overwrites what `installHandlers()` defines below, and
  // the check above cannot see it coming. Asked again at start, once every field
  // has run. Registered first, so it runs before any capability a caller `use`s
  // afterwards and nothing is scheduled on a host whose alarm will never reach
  // it.
  const handlers = host as unknown as Record<HostHandler, unknown>;
  const installed = new Map<HostHandler, unknown>();
  lifecycle.use({
    onStart() {
      const replaced = [...installed]
        .filter(([name, handler]) => handlers[name] !== handler)
        .map(([name]) => name);
      if (replaced.length > 0) {
        throw undelegated(
          host,
          replaced,
          "in a field declared after the one that installed the lifecycle, over the lifecycle's"
        );
      }
    }
  });
  lifecycle.installHandlers();
  for (const name of HOST_HANDLERS) {
    if (!declared.has(name)) installed.set(name, handlers[name]);
  }

  // Every write starts the lifecycle first, as a scheduler call does, so the
  // start-time half of the guard refuses a push rather than leaving its job on
  // an alarm that never runs.
  const queue = lifecycle.jobs;
  const started =
    <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await lifecycle.start();
      return write(...args);
    };
  const jobs: LifecycleJobs = Object.freeze({
    push: started(queue.push),
    cancel: started(queue.cancel),
    reschedule: started(queue.reschedule),
    get: queue.get,
    list: queue.list,
    rearm: queue.rearm
  });

  return {
    lifecycle,
    jobs,
    start: () => lifecycle.start(),
    alarm: () => lifecycle.alarm(),
    fetch: (request) => lifecycle.fetch(request),
    rearm: () => lifecycle.rearmAlarm(),
    disableAlarms: () => lifecycle.disableAlarms(),
    dispose: () => lifecycle.dispose()
  };
}

/**
 * {@link installLifecycle}, with a {@link Scheduler} composed onto it, for cron
 * and interval wakes and callbacks typed by name.
 *
 * ```ts
 * class Worker extends DurableObject<Env> {
 *   readonly #wake = installScheduler(this, {
 *     callbacks: { reclaim: (payload: { name: string }) => this.#reclaim(payload) }
 *   });
 *
 *   async nightly(): Promise<void> {
 *     await this.#wake.start();
 *     await this.#wake.scheduler.set("0 3 * * *", "reclaim", { name: "w1" });
 *   }
 * }
 * ```
 *
 * A deadline that moves is a host job on {@link GuardedLifecycle.jobs}, never
 * a schedule cancelled and set again; see the "a schedule cannot move" edge
 * above.
 *
 * @throws as {@link installLifecycle} does, and for the same reason.
 */
export function installScheduler<
  H extends SchedulerHandlers = SchedulerCallbacks,
  Env extends object = Cloudflare.Env
>(
  host: DurableObject<Env>,
  options: InstallSchedulerOptions<H> = {}
): ScheduledHost<H, Env> {
  const { hostOwns, ...schedulerOptions } = options;
  const guarded = installLifecycle<Env>(host, { hostOwns });
  const scheduler = new Scheduler<H>(schedulerOptions);
  guarded.lifecycle.use(scheduler);
  return { ...guarded, scheduler };
}
