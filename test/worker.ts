import { Agent } from "agents";
import { DurableObject } from "cloudflare:workers";
import { installScheduler } from "../src/alarm/index.js";
import { AgentDB, type AgentDBOptions } from "../src/db/db.js";
import {
  RecipeSubagentBase,
  type SubagentRuntime
} from "../src/subagent/index.js";

/**
 * The Worker under test.
 *
 * `@dynamicagents/core` is a library, not a Worker — but its Durable Object pieces
 * (`AgentDB` migrations, the subagent facet's own SQLite) can only be exercised
 * inside workerd. So this file is the minimal host that gives the pool something
 * to bind: a DO that owns an `AgentDB`, and a concrete subclass of the facet.
 *
 * It is deliberately thin. Anything richer belongs in `starter`, where a
 * real agent is the thing being tested rather than the harness.
 */

export class TestAgent extends Agent<Cloudflare.Env> {
  private _db?: AgentDB;

  db(options: AgentDBOptions = { maxSubtasks: 8 }): AgentDB {
    return (this._db ??= new AgentDB(this.ctx.storage, options));
  }

  /** Reset the memoized handle so a test can rebuild with different options. */
  resetDb(): void {
    this._db = undefined;
  }
}

/**
 * A concrete facet for the tests. The runtime is injected per test through
 * {@link setSubagentRuntime} rather than built from `env`, because what varies
 * across the subagent specs *is* the runtime.
 */
let testRuntime: SubagentRuntime | undefined;

export function setSubagentRuntime(runtime: SubagentRuntime): void {
  testRuntime = runtime;
}

export class TestSubagent extends RecipeSubagentBase<Cloudflare.Env> {
  protected subagentRuntime(): SubagentRuntime {
    if (!testRuntime) {
      throw new Error(
        "test subagent runtime not set — call setSubagentRuntime"
      );
    }
    return testRuntime;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("da-core test worker");
  }
} satisfies ExportedHandler<Cloudflare.Env>;

/**
 * Two plain Durable Objects for the `/alarm` specs, and the pair is the test.
 *
 * A lifecycle installs its runtime handlers only where the host does not
 * already have one, silently — so "the host defines its own `alarm()`" and "the
 * host does not" are two different installations of the same code, and only one
 * of them can be checked by reading it. {@link PlainScheduled} is the first,
 * {@link DelegatingScheduled} the second.
 */
export class PlainScheduled extends DurableObject<Cloudflare.Env> {
  /** In-memory, so a spec can see *that* a callback ran, not only its effect. */
  readonly marks: string[] = [];

  readonly wake = installScheduler(this, {
    callbacks: {
      mark: (payload: { at: string }) => {
        this.marks.push(payload.at);
      }
    }
  });
}

/** The shape `starter`'s workspace object has: its own `alarm()`, delegating. */
export class DelegatingScheduled extends DurableObject<Cloudflare.Env> {
  readonly marks: string[] = [];
  /** Proves the host's own handler still runs after the lifecycle takes over. */
  ownAlarms = 0;

  readonly wake = installScheduler(this, {
    callbacks: {
      mark: (payload: { at: string }) => {
        this.marks.push(payload.at);
      }
    },
    delegates: ["alarm"]
  });

  override async alarm(): Promise<void> {
    this.ownAlarms += 1;
    await this.wake.alarm();
  }
}
