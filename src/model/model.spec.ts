import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { catalogModel } from "./catalog.js";
import { GATEWAY_METADATA_MAX, gatewayLogFields } from "./gateway-log.js";
import { workersAIModel } from "./workers-ai.js";

describe("gateway log fields", () => {
  it("leaves out what a call site does not know", () => {
    expect(gatewayLogFields({ agent: "generic", taskId: "" })).toEqual({
      metadata: { agent: "generic" }
    });
  });

  it("gives a task one exact handle for the Logs API", () => {
    expect(gatewayLogFields({ agent: "a", taskId: "t1" }).eventId).toBe("t1");
  });

  it("never spends more keys than the gateway keeps", () => {
    const { metadata } = gatewayLogFields({
      agent: "a",
      taskId: "t",
      phase: "subagent",
      subAgent: "Coder"
    });
    expect(Object.keys(metadata ?? {}).length).toBeLessThanOrEqual(
      GATEWAY_METADATA_MAX
    );
  });
});

describe("a Workers AI model", () => {
  /** A binding that records what it was asked, and answers something. */
  function recordingBinding() {
    const calls: { model: string; inputs: unknown; options: unknown }[] = [];
    const ai = {
      run: async (model: string, inputs: unknown, options: unknown) => {
        calls.push({ model, inputs, options });
        return { response: "ok" };
      }
    } as unknown as Ai;
    return { ai, calls };
  }

  it("carries the gateway, the affinity key and the reasoning budget to the binding", async () => {
    const { ai, calls } = recordingBinding();
    await generateText({
      model: workersAIModel(
        { AI: ai },
        {
          modelId: "@cf/test/model",
          gatewayId: "gw",
          reasoningEffort: "low",
          sessionAffinity: "caller-1",
          ...gatewayLogFields({ agent: "a", taskId: "t1" })
        }
      ),
      prompt: "hi"
    }).catch(() => undefined);

    expect(calls[0]?.model).toBe("@cf/test/model");
    // On the model's settings, never the provider's: a gateway on both keeps
    // the provider's alone and drops the metadata.
    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        gateway: {
          id: "gw",
          metadata: { agent: "a", taskId: "t1" },
          eventId: "t1"
        }
      })
    );
    expect(JSON.stringify(calls[0])).toContain("caller-1");
    expect(calls[0]?.inputs).toEqual(
      expect.objectContaining({ reasoning_effort: "low" })
    );
  });
});

describe("an AI Gateway catalog model", () => {
  /**
   * A binding on the run path, which answers a `Response` and not a parsed
   * body: the delegate asks for the raw reply so it can read a resume handle
   * off the headers before any provider parses it. The Workers AI binding
   * above answers the parsed shape instead, which is why these cannot share a
   * stub.
   */
  function recordingRunBinding() {
    const calls: { model: string; body: unknown; options: unknown }[] = [];
    const ai = {
      run: async (model: string, body: unknown, options: unknown) => {
        calls.push({ model, body, options });
        return Response.json({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }
    } as unknown as Ai;
    return { ai, calls };
  }

  it("addresses the provider by slug and carries the gateway to the binding", async () => {
    const { ai, calls } = recordingRunBinding();
    const result = await generateText({
      model: catalogModel(
        { AI: ai },
        {
          slug: "openai/gpt-6-luna",
          gatewayId: "gw",
          ...gatewayLogFields({ agent: "a", taskId: "t1", phase: "turn" })
        }
      ),
      prompt: "hi"
    });

    // The slug is what the binding is asked for, verbatim: it is the provider's
    // address, not a model name the body carries.
    expect(calls[0]?.model).toBe("openai/gpt-6-luna");
    // The same fields a Workers AI call sends, so one log filter matches both.
    expect(calls[0]?.options).toEqual(
      expect.objectContaining({
        gateway: {
          id: "gw",
          metadata: { agent: "a", taskId: "t1", phase: "turn" },
          eventId: "t1"
        }
      })
    );
    // **The assertion with teeth.** Everything above is identical if the
    // provider plugins are dropped — same slug, same gateway object — because a
    // Workers AI chat model gets built for the slug instead. What separates the
    // two is that only the catalog path reads a provider-shaped reply back:
    // without it the turn ends empty and throws nothing. So reading the text is
    // what proves the slug was routed and parsed, not merely dispatched.
    expect(result.text).toBe("ok");
    expect(result.finishReason).toBe("stop");
  });

  it("defaults to the account's `default` gateway", async () => {
    const { ai, calls } = recordingRunBinding();
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      prompt: "hi"
    });

    // No metadata and no event id either: a field the call site does not know
    // is left out, never sent as `undefined`.
    expect(calls[0]?.options).toEqual(
      expect.objectContaining({ gateway: { id: "default" } })
    );
  });
});
