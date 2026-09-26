import { describe, it, expect } from "vitest";
import type { Scheduler, SchedulerCallbacks } from "agents/schedules";
import { JobLifecycle } from "./lifecycle.js";
import type { JobState } from "./state.js";

/**
 * What these specs pin is the *choreography*, not the job. Each rule is
 * asserted negatively — that the wrong thing is refused — rather than merely
 * that the right thing works, because a guard that lets the right thing through
 * passes that check whether or not it refuses anything.
 *
 * Driven through fakes rather than a real Durable Object because the rules are
 * about which keys are written in which order and which scheduling calls are
 * made in which order. A real `Scheduler` would make those reachable; a fake
 * makes them assertable, and the scheduler's own behaviour is the SDK's to test.
 */
function fakeStorage(): DurableObjectStorage {
  const rows = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async <T>(key: string): Promise<T | undefined> =>
      rows.get(key) as T | undefined,
    // Both of storage's forms: a key and a value, or an object of entries.
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      const entries = typeof key === "string" ? { [key]: value } : key;
      for (const [k, v] of Object.entries(entries))
        rows.set(k, structuredClone(v));
    },
    delete: async (key: string): Promise<boolean> => rows.delete(key),
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (when: number): Promise<void> => {
      alarm = when;
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    }
  } as unknown as DurableObjectStorage;
}

/**
 * A scheduler that records what it was asked to do.
 *
 * `when` is kept **raw** rather than normalised, because the type it arrives as
 * is itself a rule: `Scheduler.set` reads a number as a delay in seconds, so an
 * epoch-ms deadline passed through as a number schedules fifty thousand years
 * out and nothing rejects it. A fake that normalised would hide exactly that.
 */
function fakeScheduler() {
  const live = new Map<string, { callback: string; when: unknown }>();
  const calls: string[] = [];
  let minted = 0;

  const scheduler = {
    set: async (when: unknown, callback: string) => {
      const id = `sched-${++minted}`;
      calls.push(`set:${callback}`);
      live.set(id, { callback, when });
      return { id, callback, type: "scheduled" };
    },
    cancel: async (id: string) => {
      calls.push(`cancel:${id}`);
      return live.delete(id);
    }
  };

  return {
    scheduler: scheduler as unknown as Scheduler<SchedulerCallbacks>,
    /** Every schedule that has been created and not cancelled. */
    live,
    /** `set` and `cancel` in the order they happened. Ordering is a rule here. */
    calls
  };
}

type Install = { command: string };

/** The timings a job owner supplies; any will do where a spec is not about them. */
const TIMINGS = {
  staleMs: 5 * 60_000,
  watchMs: 60_000,
  armCooldownMs: 5 * 60_000
};

function lifecycle(id = "install", over: { watchMs?: number } = {}) {
  const storage = fakeStorage();
  const sched = fakeScheduler();
  return {
    storage,
    ...sched,
    job: new JobLifecycle<Install>({
      id,
      storage,
      scheduler: sched.scheduler,
      run: "jobRun",
      watch: "jobWatch",
      ...TIMINGS,
      ...over
    })
  };
}

describe("key derivation", () => {
  /**
   * A deployed object's storage holds these strings, so a change here is not a
   * rename — it is every live workspace losing its install record.
   */
  it("reproduces the hand-written keys for id 'install'", () => {
    const { job } = lifecycle();
    expect(job.stateKey).toBe("install");
    expect(job.armedKey).toBe("install:armed");
    expect(job.lastArmedKey).toBe("install:last-armed");
    expect(job.contextKey).toBe("install:context");
    expect(job.watchIdKey).toBe("install:watch-id");
  });

  it("namespaces a second job on the same object", () => {
    const { job } = lifecycle("claude-run");
    expect(job.stateKey).toBe("claude-run");
    expect(job.watchIdKey).toBe("claude-run:watch-id");
  });
});

