import type { Tool, ToolSet } from "ai";
import type { z } from "zod";
import {
  FINAL_REPLY_TOOL_NAME,
  finalReplyInputSchema,
  finalReplyTool
} from "./final-reply.js";
import {
  ASK_USER_TOOL_NAME,
  askUserInputSchema,
  askUserTool
} from "./ask-user.js";
import type { ReferenceCatalogEntry } from "../subtasks/catalog.js";
import {
  makeDecompositionProposalSchema,
  resolveDecomposition
} from "../subtasks/decomposition.js";
import { DELEGATE_TOOL_NAME, makeDelegateTool } from "../subtasks/delegate.js";
import type { SubtaskTypeRegistry } from "../subtasks/subtask-types.js";
import type { SubtaskDraft } from "../subtasks/types.js";
import type { SubtaskParams } from "../contract/recipe.js";

/**
 * The **control tools** — the calls that end a round — and the one thing they all
 * need that the SDK cannot do for them: checking their own input.
 *
 * A work tool carries an `execute`, so the SDK validates its input against the
 * tool's schema, runs it, and feeds any failure — bad input, unknown tool, a throw
 * from inside — back into the loop as a failed tool result. The model sees what
 * went wrong and gets to try again, for free, for every work tool that exists or
 * ever will.
 *
 * A control tool has no `execute`. The call *is* the round's output, so the loop
 * halts on it and none of that machinery runs: **its input is never validated at
 * all**. That is not a subtlety, it is a hole. A `final_reply` whose `text` was
 * blank passed `nonBlank` untouched and was delivered to the user as an empty
 * message; a `delegate` whose payload was not a decomposition at all reached
 * {@link resolveDecomposition} and failed there on a raw `TypeError`.
 *
 * So each control tool declares a {@link ControlTool.parse}, and the round runs it
 * where the SDK would have: between the call and any use of it. `parse` either
 * produces the {@link TurnDecision} or throws, and a throw is handed straight back
 * to the model as a failed result for that call — the same repair loop, from the
 * same shape of feedback, that a work tool gets from the SDK. Adding a control tool
 * means writing its `parse`; it inherits validation and repair by existing.
 */

/** What one round decided. */
export type TurnDecision =
  | { kind: "reply"; text: string }
  | { kind: "delegate"; reply: string; drafts: SubtaskDraft[] }
  /** Stop, and put `question` to the person the Task is for. */
  | { kind: "ask"; question: string; options?: string[] };

/**
 * Thrown by a {@link ControlTool.parse} for a call the round cannot use.
 *
 * Its `message` is written for the **model**, not for a log: it is what comes back
 * in the failed tool result, and it is the only thing the next attempt knows about
 * why this one was rejected. Say what was wrong with the call.
 */
export class ControlCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlCallError";
  }
}

/** One control tool: what the model sees, and how the round reads what comes back. */
export interface ControlTool {
  /** The tool's name, as declared to the model. */
  readonly name: string;
  /** The tool as the model sees it — no `execute`, by definition. */
  readonly tool: Tool;
  /**
   * How this ending competes with another emitted in the same step. The highest
   * precedence among the tools actually called wins, and the rest are dropped.
   *
   * It ranks by **commitment**: `delegate` starts durable work that a reply cannot
   * undo, so a `delegate` alongside a `final_reply` means the reply is the
   * acknowledgment *for* that work, not an answer instead of it. `ask_user`
   * outranks both, because asking starts nothing: a question beside a `delegate`
   * holds the work back until the answer is in, rather than starting work the
   * answer might have changed.
   */
  readonly precedence: number;
  /**
   * Pick the one call that counts out of **every** call the attempt made to this
   * tool, or throw a {@link ControlCallError} if a repeat is itself the error.
   *
   * Separate from {@link ControlTool.parse} because what a repeat means is the
   * tool's own business — a second `delegate` would start a second batch of durable
   * work and is refused, while a repeated `final_reply` is just the model restating
   * its answer and the last one stands — and the round needs that answer *before* it
   * has a decision: the call it shows back to the model in a repair has to be the
   * same one validation rejected, not whichever happened to come first.
   *
   * Never called with an empty array: a tool with no calls did not end the round.
   */
  select(inputs: readonly unknown[]): unknown;
  /**
   * Turn the selected call into the round's decision, or throw a
   * {@link ControlCallError} describing what is wrong with it.
   *
   * The input is `unknown` on purpose. Nothing has checked it yet — that is this
   * method's job, and typing it as anything else would be the assumption that
   * caused the hole this interface exists to close.
   */
  parse(input: unknown): TurnDecision;
}

/**
 * The control tools for one round, in the order the model is shown them.
 *
 * Built per round rather than defined once, because validating a `delegate` needs
 * this round's reference catalog — the same values the model was shown as
 * `[ref N]` markers, which is what makes "reference 4" checkable at all.
 *
 * `delegate` is withheld from a `final` round, which has no budget left to spend on
 * work. `final_reply` is declared on every round including that one: withhold both
 * and the round has no legal way to end. `ask_user` is declared only where the
 * caller says the round may ask.
 */
