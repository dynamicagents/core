import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ThinkSession } from "@cloudflare/think";

/**
 * The tools core gives every agent, as opposed to the ones a plugin gives.
 *
 * Each is here for the same reason: it is part of the **lifecycle**, not part of
 * a domain. `ask_user` is how a task reaches `input-required`; `search_history`
 * is how a compacted conversation stays readable. A tool about a domain belongs
 * to the plugin that owns that domain.
 *
 * The delegating ones — a sub-agent's tool, and `check_back` — are not here:
 * each closes over the agent that owns the work ledger, so they are built as
 * methods on it.
 */

/**
 * Ask the caller something, and stop.
 *
 * **No `execute`, deliberately.** The turn ends with the call unanswered, the
 * submission completes, and the answer arrives as the next user message —
 * Think's documented pattern. `needsApproval` would park the submission as
 * pending instead, which is a different lifecycle and not this one.
 *
 * The turn must also carry `hasToolCall("ask_user")` in its `stopWhen`, or the
 * loop runs another step on a turn that is waiting for a person.
 */
export function askUserTool(): Tool {
  return tool({
    description:
      "Ask the caller a question and stop. The answer arrives as their next " +
      "message. Offer options when the answer is a choice between known things.",
    inputSchema: z.object({
      question: z.string().min(1),
      options: z
        .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
        .optional()
    })
  });
}

/** How many past messages one `search_history` call may bring back. */
const SEARCH_LIMIT = { min: 1, max: 20, default: 5 } as const;

/**
 * Full-text search over this conversation's own history.
 *
 * What it replaces is a vector index over a copy of the messages, and the
 * reason it can is that Think's compaction is **non-destructive**: the original
 * rows stay in the session and stay indexed, so a message folded into a summary
 * is still findable verbatim. A second store of the same text would have to be
 * kept in step with that one, and could only ever be a worse copy of it.
 */
export function searchHistoryTool(session: () => ThinkSession): Tool {
  return tool({
    description:
      "Search everything said earlier in this conversation, including messages " +
      "that have since been summarized. Use it before saying you do not " +
      "remember something.",
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z
        .number()
        .int()
        .min(SEARCH_LIMIT.min)
        .max(SEARCH_LIMIT.max)
        .optional()
    }),
    execute: async ({ query, limit }) => ({
      results: await session().search(query, {
        limit: limit ?? SEARCH_LIMIT.default
      })
    })
  });
}
