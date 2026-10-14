import { describe, it, expect } from "vitest";
import { generateText, streamText } from "ai";
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
   * stub. It answers in whichever wire format it was asked in: a Responses
   * body carries `input`, a Chat Completions one `messages`.
   */
  function recordingRunBinding() {
    const calls: {
      model: string;
      body: Record<string, unknown>;
      options: unknown;
    }[] = [];
    const ai = {
      run: async (
        model: string,
        body: Record<string, unknown>,
        options: unknown
      ) => {
        calls.push({ model, body, options });
        return Response.json(
          "input" in body
            ? {
                id: "resp_test",
                object: "response",
                created_at: 0,
                status: "completed",
                model,
                output: [
                  {
                    type: "message",
                    id: "msg_test",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "ok", annotations: [] }
                    ]
                  }
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
              }
            : {
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
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2
                }
              }
        );
      }
    } as unknown as Ai;
    return { ai, calls };
  }

  it("addresses the provider by slug and carries the gateway to the binding", async () => {
    const { ai, calls } = recordingRunBinding();
    await generateText({
      model: catalogModel(
        { AI: ai },
        {
          slug: "openai/gpt-6-luna",
          gatewayId: "gw",
          ...gatewayLogFields({ agent: "a", taskId: "t1", phase: "turn" })
        }
      ),
      prompt: "hi"
    }).catch(() => undefined);

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
  });

  it("re-sends a Workers AI turn's tool-call ids in a form the provider accepts", async () => {
    const { ai, calls } = recordingRunBinding();
    // As `workers-ai-provider` records an id a Workers AI model emitted.
    const recorded =
      "call_0dcda0c4f6e64789828c7114::cf-wai-tool-call::hulRjjfhxbteJDA2";
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: recorded,
              toolName: "read",
              input: {}
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: recorded,
              toolName: "read",
              output: { type: "text", value: "done" }
            }
          ]
        }
      ]
    }).catch(() => undefined);

    const sent = calls[0]?.body as { input: { call_id?: string }[] };
    const resent = "call_0dcda0c4f6e64789828c7114_hulRjjfhxbteJDA2";
    expect(sent.input[1]?.call_id).toBe(resent);
    expect(sent.input[2]?.call_id).toBe(resent);
    // OpenAI's ceiling on a tool-call id.
    expect(resent.length).toBeLessThanOrEqual(64);
  });

  it("writes an OpenAI slug as an unstored Responses request on the run path", async () => {
    const { ai, calls } = recordingRunBinding();
    await generateText({
      model: catalogModel(
        { AI: ai },
        { slug: "openai/gpt-6-luna", sessionAffinity: "caller-1" }
      ),
      prompt: "hi",
      providerOptions: { openai: { reasoningEffort: "max" } }
    });

    const body = calls[0]?.body;
    expect(body).toHaveProperty("input");
    expect(body).not.toHaveProperty("messages");
    expect(body).toEqual(
      expect.objectContaining({
        store: false,
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: "caller-1",
        reasoning: expect.objectContaining({ effort: "max" })
      })
    );
  });

  it("lets a caller's own `store` win", async () => {
    const { ai, calls } = recordingRunBinding();
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      prompt: "hi",
      providerOptions: { openai: { store: true } }
    });

    expect(calls[0]?.body.store).toBe(true);
  });

  it("keeps Chat Completions for another OpenAI-wire provider", async () => {
    const { ai, calls } = recordingRunBinding();
    await generateText({
      model: catalogModel(
        { AI: ai },
        { slug: "xai/grok-4", sessionAffinity: "caller-1" }
      ),
      prompt: "hi"
    });

    expect(calls[0]?.model).toBe("xai/grok-4");
    expect(calls[0]?.body).toHaveProperty("messages");
    expect(calls[0]?.body).not.toHaveProperty("store");
    expect(calls[0]?.body).not.toHaveProperty("prompt_cache_key");
  });

  it("defaults to the account's `default` gateway", async () => {
    const { ai, calls } = recordingRunBinding();
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      prompt: "hi"
    }).catch(() => undefined);

    expect(calls[0]?.options).toEqual(
      expect.objectContaining({ gateway: { id: "default" } })
    );
  });

  it("streams a Responses reply on the run path, and resumes it where it broke", async () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }]
    };
    const response = {
      id: "resp_1",
      object: "response",
      created_at: 0,
      model: "gpt-6-luna",
      output: []
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress" }
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] }
      },
      ...["o", "k"].map((delta) => ({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta,
        logprobs: []
      })),
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: { ...response, status: "completed", output: [message], usage }
      }
    ].map(
      (e, sequence_number) =>
        `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`
    );
    // The connection drops after the first delta; the gateway's buffer holds
    // the rest.
    const delivered = 3;
    const resumed: string[] = [];
    let read = 0;
    const ai = {
      run: async () =>
        new Response(
          // Pulled, not enqueued up front: an error discards a queue nobody
          // has read yet.
          new ReadableStream({
            pull(controller) {
              if (read < delivered)
                controller.enqueue(new TextEncoder().encode(events[read++]));
              else controller.error(new Error("Network connection lost."));
            }
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "cf-aig-run-id": "run-1"
            }
          }
        ),
      fetch: async (url: string) => {
        resumed.push(url);
        const from = Number(new URL(url).searchParams.get("from"));
        return new Response(events.slice(from).join(""), {
          headers: { "content-type": "text/event-stream" }
        });
      }
    } as unknown as Ai;

    const result = streamText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      prompt: "hi"
    });

    expect(await result.text).toBe("ok");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain("/run/run-1/resume");
    expect(new URL(resumed[0] ?? "").searchParams.get("from")).toBe(
      String(delivered)
    );
  });
});
