import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { GATEWAY_METADATA_MAX, gatewayLogFields } from "./gateway-log.js";
import { workersAIModel } from "./workers-ai.js";

describe("gateway log fields", () => {
  it("leaves out what a call site does not know", () => {
    expect(gatewayLogFields({ agent: "reactive", taskId: "" })).toEqual({
      metadata: { agent: "reactive" }
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