describe("arm", () => {
  it("writes running before anything runs, and schedules the run callback", async () => {
    const { job, live } = lifecycle();
    await job.write({
      state: "done",
      command: "npm ci",
      exitCode: 0,
      finishedAt: 1,
      ms: 1
    });

    const armedAt = await job.arm({ command: "npm ci" });
    expect(armedAt).toBeTypeOf("number");

    const state = await job.read();
    // `running`, not `done` — a `done` record in this window lets a gated caller
    // through against a workspace that is not ready.
    expect(state.state).toBe("running");
    expect(await job.armedAt()).toBe(armedAt);

    const scheduled = [...live.values()];
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.callback).toBe("jobRun");
    // A `Date`, not the raw stamp — a number would be read as a delay in
    // seconds, putting the run fifty thousand years out with no error.
    expect(scheduled[0]!.when).toBeInstanceOf(Date);
    expect((scheduled[0]!.when as Date).getTime()).toBe(armedAt);
  });

  it("is self-limiting: a second call sees running and declines", async () => {
    const { job } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();
  });

  it("re-arms from failed, not only from done", async () => {
    // Requiring `done` would leave a bad run's record declining to re-arm
    // forever — one failure poisoning every task after it.
    const { job } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
  });

  it("refuses to re-arm from skipped or idle", async () => {
    const { job } = lifecycle();
    expect(await job.arm({ command: "npm ci" })).toBeUndefined(); // idle
    await job.write({ state: "skipped", reason: "nothing to install" });
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();
  });

  it("honours the cooldown floor between attempts", async () => {
    const { job, storage } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");

    // Back to a re-armable state, but still inside the cooldown window.
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 2,
      error: "y"
    });
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();

    // Age the cooldown marker past the floor.
    await storage.put("install:last-armed", Date.now() - 10 * 60_000);
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
  });
});

describe("claim", () => {
  const running = (startedAt: number): JobState<Install> => ({
    state: "running",
    command: "npm ci",
    startedAt
  });
  /** Comfortably longer than any age used below, so staleness never fires. */
  const LIVE = 60 * 60_000;

  it("refuses a second run while one is in flight", () => {
    const { job } = lifecycle();
    expect(job.claim(running(Date.now()), LIVE).ok).toBe(false);
  });

  it("admits the alarm presenting its own placeholder stamp", () => {
    const { job } = lifecycle();
    const at = Date.now();
    expect(job.claim(running(at), LIVE, at).ok).toBe(true);
  });

  it("refuses a take-over with any other stamp", () => {
    // This is the displacement bug in a new hat: an exemption keyed on anything
    // looser than the exact stamp becomes "take over any running job".
    const { job } = lifecycle();
    const at = Date.now();
    expect(job.claim(running(at), LIVE, at - 1).ok).toBe(false);
    expect(job.claim(running(at), LIVE, undefined).ok).toBe(false);
  });

  it("admits a run when the record is terminal", () => {
    const { job } = lifecycle();
    expect(job.claim({ state: "idle" }, LIVE).ok).toBe(true);
    expect(
      job.claim(
        { state: "done", command: "npm ci", exitCode: 0, finishedAt: 1, ms: 1 },
        LIVE
      ).ok
    ).toBe(true);
  });

  it("applies the staleness bound itself rather than trusting the caller", () => {
    // Raw and repaired states have identical types, so nothing could hold a
    // caller to repairing first: a raw read would be a `running` record that
    // could never be claimed, and a job wedged forever.
    const { job } = lifecycle();
    // In flight and inside its budget: a second run must wait.
    expect(job.claim(running(Date.now()), LIVE).ok).toBe(false);
    // Written by an isolate that is long gone: claimable, or it blocks forever.
    expect(job.claim(running(0), LIVE).ok).toBe(true);
  });
});

/**
 * The check and the `running` write as one step. A check that returns before
 * its write lets a second caller pass the same check while the first is still
 * resolving what to run — and both spawn.
 */
