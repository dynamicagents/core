import { describe, it, expect } from "vitest";
// From `cloudflare:workers`, not `cloudflare:test` — the latter's `env` is
// deprecated, and the repo's type-aware `no-deprecated` rule fails the build on it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
// The class, not the ambient global of the same name — see `./index.ts`.
import type { DurableObject } from "cloudflare:workers";
import { installLifecycle, installScheduler, HOST_HANDLERS } from "./index.js";
import type { DelegatingScheduled, PlainScheduled } from "../../test/worker.js";

/**
 * What these pin is the *installation*, not the scheduler.
 *
 * `Scheduler` is the SDK's and has its own suite; re-testing cron parsing here
 * would be someone else's coverage counted twice. What is ours is the assembly:
 * which host gets a working alarm, which one silently does not, and what a
 * Durable Object carrying a legacy `wake` row finds when it boots on this code.
 *
 * Real Durable Objects rather than a fake, because every rule below is a
 * property of `ctx.storage` and the physical alarm — a fake storage would assert
 * that the fake works.
 */

const ns = <T extends Rpc.DurableObjectBranded>(name: string) =>
  (env as unknown as Record<string, DurableObjectNamespace<T>>)[name]!;

const plain = ns<PlainScheduled>("PLAIN_SCHEDULED");
const delegating = ns<DelegatingScheduled>("DELEGATING_SCHEDULED");

const fresh = <T extends Rpc.DurableObjectBranded>(
  namespace: DurableObjectNamespace<T>,
  label: string
) => namespace.get(namespace.idFromName(`${label}:${crypto.randomUUID()}`));

/**
 * A stand-in host carrying a real `ctx`.
 *
 * The guard is a question about the prototype chain and needs no Durable Object
 * — but a lifecycle that gets *past* the guard reads `host.ctx` immediately, so
 * the accepting cases have to hand it a real one. Borrowing the `ctx` of an
 * object the test already has is cheaper and truer than faking storage.
 */
const fakeHost = (proto: object, ctx?: DurableObjectState) =>
  Object.assign(
    Object.create(proto) as object,
    ctx ? { ctx } : {}
  ) as never as DurableObject<Cloudflare.Env>;

const OWNS_BOTH = {
  alarm: () => Promise.resolve(),
  fetch: () => new Response()
};

