import type { TaskStore } from "@a2a-js/sdk/server";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import {
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
  type Task
} from "@a2a-js/sdk";
import type { GatekeeperIdentity } from "./verify.js";
import type { AgentResolver } from "./agent-stub.js";

/**
 * A durable {@link TaskStore} for the a2a-js `DefaultRequestHandler`, backed by
 * the caller's agent Durable Object (via native RPC) instead of the SDK's
 * per-request `InMemoryTaskStore`.
 *
 * Task state must survive the accept → async callback gap (and answer
 * `GetTask`/`CancelTask`/`ListTasks` across requests), so it lives in the same
 * per-caller DO that runs the task's turns — keyed by the verified
 * `identity.key`, exactly like {@link file://./executor.ts A2AExecutor}. The
 * agent settles the same rows, so this store and the turns share one source of
 * truth.
 *
 * v1.0 passes a `ServerCallContext` to every method so a shared store can scope
 * rows by tenant/owner. This store needs none of that: the DO instance it routes
 * to *is* the scope, resolved from the caller identity the Worker verified, so a
 * task is unreachable from any other caller by construction.
 */
export class DurableTaskStore implements TaskStore {
  constructor(
    private readonly identity: GatekeeperIdentity,
    private readonly resolveAgent: AgentResolver
  ) {}

  async load(taskId: string): Promise<Task | undefined> {
    return (
      (await this.resolveAgent(this.identity).getTask(taskId)) ?? undefined
    );
  }

  async save(task: Task): Promise<void> {
    await this.resolveAgent(this.identity).saveTask(task);
  }

  /**
   * `ListTasks` (new in v1.0): this caller's tasks, newest first, with the
   * spec's optional `contextId` / `status` / `statusTimestampAfter` filters
   * applied in SQL.
   *
   * The page token is the row offset as a decimal string. Offset paging can skip
   * or repeat a row if tasks are written mid-scan, which is acceptable here: the
   * listing is a diagnostic view over an append-mostly table, and the alternative
   * (a keyset cursor) buys stability this caller has no use for.
   *
   * An agent whose DO does not implement `listTasks` answers the RPC with the
   * protocol's own "unsupported" error rather than a binding-level failure — the
   * capability is genuinely optional.
   */
  async list(params: ListTasksRequest): Promise<ListTasksResponse> {
    const agent = this.resolveAgent(this.identity);
    if (!agent.listTasks) {
      throw new UnsupportedOperationError({
        message: "this agent does not support ListTasks"
      });
    }

    const pageSize = clampPageSize(params.pageSize);
    const offset = parseOffset(params.pageToken);

    const { tasks, totalSize } = await agent.listTasks({
      contextId: params.contextId,
      // The proto default (`UNSPECIFIED`) is the spec's "no status filter".
      state:
        params.status === TaskState.TASK_STATE_UNSPECIFIED
          ? undefined
          : params.status,
      updatedAfter: parseTimestamp(params.statusTimestampAfter),
      includeArtifacts: params.includeArtifacts === true,
      historyLength: params.historyLength,
      limit: pageSize,
      offset
    });

    const nextOffset = offset + tasks.length;
    return {
      tasks,
      nextPageToken: nextOffset < totalSize ? String(nextOffset) : "",
      pageSize,
      totalSize
    };
  }
}

/** Page size bounds from the `ListTasks` spec: default 50, min 1, max 100. */
function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return 50;
  return Math.min(100, Math.max(1, Math.trunc(pageSize)));
}

/** Row offset from a page token; an unparseable token restarts at the first page. */
function parseOffset(pageToken: string): number {
  const offset = Number.parseInt(pageToken, 10);
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

/**
 * `statusTimestampAfter` (ISO 8601) as epoch milliseconds, matching the
 * `updated_at` column the store filters on — that column is stamped on every
 * status write, so it tracks `status.timestamp`.
 */
function parseTimestamp(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}
