import type {
  Scheduler,
  SchedulerCallbacks,
  SchedulerHandlers
} from "agents/schedules";
import { namedDeadline, type Deadline } from "../alarm/index.js";
import { isRearmable, type JobState, type RunningJob } from "./state.js";

/**
 * The choreography around a long job a Durable Object owns through its alarm.
 *
 * The job itself — what command, where, and what its output means — belongs to
 * the owner. What lives here is the part that is the same every time and is
 * wrong in the same ways every time:
 *
 * 1. **Arming writes `running` before anything runs.** The alarm has not fired
 *    yet, and a `done` record in that window lets a gated caller through against
 *    a workspace that is not ready. Writing `running` first also makes arming
 *    self-limiting: the next call sees it and stops.
 * 2. **One job at a time**, guarded by a read that goes *through* the staleness
 *    bound — so a `running` record left by a dead isolate resolves rather than
 *    blocking every retry forever.
 * 3. **A drain can outlive the job it watched.** `ctx.waitUntil` keeps running
 *    after the RPC returns, and a late drain writing its verdict over a record
 *    describing a *live* job is silent corruption. A `running` record's
 *    `startedAt` is its generation, and every run's writes go through
 *    {@link generation}, which compares and writes in one step.
 * 4. **Nobody may be draining at all.** A watch intent re-attaches to a job
 *    whose isolate went away mid-flight.
 *
 * What is deliberately *not* here is the drain loop. The install runs to
 * completion under `waitUntil` and writes a single verdict; a job that reports
 * partial progress as it goes would drain differently. What jobs share is the
 * rules above and nothing below them, so the loop stays with the owner.
 *
 * ## Storage keys
 *
 * Derived from {@link JobLifecycleOptions.id} so one object can own several
 * jobs. For `id: "install"` they come out as `install`, `install:armed`,
 * `install:last-armed`, `install:context` and `install:watch-id`.
 *
 * The last of those is the one a scheduler forces. A schedule is a row with an
 * id, not a keyed upsert, so re-arming the watchdog means cancelling the
 * previous row and creating another — and cancelling needs the id that only the
 * call which created it ever saw. Holding it in storage is what keeps a watchdog
 * re-armed across a hundred drain windows from leaving a hundred rows behind.
 */

/** What a job's result looks like to the lifecycle. Deliberately minimal. */
export interface JobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A running command, reduced to what the lifecycle needs of it. */
export interface JobHandle {
  result(): Promise<JobResult>;
  [Symbol.dispose](): void;
}

export interface JobLifecycleOptions<
  H extends SchedulerHandlers = SchedulerCallbacks
> {
  /**
   * Namespaces every storage key. Also the state record's own key. Non-empty
   * and free of `:`, the separator the derived keys add.
   */
  id: string;
  storage: DurableObjectStorage;
  /**
   * The object's scheduler. Owned by the host, because the callbacks are.
   *
   * Taken directly rather than through an adapter: the only consumer of this
   * module is a Durable Object that already has one, and a narrow interface
   * that `Scheduler` happens to satisfy would buy nothing but a second name for
   * it.
   */
  scheduler: Scheduler<H>;
  /**
   * The registered callback that **runs** a job.
   *
   * A name rather than a function, because that is what a schedule row persists
   * — the callback is re-bound on every wake of the Durable Object, and a
   * closure captured here would not survive one. The host registers it; this
   * only ever schedules it.
   */
  run: keyof H & string;
  /** The registered callback that re-attaches to a job nobody is draining. */
  watch: keyof H & string;
  /*
   * `staleMs`, `watchMs` and `armCooldownMs` are required: how long a job may
   * overrun, how often a dead one is looked for and how often one may be
   * re-armed are the owner's to decide for its own job, and core ships no
   * numbers.
   */
  /**
   * How long a `running` record may stand before it is presumed dead.
   *
   * Measured from `startedAt` and compared against the job's own timeout plus
   * this, never against this alone — the point is to outlast a job that is
   * merely slow, and only then to declare one that is gone.
   */
  staleMs: number;
  /** How often the watch intent re-checks a job nobody is draining. */
  watchMs: number;
  /**
   * The floor between two arming attempts.
   *
   * Without it a job that cannot start re-arms on every call into the object.
   */
  armCooldownMs: number;
}

export class JobLifecycle<
  TExtra extends object = Record<never, never>,
  TContext extends object = Record<string, unknown>,
  H extends SchedulerHandlers = SchedulerCallbacks
