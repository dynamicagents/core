/**
 * `@dynamicagents/core/task` — the task host.
 *
 * {@link TaskHost} owns a caller's A2A tasks behind core's edge: the ledger,
 * the push channel, the delivery outbox, cancellation and the transcript's
 * settle. A consumer's host subclasses it with its words ({@link A2ACopy}), the
 * binding of the workflow that runs its tasks (`/workflow`), and its own.
 */

export { TaskHost, type A2ACopy } from "./host.js";
