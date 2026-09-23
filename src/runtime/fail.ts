import type { ResolveRuntimeContext } from "../contract/plugin.js";
import type { AgentRuntime } from "./index.js";

/**
 * Tell the plugin owning an execution that the Workflow gave up on it, and answer
 * what the plugin said the execution left behind — see `AgentPlugin.onFail`.
 *
 * Its `onFail` when it declares one, and its `onAbort` otherwise, so a plugin
 * whose cleanup is the same on both paths declares only that.
 *
 * Best-effort: the row is already failed when this runs, and a cleanup that went
 * wrong must not undo that. An empty answer is no answer.
 */
export async function failExecution(
  runtime: Pick<AgentRuntime, "pluginForType" | "onAbort">,
  ctx: ResolveRuntimeContext
): Promise<string | undefined> {
  try {
    const onFail = runtime.pluginForType(ctx.type)?.onFail;
    if (!onFail) {
      await runtime.onAbort(ctx);
      return undefined;
    }
    return (await onFail(ctx)) || undefined;
  } catch (err) {
    console.warn("[agent] plugin runtime release failed", {
      subtaskId: ctx.subtaskId,
      err: String(err)
    });
    return undefined;
  }
}