export function controlTools(opts: {
  catalog: ReferenceCatalogEntry[];
  /** Whether this round may still hand out work (`false` on a `final` round). */
  delegable: boolean;
  /**
   * Whether this round may stop and ask the person. The caller decides: the
   * agent's policy has to allow it, and a `final` round never may.
   */
  askable?: boolean;
  /** The installed subtask types — what `delegate` may name. */
  types: SubtaskTypeRegistry;
  /** `CoreConfig.maxSubtasks`, the per-round fan-out bound. */
  maxSubtasks: number;
}): ControlTool[] {
  const tools: ControlTool[] = [
    {
      name: FINAL_REPLY_TOOL_NAME,
      tool: finalReplyTool,
      precedence: 0,
      // The last call of a repeated set: a model that restated its answer meant
      // the restatement.
      select: (inputs) => inputs.at(-1),
      parse(input) {
        const parsed = finalReplyInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new ControlCallError(
            `${FINAL_REPLY_TOOL_NAME} input is invalid — ${issues(parsed.error)}`
          );
        }
        return { kind: "reply", text: parsed.data.text.trim() };
      }
    }
  ];

  // A round with no registered types has nothing to delegate to, so `delegate`
  // is withheld for the same reason a `final` round withholds it: the tool would
  // advertise an empty enum the model has no legal way to satisfy.
  if (opts.delegable && opts.types.keys.length > 0) {
    const proposalSchema = makeDecompositionProposalSchema(
      opts.types,
      opts.maxSubtasks
    );
    tools.push({
      name: DELEGATE_TOOL_NAME,
      tool: makeDelegateTool(opts.types, opts.maxSubtasks),
      precedence: 1,
      select(inputs) {
        if (inputs.length > 1) {
          throw new ControlCallError(
            `${DELEGATE_TOOL_NAME} was called ${inputs.length} times in one turn. ` +
              `Delegate once, with every subtask this round needs in that single call.`
          );
        }
        return inputs[0];
      },
      parse(input) {
        const parsed = proposalSchema.safeParse(input);
        if (!parsed.success) {
          throw new ControlCallError(
            `${DELEGATE_TOOL_NAME} input is invalid — ${issues(parsed.error)}`
          );
        }
        // Everything past the schema — unknown reference indexes, a type's
        // required params — throws its own error, already worded for the model.
        const { reply, drafts } = resolveDecomposition(
          {
            ...parsed.data,
            subtasks: parsed.data.subtasks.map((s) => ({
              ...s,
              params: definedParams(s.params)
            }))
          },
          opts.catalog,
          opts.types
        );
        return { kind: "delegate", reply, drafts };
      }
    });
  }

  if (opts.askable) {
    tools.push({
      name: ASK_USER_TOOL_NAME,
      tool: askUserTool,
      precedence: 2,
      select(inputs) {
        // The person answers one question at a time, and the gatekeeper holds
        // one open prompt per Task — a second would never be shown.
        if (inputs.length > 1) {
          throw new ControlCallError(
            `${ASK_USER_TOOL_NAME} was called ${inputs.length} times in one turn. ` +
              `Ask one question, with everything you need to know in it.`
          );
        }
        return inputs[0];
      },
      parse(input) {
        const parsed = askUserInputSchema.safeParse(input);
        if (!parsed.success) {
          throw new ControlCallError(
            `${ASK_USER_TOOL_NAME} input is invalid — ${issues(parsed.error)}`
          );
        }
        const question = parsed.data.question.trim();
        const options = parsed.data.options?.map((o) => o.trim());
        if (
          options &&
          new Set(options.map((o) => o.toLowerCase())).size !== options.length
        ) {
          throw new ControlCallError(
            `${ASK_USER_TOOL_NAME} options must differ from one another — ` +
              `the person cannot tell two identical answers apart.`
          );
        }
        return { kind: "ask", question, ...(options ? { options } : {}) };
      }
    });
  }

  return tools;
}

/**
 * Drop params the model sent as an explicit `undefined`.
 *
 * The delegate schema declares the union of every type's param keys, all optional,
 * so one tool schema can serve every type (see
 * `SubtaskTypeRegistry.paramProperties`). A model that names a key and leaves it
 * empty has sent no param, and forwarding the key with an `undefined` value would
 * only make a missing required param report itself as a *present* one. Whether
 * what survives satisfies the type is still
 * `SubtaskTypeRegistry.validateParams`'s call, downstream.
 */
function definedParams(
  params: Record<string, string | undefined> | undefined
): SubtaskParams | undefined {
  if (!params) return undefined;
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  return entries.length > 0
    ? (Object.fromEntries(entries) as SubtaskParams)
    : undefined;
}

/**
 * A zod failure as one line the model can act on: which field, and what was wrong.
 * The same rendering
 * {@link file://../subtasks/subtask-types.ts SubtaskTypeRegistry.validateParams}
 * uses, so every rejection a control call can produce reads the same way.
 */
function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** The tools as the SDK takes them, in declaration order. */
export function controlToolSet(tools: ControlTool[]): ToolSet {
  return Object.fromEntries(tools.map((c) => [c.name, c.tool]));
}