describe("reserve", () => {
  const LIVE = 60 * 60_000;

  it("gives the slot to one of two overlapping callers", async () => {
    const { job } = lifecycle();
    const [a, b] = await Promise.all([
      job.reserve({ command: "npm ci" }, LIVE),
      job.reserve({ command: "npm ci" }, LIVE)
    ]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((await job.read()).state).toBe("running");
  });

  it("hands back what it replaced, so a caller that does not run can put it back", async () => {
    const { job } = lifecycle();
    await job.write({ state: "skipped", reason: "no package.json" });

    const reserved = await job.reserve({ command: "npm ci" }, LIVE);

    expect(reserved).toEqual({
      ok: true,
      previous: { state: "skipped", reason: "no package.json" },
      startedAt: expect.any(Number)
    });
  });

  /** A finished run's record, from which the alarm may re-arm. */
  const failed: JobState<Install> = {
    state: "failed",
    command: "npm ci",
    finishedAt: 1,
    error: "x"
  };

  it("lets the alarm take over its own placeholder, and no one else's", async () => {
    const { job } = lifecycle();
    await job.write(failed);
    const armedAt = await job.arm({ command: "npm ci" });
    expect(armedAt).toBeTypeOf("number");

    expect((await job.reserve({ command: "npm ci" }, LIVE)).ok).toBe(false);
    expect((await job.reserve({ command: "npm ci" }, LIVE, armedAt)).ok).toBe(
      true
    );
  });

  it("queues behind an arm, so a failed arm cannot undo a reservation", async () => {
    // Overlapping, an arm whose schedule fails would restore the state it read
    // over the reservation written in between. Queued, it reads the
    // reservation and declines.
    const { job, scheduler } = lifecycle();
    scheduler.set = async () => {
      throw new Error("scheduler unavailable");
    };
    await job.write(failed);

    const [armed, reserved] = await Promise.all([
      job.arm({ command: "npm ci" }).catch(() => "threw"),
      job.reserve({ command: "npm ci" }, LIVE)
    ]);

    expect(armed).toBe("threw");
    expect(reserved.ok).toBe(true);
    expect((await job.read()).state).toBe("running");
  });
});

describe("generation", () => {
  const LIVE = 60 * 60_000;
  const done: JobState<Install> = {
    state: "done",
    command: "npm ci",
    exitCode: 0,
    finishedAt: 1,
    ms: 1,
    tail: ""
  };
  const failed: JobState<Install> = {
    state: "failed",
    command: "npm ci",
    finishedAt: 1,
    error: "x"
  };

  /** A run that holds the record, as a caller that reserved it has one. */
  async function owned() {
    const setup = lifecycle();
    const r = await setup.job.reserve({ command: "npm ci" }, LIVE);
    if (!r.ok) throw new Error("expected a reservation");
    return {
      ...setup,
      startedAt: r.startedAt,
      gen: setup.job.generation(r.startedAt)
    };
  }

  it("writes while its running record stands", async () => {
    const { job, gen } = await owned();
    expect(await gen.stillMine()).toBe(true);
    expect(await gen.write(done)).toBe(true);
    expect(await job.read()).toEqual(done);
  });

  it("is superseded by a reservation, before the new run writes anything else", async () => {
    // A drain can outlive the job it watched: `ctx.waitUntil` keeps running
    // after the RPC returns. The reservation is the handoff, so it is what
    // moves the generation — not a record the new owner writes later.
    const { job, gen } = await owned();
    await job.write(failed); // a staleness repair, say
    const next = await job.reserve({ command: "npm ci" }, LIVE);
    expect(next.ok).toBe(true);

    expect(await gen.write(done)).toBe(false);
    expect((await job.read()).state).toBe("running");
  });

  it("is superseded by an arm", async () => {
    const { job, gen } = await owned();
    await job.write(failed);
    const armedAt = await job.arm({ command: "npm ci" });

    expect(await gen.write(done)).toBe(false);
    expect(await job.read()).toMatchObject({ startedAt: armedAt });
  });

  it("checks and writes in one step, so a reservation cannot land between", async () => {
    // A stale record, which a reservation may take. The drain's read is held
    // with the value it read, as any await between a check and a write would
    // hold it: unqueued, the reservation lands in that window and the drain's
    // verdict then lands over it.
    const { job, storage, startedAt } = await owned();
    const gen = job.generation(startedAt);
    const get = storage.get.bind(storage);
    let hold = true;
    storage.get = (async (key: string) => {
      const value = await get(key);
      if (hold && key === "install") {
        hold = false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return value;
    }) as typeof storage.get;

    const [wrote, reserved] = await Promise.all([
      gen.write(done),
      job.reserve({ command: "npm ci" }, -TIMINGS.staleMs - 1)
    ]);

    expect(wrote).toBe(true);
    expect(reserved.ok).toBe(true);
    expect((await job.read()).state).toBe("running");
  });

  it("clears the watchdog with a verdict, and leaves a newer run's alone", async () => {
    const { job, live, gen } = await owned();
    await job.armWatch();
    expect(live.size).toBe(1);
    expect(await gen.write(done)).toBe(true);
    expect(live.size).toBe(0);

    const next = await job.reserve({ command: "npm ci" }, LIVE);
    if (!next.ok) throw new Error("expected a reservation");
    await job.armWatch();
    expect(await gen.write(failed)).toBe(false);
    expect(live.size).toBe(1);
  });

  it("writes the keys a verdict vouches for only with the verdict", async () => {
    const { job, storage, gen } = await owned();
    expect(await gen.write(done, { tree: "a" })).toBe(true);
    expect(await storage.get("tree")).toBe("a");

    await job.reserve({ command: "npm ci" }, LIVE);
    expect(await gen.write(done, { tree: "b" })).toBe(false);
    expect(await storage.get("tree")).toBe("a");
  });

  it("refuses a running record under another stamp", async () => {
    const { gen, startedAt } = await owned();
    await expect(
      gen.write({
        state: "running",
        command: "npm ci",
        startedAt: startedAt + 1
      })
    ).rejects.toThrow(/keeps its generation/);
  });

  it("never hands ownership back once superseded", async () => {
    // The latch is checked *before* the read. A record that returns to the
    // original stamp does not restore ownership — a drain regaining write
    // access here is exactly the corruption the marker exists to prevent.
    const { job } = lifecycle();
    const running = (startedAt: number): JobState<Install> => ({
      state: "running",
      command: "npm ci",
      startedAt
    });
    await job.write(running(500));
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(true);

    await job.write(running(900));
    expect(await gen.stillMine()).toBe(false);

    await job.write(running(500));
    expect(await gen.stillMine()).toBe(false);
    expect(await gen.write(done)).toBe(false);
  });

  it("owns nothing when nothing is running", async () => {
    const { job } = lifecycle();
    expect(await job.generation(500).stillMine()).toBe(false);
  });
});

describe("reserved ids", () => {
  /**
   * An id is a storage key, so the ids refused are the ones whose keys land on
   * another job's: empty, whose `:armed` two broken callers would share, and one
   * holding `:`, whose record is another job's derived key.
   *
   * The last test pins what is *not* refused. A schedule lives in its own row
   * under an id the scheduler mints, so no job id reaches the scheduling
   * machinery however it is spelled — which is why an id that reads like
   * scheduler state is accepted rather than reserved.
   */
  const make = (id: string) => () =>
    new JobLifecycle({
      id,
      storage: fakeStorage(),
      scheduler: fakeScheduler().scheduler,
      run: "jobRun",
      watch: "jobWatch",
      ...TIMINGS
    });

  it("refuses an empty id", () => {
    expect(make("")).toThrow(/non-empty/);
  });

  it("refuses an id that is another job's derived key", () => {
    expect(make("install")().armedKey).toBe("install:armed");
    expect(make("install:armed")).toThrow(/without ":"/);
  });

  it("accepts an id that reads like scheduler state", () => {
    expect(make("wake")).not.toThrow();
  });
});

describe("arm rollback", () => {
  /**
   * The placeholder and the alarm that owns it are two writes. A failure
   * between them leaves a `running` record no run intent points at, which every
   * later `arm()` then declines to replace *because* it is running.
   */
  it("restores the prior state when scheduling fails", async () => {
    const { job, scheduler } = lifecycle();
    scheduler.set = async () => {
      throw new Error("scheduler unavailable");
    };

    const before: JobState<Install> = {
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    };
    await job.write(before);

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow(
      "scheduler unavailable"
    );

    // Left exactly as re-armable as it was found, rather than wedged at
    // `running` until a full timeout elapses.
    expect(await job.read()).toEqual(before);
    expect(await job.armedAt()).toBeUndefined();
  });

  it("leaves the record as found when the placeholder cannot be written", async () => {
    const { job, storage } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    const put = storage.put.bind(storage);
    // The armed stamp is the write that fails, in whichever put carries it.
    storage.put = (async (
      key: string | Record<string, unknown>,
      value?: unknown
    ) => {
      const keys = typeof key === "string" ? [key] : Object.keys(key);
      if (keys.includes("install:armed"))
        throw new Error("storage unavailable");
      return typeof key === "string" ? put(key, value) : put(key);
    }) as typeof storage.put;

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow(
      "storage unavailable"
    );
    expect((await job.read()).state).toBe("failed");
    expect(await job.armedAt()).toBeUndefined();
  });

  it("says so when the placeholder cannot be undone either", async () => {
    const { job, storage, scheduler } = lifecycle();
    scheduler.set = async () => {
      throw new Error("scheduler unavailable");
    };
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    storage.delete = async () => {
      throw new Error("storage unavailable");
    };

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow(
      /could not be undone/
    );
  });

  it("keeps the cooldown floor even when scheduling failed", async () => {
    // A floor that applied only to *successful* arming would let a persistently
    // failing schedule re-arm on every call into the object.
    const { job, storage, scheduler } = lifecycle();
    scheduler.set = async () => {
      throw new Error("scheduler unavailable");
    };
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow();
    expect(await storage.get("install:last-armed")).toBeTypeOf("number");
  });
});

describe("the watchdog", () => {
  it("schedules the watch callback at the watch deadline", async () => {
    const { job, live, storage } = lifecycle();
    const now = 1_000_000;
    await job.armWatch(now);

    const scheduled = [...live.values()];
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.callback).toBe("jobWatch");
    // The helper's watchMs is 60s; the deadline is what a dead drain is
    // recovered by.
    expect(scheduled[0]!.when).toBeInstanceOf(Date);
    expect((scheduled[0]!.when as Date).getTime()).toBe(now + 60_000);
    // The id is held so the next re-arm can cancel this row.
    expect(await storage.get("install:watch-id")).toBeTypeOf("string");
  });

  it("honours a configured watchMs", async () => {
    const { job, live } = lifecycle("install", { watchMs: 5_000 });
    await job.armWatch(1_000_000);
    expect(([...live.values()][0]!.when as Date).getTime()).toBe(1_005_000);
  });

  /**
   * A schedule is a row, not a keyed upsert, so re-arming *adds* unless the
   * previous one is cancelled first — and a drain re-arms on every window. Left
   * alone, a job drained for an hour leaves sixty rows, every one of them due,
   * each waking the object to find the others already handled it.
   */
  it("leaves one schedule behind however often it re-arms", async () => {
    const { job, live, calls } = lifecycle();
    await job.armWatch(1_000_000);
    await job.armWatch(1_060_000);
    await job.armWatch(1_120_000);

    expect(live.size).toBe(1);
    expect(([...live.values()][0]!.when as Date).getTime()).toBe(1_180_000);
    // Cancel *then* set, not the other way round: the reverse order would leave
    // the window in which both rows exist and the object wakes twice.
    expect(calls).toEqual([
      "set:jobWatch",
      "cancel:sched-1",
      "set:jobWatch",
      "cancel:sched-2",
      "set:jobWatch"
    ]);
  });

  it("disarms on request", async () => {
    const { job, live, storage } = lifecycle();
    await job.armWatch(1_000_000);
    expect(live.size).toBe(1);

    await job.clearWatch();
    expect(live.size).toBe(0);
    // The id goes too, so a later re-arm does not try to cancel a row that is
    // gone and, worse, one whose id has since been minted again.
    expect(await storage.get("install:watch-id")).toBeUndefined();
  });

  it("swallows a failure to disarm", async () => {
    // Called from a `finally`, so a throw here would mask the drain's own
    // outcome — which is the thing the caller actually needs to report.
    const { job, scheduler } = lifecycle();
    await job.armWatch(1_000_000);
    scheduler.cancel = async () => {
      throw new Error("storage gone");
    };
    await expect(job.clearWatch()).resolves.toBeUndefined();
  });

  /**
   * A schedule the scheduler has already run and removed is the ordinary case,
   * not an error: the watchdog fires, and the drain that it woke re-arms.
   */
  it("re-arms cleanly when the previous schedule is already gone", async () => {
    const { job, scheduler, live } = lifecycle();
    await job.armWatch(1_000_000);
    live.clear();

    await expect(job.armWatch(1_060_000)).resolves.toBeUndefined();
    expect(live.size).toBe(1);
    expect(await scheduler.cancel("nothing")).toBe(false);
  });
});