describe("installLifecycle — the undelegated-handler guard", () => {
  /**
   * The failure this exists for produces no error of its own. A lifecycle
   * defines `alarm` only when the host does not already have one, so a host that
   * overrides it keeps its own, and every job and schedule then never runs, with
   * nothing anywhere saying so. Turning that into a throw at construction is the
   * whole reason to call this rather than composing the lifecycle by hand.
   */
  it("refuses a host that defines a handler it did not declare", () => {
    const host = fakeHost({ alarm: () => Promise.resolve() });
    expect(() => installLifecycle(host)).toThrow(/"alarm"/);
    expect(() => installLifecycle(host)).toThrow(/silently unfired/);
  });

  it("names every undeclared handler, not just the first", () => {
    let message = "";
    try {
      installLifecycle(fakeHost(OWNS_BOTH));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('"fetch"');
    expect(message).toContain('"alarm"');
  });

  it("accepts the same host once it declares them", async () => {
    await runInDurableObject(fresh(plain, "declared"), (_instance, state) => {
      expect(() =>
        installLifecycle(fakeHost(OWNS_BOTH, state), {
          hostOwns: ["alarm", "fetch"]
        })
      ).not.toThrow();
    });
  });

  /**
   * Fields initialize in source order, so a handler field declared after the one
   * that installs the lifecycle lands over the lifecycle's handler once the check
   * at construction has passed. A real class rather than a fake host, because the
   * ordering is the class's.
   */
  it("refuses at start a handler a later field defines", async () => {
    await runInDurableObject(fresh(plain, "late"), async (_instance, state) => {
      class LateAlarm {
        readonly ctx = state;
        readonly wake = installLifecycle(this as never);
        alarm = () => Promise.resolve();
      }
      const { wake } = new LateAlarm();
      await expect(wake.start()).rejects.toThrow(/"alarm" in a field declared/);
      // The path that matters: nothing is queued on an alarm that never runs.
      await expect(
        wake.jobs.push({ id: "t:late", fn: "mark", time: Date.now() + 60_000 })
      ).rejects.toThrow(/silently unfired/);
      expect(wake.jobs.get("t:late")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("starts a later field's host once it declares the handler", async () => {
    await runInDurableObject(
      fresh(plain, "late-declared"),
      async (_instance, state) => {
        class LateDeclared {
          readonly ctx = state;
          readonly wake = installLifecycle(this as never, {
            hostOwns: ["alarm"]
          });
          alarm = () => Promise.resolve();
        }
        await expect(new LateDeclared().wake.start()).resolves.toBeUndefined();
      }
    );
  });

  /**
   * Declaring a handler the host does *not* have is harmless and stays that way
   * deliberately: the list is an acknowledgement, and a host that grows an
   * `alarm()` later should not have to remember to add one.
   */
  it("tolerates a declaration for a handler the host does not have", async () => {
    await runInDurableObject(
      fresh(plain, "overdeclared"),
      (_instance, state) => {
        expect(() =>
          installLifecycle(fakeHost({}, state), {
            hostOwns: [...HOST_HANDLERS]
          })
        ).not.toThrow();
      }
    );
  });

  /**
   * `installScheduler` is this guard plus a scheduler, so the scheduler's own
   * calls are refused the same way a job write is.
   */
  it("is inherited by installScheduler, at construction and at start", async () => {
    expect(() =>
      installScheduler(fakeHost({ alarm: () => Promise.resolve() }))
    ).toThrow(/silently unfired/);
    await runInDurableObject(
      fresh(plain, "late-scheduler"),
      async (_instance, state) => {
        class LateAlarm {
          readonly ctx = state;
          readonly wake = installScheduler(this as never);
          alarm = () => Promise.resolve();
        }
        await expect(
          new LateAlarm().wake.scheduler.set(
            new Date(Date.now() + 60_000),
            "mark",
            {}
          )
        ).rejects.toThrow(/silently unfired/);
        expect(await state.storage.getAlarm()).toBeNull();
      }
    );
  });
});

describe("installScheduler — a host with no handlers of its own", () => {
  it("runs a callback the lifecycle's own alarm dispatches", async () => {
    const stub = fresh(plain, "runs");
    await runInDurableObject(stub, async (instance) => {
      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "past"
      });
      await instance.wake.alarm();
      expect(instance.marks).toEqual(["past"]);
    });
  });

  /**
   * A Durable Object has one physical alarm, and two deadlines over it must land
   * on the earlier — the whole reason a scheduler is worth having rather than
   * each caller reaching for `setAlarm`. Asserted against `storage.getAlarm()`
   * rather than against the schedule rows, because the rows are not what the
   * runtime wakes on.
   */
  it("points the one physical alarm at the earlier of two deadlines", async () => {
    const stub = fresh(plain, "earliest");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();

      const far = new Date(Date.now() + 3_600_000);
      const near = new Date(Date.now() + 60_000);

      await instance.wake.scheduler.set(far, "mark", { at: "far" });
      const afterFar = await state.storage.getAlarm();
      expect(afterFar).not.toBeNull();

      await instance.wake.scheduler.set(near, "mark", { at: "near" });
      const afterNear = await state.storage.getAlarm();

      expect(afterNear).not.toBeNull();
      expect(afterNear!).toBeLessThan(afterFar!);
      // Seconds are the scheduler's storage unit, so the alarm lands within one
      // of the requested moment rather than exactly on it.
      expect(Math.abs(afterNear! - near.getTime())).toBeLessThanOrEqual(1_000);
    });
  });

  it("clears the alarm once the last schedule is cancelled", async () => {
    const stub = fresh(plain, "cleared");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.wake.start();
      const only = await instance.wake.scheduler.set(
        new Date(Date.now() + 60_000),
        "mark",
        { at: "only" }
      );
      expect(await state.storage.getAlarm()).not.toBeNull();

      await instance.wake.scheduler.cancel(only.id);
      await instance.wake.rearm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("installScheduler — a host that owns its own alarm", () => {
  /**
   * The shape `starter`'s workspace object has. Both halves must run: the host's
   * own work on waking, and the schedules. A delegation that replaced one with
   * the other would pass any test that only looked at the half it kept.
   */
  it("runs the host's own alarm work and the schedules", async () => {
    const stub = fresh(delegating, "both");
    await runInDurableObject(stub, async (instance) => {
      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "past"
      });

      await instance.alarm();

      expect(instance.ownAlarms).toBe(1);
      expect(instance.marks).toEqual(["past"]);
    });
  });

  it("arms the physical alarm from a host that is only ever reached by RPC", async () => {
    const stub = fresh(delegating, "rpc");
    await runInDurableObject(stub, async (instance, state) => {
      // No `fetch` anywhere in this test, which is the point: native RPC bypasses
      // it, so `start()` is the only thing that migrates the scheduler's schema.
      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() + 60_000), "mark", {
        at: "later"
      });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe("installScheduler — booting on a legacy wake row", () => {
  /**
   * There is no storage migration, by decision, so this is the test that
   * decision rests on.
   *
   * Deployed objects hold a KV row called `"wake"` holding every deadline, and a
   * physical alarm armed against it. Nothing reads that row here, so such an
   * object boots with both still on disk: a row with no reader, and an alarm that
   * fires once into a handler with no schedule rows behind it. Neither may throw —
   * the runtime retries a throwing `alarm()` a bounded number of times and then
   * stops for good, which would take every *future* schedule down with the
   * orphan.
   */
  it("treats a leftover alarm with no schedules as a no-op, and still schedules after", async () => {
    const stub = fresh(plain, "dirty");
    await runInDurableObject(stub, async (instance, state) => {
      // Exactly what such an object holds: the row, and an alarm armed for it.
      await state.storage.put("wake", {
        "sync-retry:github": { key: "sync-retry:github", notBefore: 1 }
      });
      await state.storage.setAlarm(Date.now() - 1_000);

      await expect(instance.wake.alarm()).resolves.toBeUndefined();
      expect(instance.marks).toEqual([]);

      // And the object is not poisoned by what it found.
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "after"
      });
      await instance.wake.alarm();
      expect(instance.marks).toEqual(["after"]);
    });
  });

  /**
   * The orphaned row is left in place rather than drained, and nothing reads it.
   * Pinned so that "orphaned" stays a decision somebody made rather than a
   * detail somebody assumes.
   */
  it("leaves the orphaned row untouched", async () => {
    const stub = fresh(plain, "orphan");
    await runInDurableObject(stub, async (instance, state) => {
      const leftover = {
        "container-idle": { key: "container-idle", notBefore: 1 }
      };
      await state.storage.put("wake", leftover);

      await instance.wake.start();
      await instance.wake.scheduler.set(new Date(Date.now() - 1_000), "mark", {
        at: "x"
      });
      await instance.wake.alarm();

      expect(await state.storage.get("wake")).toEqual(leftover);
    });
  });
});

describe("installLifecycle — host jobs", () => {
  /**
   * A deadline that moves is a host job, and the host's `onJob` is found by
   * name: the fixture's method is the whole of the wiring.
   */
  it("delivers a due job to the host's onJob", async () => {
    await runInDurableObject(fresh(plain, "job"), async (instance) => {
      await instance.wake.jobs.push({
        id: "t:mark",
        fn: "mark",
        time: Date.now() - 1_000,
        payload: { at: "due" }
      });
      await instance.wake.alarm();
      expect(instance.marks).toEqual(["due"]);
      expect(instance.wake.jobs.get("t:mark")).toBeUndefined();
    });
  });

  it("delivers it through a host that owns its alarm and delegates", async () => {
    await runInDurableObject(fresh(delegating, "job"), async (instance) => {
      await instance.wake.jobs.push({
        id: "t:mark",
        fn: "mark",
        time: Date.now() - 1_000,
        payload: { at: "due" }
      });
      await instance.alarm();
      expect(instance.ownAlarms).toBe(1);
      expect(instance.marks).toEqual(["due"]);
    });
  });

  /**
   * An idle timer moved on every request is the busiest path in an object, so a
   * move must replace and never add. Asserted against `storage.getAlarm()` as
   * well as the queue, because the alarm is what the runtime wakes on: a
   * deadline pushed back that left it early would wake the object for nothing.
   */
  it("keeps one job per id however it moves, and the alarm with it", async () => {
    await runInDurableObject(fresh(plain, "moves"), async (instance, state) => {
      const move = (time: number) =>
        instance.wake.jobs.push({ id: "t:idle", fn: "mark", time });

      const now = Date.now();
      await move(now + 3_600_000);
      expect(await state.storage.getAlarm()).toBe(now + 3_600_000);
      await move(now + 60_000);
      expect(await state.storage.getAlarm()).toBe(now + 60_000);
      await move(now + 7_200_000);
      expect(await state.storage.getAlarm()).toBe(now + 7_200_000);

      expect(instance.wake.jobs.list()).toHaveLength(1);
      expect(instance.wake.jobs.get("t:idle")?.time).toBe(now + 7_200_000);

      await instance.wake.jobs.cancel("t:idle");
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  /**
   * A move written as a cancel and a set across awaits interleaves with another
   * move on the same id, because the input gate does not span the awaits, and
   * the loser's job is left behind with nothing holding it. Nothing here
   * serializes moves: a push is one statement, so they cannot interleave. This
   * pins that, and it fails as two jobs the day it stops being true.
   */
  it("leaves one job, at the last intent, when moves on one id overlap", async () => {
    await runInDurableObject(fresh(plain, "overlap"), async (instance) => {
      const now = Date.now();
      await Promise.all(
        [60_000, 120_000, 180_000].map((ahead) =>
          instance.wake.jobs.push({
            id: "t:idle",
            fn: "mark",
            time: now + ahead
          })
        )
      );
      expect(instance.wake.jobs.list()).toHaveLength(1);
      expect(instance.wake.jobs.get("t:idle")?.time).toBe(now + 180_000);
    });
  });
});