> {
  readonly #o: Required<Omit<JobLifecycleOptions<H>, "storage" | "scheduler">> &
    Pick<JobLifecycleOptions<H>, "storage" | "scheduler">;

  /** `install` — the state record. */
  readonly stateKey: string;
  /** `install:armed` — the stamp the arming path wrote, for the alarm to match. */
  readonly armedKey: string;
  /** `install:last-armed` — the cooldown floor. */
  readonly lastArmedKey: string;
  /** `install:context` — the owner's own record of the run. */
  readonly contextKey: string;
  /** `install:watch-id` — the schedule the watchdog must cancel to re-arm. */
  readonly watchIdKey: string;

  /** The watchdog's one movable deadline, over {@link watchIdKey}. */
  readonly #watch: Deadline;

  /**
   * The tail {@link arm}, {@link reserve} and a generation's `write` queue on.
   * Per instance, because an object keeps one lifecycle per job: the queue is
   * what makes each one's read, check and write a single step even when a
   * caller awaits something that is not storage in between, or two calls share
   * one event.
   */
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * The last stamp this instance handed out.
   *
   * A generation must differ from every one a drain could still hold, and
   * `Date.now()` alone does not: the runtime advances it only across I/O, so
   * two reservations in one event read the same millisecond. A live drain holds
   * a stamp this instance handed out, or — re-attached — the record's, so a
   * stamp past both is new.
   */
  #stamped = 0;

  #stamp(replacing: JobState<TExtra>): number {
    const held = replacing.state === "running" ? replacing.startedAt : 0;
    this.#stamped = Math.max(Date.now(), this.#stamped + 1, held + 1);
    return this.#stamped;
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  constructor(options: JobLifecycleOptions<H>) {
    /**
     * An id is a storage key, so a bad one is not a bad name — it is a write
     * landing on somebody else's row. A `:` is how one collides: job
     * `install:armed`'s record would be job `install`'s armed stamp. Without one,
     * a record's key has no `:` and every derived key splits at its first, back
     * to its own job.
     *
     * A schedule carries an id the scheduler mints and lives in its own row, so
     * no job id can collide with the scheduling machinery however it is spelled.
     * The keys derived here are the only ones worth guarding.
     */
    if (!options.id || options.id.includes(":")) {
      throw new Error(
        `a job id must be a non-empty string without ":", got ${JSON.stringify(options.id)}`
      );
    }
    this.#o = options;
    this.stateKey = options.id;
    this.armedKey = `${options.id}:armed`;
    this.lastArmedKey = `${options.id}:last-armed`;
    this.contextKey = `${options.id}:context`;
    this.watchIdKey = `${options.id}:watch-id`;
    this.#watch = namedDeadline({
      storage: options.storage,
      scheduler: options.scheduler,
      key: this.watchIdKey,
      callback: options.watch
    });
  }

  // --- the record ------------------------------------------------------------

  /** The raw record, with no staleness repair. `idle` when nothing is written. */
  async read(): Promise<JobState<TExtra>> {
    return (
      (await this.#o.storage.get<JobState<TExtra>>(this.stateKey)) ??
      ({ state: "idle" } as JobState<TExtra>)
    );
  }

  /**
   * Unguarded. A run writes through {@link generation}; this is for a record no
   * run holds.
   */
  async write(state: JobState<TExtra>): Promise<void> {
    await this.#o.storage.put(this.stateKey, state);
  }

  async context(): Promise<TContext | undefined> {
    return await this.#o.storage.get<TContext>(this.contextKey);
  }

  /**
   * The owner's own record of the run — what it needs to run the job again,
   * when the alarm re-runs it with no caller to ask. Namespaced under the job;
   * nothing here reads it.
   */
  async putContext(context: TContext): Promise<void> {
    await this.#o.storage.put(this.contextKey, context);
  }

  // --- arming ----------------------------------------------------------------

  /**
   * Hand a cold job to the alarm, if one is not already pending.
   *
   * Returns the stamp it armed with, or `undefined` when it declined — the
   * caller needs the stamp because it is what the alarm must present to
   * {@link claim} to get past the single-flight guard.
   *
   * An arming caller must **not** own the run. Hand one to `ctx.waitUntil` from
   * a gate poll that returns in milliseconds and the drain is disposed
   * underneath it mid-command. An alarm invocation belongs to the object rather
   * than to any request, so nothing it awaits can be cut short.
   */
  arm(
    placeholder: Omit<RunningJob<TExtra>, "state" | "startedAt">
  ): Promise<number | undefined> {
    return this.#exclusive(() => this.#arm(placeholder));
  }

  async #arm(
    placeholder: Omit<RunningJob<TExtra>, "state" | "startedAt">
  ): Promise<number | undefined> {
    const state = await this.read();
    if (!isRearmable(state)) return undefined;

    const lastArmed = await this.#o.storage.get<number>(this.lastArmedKey);
    if (
      lastArmed !== undefined &&
      Date.now() - lastArmed < this.#o.armCooldownMs
    )
      return undefined;

    const armedAt = this.#stamp(state);
    // First, and kept whatever follows, deliberately: a floor that only applied
    // to *successful* arming would let a persistently failing schedule re-arm on
    // every call into the object, which is what it exists to prevent.
    await this.#o.storage.put(this.lastArmedKey, armedAt);
    // One put, so the placeholder and its stamp land together or not at all.
    await this.#o.storage.put({
      [this.stateKey]: { ...placeholder, state: "running", startedAt: armedAt },
      [this.armedKey]: armedAt
    });

    /**
     * The placeholder and the schedule that owns it are two writes, and between
     * them is the one window where this can strand a job: a `running` record no
     * schedule points at, which every later {@link arm} then declines to replace
     * *because* it is running.
     *
     * The staleness bound in {@link claim} would eventually free it, but only
     * after a full timeout — so unwind instead, and leave the record exactly as
     * re-armable as it was found.
     */
    try {
      // A `Date`, never the bare number. `set` reads a number as a **delay in
      // seconds** — an epoch-ms stamp passed straight through becomes a delay of
      // roughly fifty thousand years, and nothing rejects it. Every deadline in
      // this module is epoch ms, so every one of them crosses as a `Date`.
      await this.#o.scheduler.set(new Date(armedAt), this.#o.run);
    } catch (err) {
      try {
        // Issued together, with no await between, so they commit as one.
        await Promise.all([
          this.#o.storage.put(this.stateKey, state),
          this.#o.storage.delete(this.armedKey)
        ]);
      } catch (rollback) {
        throw new AggregateError(
          [err, rollback],
          `job "${this.#o.id}": its run could not be scheduled, and its placeholder could not be undone`
        );
      }
      throw err;
    }
    return armedAt;
  }

  /** The stamp {@link arm} wrote, so the alarm can recognise its own placeholder. */
  async armedAt(): Promise<number | undefined> {
    return await this.#o.storage.get<number>(this.armedKey);
  }

  async clearArmed(): Promise<void> {
    await this.#o.storage.delete(this.armedKey);
  }

  // --- the single-flight guard ------------------------------------------------

  /**
   * Take the job's one running slot, or learn who holds it.
   *
   * The {@link claim} check and the `running` write are one step, queued with
   * every other `reserve` and {@link arm} on this job. A check that returned
   * before its write would leave a window — the caller resolving a command,
   * hashing a lockfile — in which a second caller passes the same check, and
   * both spawn: the displacement the check exists to refuse.
   *
   * A caller spawns only after this succeeds, and before it returns it replaces
   * the placeholder with its own record or puts `previous` back — through
   * {@link generation}, with the `startedAt` this returns, which is the run's
   * generation.
   */
  reserve(
    placeholder: Omit<RunningJob<TExtra>, "state" | "startedAt">,
    timeoutMs: number,
    takeOverArmedAt?: number
  ): Promise<
    | { ok: true; previous: JobState<TExtra>; startedAt: number }
    | { ok: false; current: RunningJob<TExtra> }
  > {
    return this.#exclusive(async () => {
      const previous = await this.read();
      const checked = this.claim(previous, timeoutMs, takeOverArmedAt);
      if (!checked.ok) return checked;
      const startedAt = this.#stamp(previous);
      await this.write({
        ...placeholder,
        state: "running",
        startedAt
      } as JobState<TExtra>);
      return { ok: true, previous, startedAt };
    });
  }

  /**
   * Decide whether a new run may start — the check {@link reserve} makes. It
   * writes nothing, so a caller that means to run reserves rather than
   * following this with a write of its own.
   *
   * `takeOverArmedAt` is the one exemption and it is narrow on purpose. The
   * alarm's placeholder *is* a `running` record for a job that has not started,
   * so the alarm has to pass its own guard — and only its own. Matching the
   * exact stamp it wrote is what stops this becoming "take over any running
   * job", which is the displacement bug the guard exists to prevent: three
   * callers spawning under one exec id in fifty seconds, each displacing the
   * last, every displaced drain still attached and still writing verdicts.
   *
   * Applies the staleness bound **itself**, rather than trusting the caller to
   * have repaired the record first. Raw and repaired states have identical
   * types, so nothing could hold a caller to that: a raw read would be a
   * `running` record that could never be claimed, and a job wedged forever.
   * `timeoutMs` is the job's own budget; see {@link isStale}.
   */
  claim(
    state: JobState<TExtra>,
    timeoutMs: number,
    takeOverArmedAt?: number
  ): { ok: true } | { ok: false; current: RunningJob<TExtra> } {
    if (state.state !== "running") return { ok: true };
    // The alarm presenting its own placeholder — the one narrow exemption.
    if (state.startedAt === takeOverArmedAt) return { ok: true };
    // A record whose isolate is gone must not block every later run.
    if (this.isStale(state, timeoutMs)) return { ok: true };
    return { ok: false, current: state };
  }

  // --- staleness and re-attach -------------------------------------------------

  /**
   * Whether a `running` record has stood long enough to be presumed dead.
   *
   * `timeoutMs` is the job's own budget; the bound is that plus `staleMs`, so a
   * job that is merely slow is never declared gone.
   */
  isStale(
    state: RunningJob<TExtra>,
    timeoutMs: number,
    now: number = Date.now()
  ): boolean {
    return now - state.startedAt > timeoutMs + this.#o.staleMs;
  }

  /**
   * Arm the watchdog that re-attaches to a job nobody is draining.
   *
   * A {@link Deadline} rather than a bare `scheduler.set`, because a drain
   * re-arms on every window and a schedule is a row rather than a keyed upsert.
   * Scheduling without cancelling would leave one row per window, every one of
   * them due, each waking the object to discover the others already handled it.
   */
  async armWatch(now: number = Date.now()): Promise<void> {
    // A `Date`: a number would be read as a delay in seconds.
    await this.#watch.set(new Date(now + this.#o.watchMs));
  }

  /**
   * Disarm the watchdog.
   *
   * A run settling through {@link generation} does this in the same step. From
   * anywhere else, only for a record no run holds: the watchdog belongs to
   * whichever run owns the record *now*, and clearing it from a superseded one
   * disarms the one recovery path the live run has.
   */
  async clearWatch(): Promise<void> {
    await this.#watch.clear().catch(() => {});
  }

  // --- generation --------------------------------------------------------------

  /**
   * One run's hold on the record: the `running` record whose `startedAt` is
   * this stamp. {@link reserve} and {@link arm} write a new one, so a run
   * displaced by either is superseded the moment it is.
   *
   * `write` is how a run touches the record — the owner's own record after a
   * reservation, a verdict, a failure it could not start past. The check and
   * the write are one step, queued with {@link reserve} and {@link arm}: a
   * predicate followed by a write of the caller's own would leave a window in
   * which a new run takes the record and the old verdict lands over it.
   *
   * A state that is not `running` settles the run, and the same step clears the
   * watchdog: cleared afterwards, it could already be a newer run's. `also` are
   * keys that hold only if the verdict does, written in the same put.
   *
   * A caller that did not start the run — a staleness repair, a re-attach that
   * failed — holds it by the record's own `startedAt`.
   *
   * Ownership **latches**: once refused, a generation never writes again, even
   * if a stamp that happens to match comes back.
   */
  generation(startedAt: number): {
    stillMine: () => Promise<boolean>;
    write: (
      state: JobState<TExtra>,
      also?: Record<string, unknown>
    ) => Promise<boolean>;
  } {
    let superseded = false;
    const owns = async (): Promise<boolean> => {
      if (superseded) return false;
      const now = await this.read();
      if (now.state === "running" && now.startedAt === startedAt) return true;
      superseded = true;
      return false;
    };
    return {
      stillMine: owns,
      write: (state, also = {}) =>
        this.#exclusive(async () => {
          if (state.state === "running" && state.startedAt !== startedAt) {
            throw new Error(
              `job "${this.#o.id}": a running record keeps its generation's startedAt`
            );
          }
          if (!(await owns())) return false;
          await this.#o.storage.put({ ...also, [this.stateKey]: state });
          if (state.state !== "running") await this.clearWatch();
          return true;
        })
    };
  }
}
