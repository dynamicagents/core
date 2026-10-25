import { describe, it, expect } from "vitest";
import { generateText, streamText } from "ai";
import { catalogModel } from "./catalog.js";
import { GATEWAY_METADATA_MAX, gatewayLogFields } from "./gateway-log.js";
import { workersAIModel } from "./workers-ai.js";

/** As a Workers AI turn's tool-call id was recorded before `createAI`. */
const MARKED_TOOL_CALL_ID =
  "call_0dcda0c4f6e64789828c7114::cf-wai-tool-call::hulRjjfhxbteJDA2";
/** The same id as every provider will take it back. */
const RESENT_TOOL_CALL_ID = "call_0dcda0c4f6e64789828c7114_hulRjjfhxbteJDA2";

/** A history that re-sends one tool call, as a stored conversation does. */
const RESENT_HISTORY = [
  { role: "user" as const, content: "read it" },
  {
    role: "assistant" as const,
    content: [
      {
        type: "tool-call" as const,
        toolCallId: MARKED_TOOL_CALL_ID,
        toolName: "read",
        input: {}
      }
    ]
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: MARKED_TOOL_CALL_ID,
        toolName: "read",
        output: { type: "text" as const, value: "done" }
      }
    ]
  }
];

/** One OpenAI Responses reply, as the provider's own parser reads it. */
function responsesReply(model: string) {
  return {
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
        content: [{ type: "output_text", text: "ok", annotations: [] }]
      }
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
}

/** One Chat Completions reply, for a slug on the run path. */
function chatCompletionsReply(model: string) {
  return {
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
  };
}

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

/**
 * A binding that records what each of its two transports was asked.
 *
 * `run` is the run path, which both Workers AI ids and catalog slugs take, and
 * which is asked for the raw reply so a resume handle can be read off the
 * headers before any provider parses it. `fetch` is both the provider-native
 * path a model object takes and the run path's own resume route, told apart by
 * the URL.
 */
function recordingBinding(reply: (model: string) => unknown) {
  const run: {
    model: string;
    input: Record<string, unknown>;
    options: Record<string, unknown>;
  }[] = [];
  const native: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  const ai = {
    run: async (
      model: string,
      input: Record<string, unknown>,
      options: Record<string, unknown>
    ) => {
      run.push({ model, input, options });
      return Response.json(reply(model) as Record<string, unknown>);
    },
    fetch: async (url: string, init: RequestInit) => {
      const body = init.body;
      native.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof body === "string" ? JSON.parse(body) : body
      });
      return Response.json(
        reply(String((typeof body === "string" ? JSON.parse(body) : {}).model))
      );
    }
  } as unknown as Ai;
  return { ai, run, native };
}

describe("a Workers AI model", () => {
  it("carries the gateway, the affinity key and the reasoning budget to the binding", async () => {
    const { ai, run } = recordingBinding(chatCompletionsReply);
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

    expect(run[0]?.model).toBe("@cf/test/model");
    expect(run[0]?.options).toEqual(
      expect.objectContaining({
        gateway: expect.objectContaining({
          id: "gw",
          metadata: { agent: "a", taskId: "t1" },
          eventId: "t1"
        })
      })
    );
    // The affinity key rides a header rather than the body.
    expect(JSON.stringify(run[0]?.options)).toContain("caller-1");
    expect(run[0]?.input).toEqual(
      expect.objectContaining({ reasoning_effort: "low" })
    );
  });

  /**
   * The configured effort is a default, and the provider resolves a model-level
   * one *above* the call's `reasoning` — so passing it on the model would make
   * compaction's `reasoning: "none"` a no-op and put the 120-second cost that
   * switch exists to avoid back on every compaction.
   */
  it("lets a call's own reasoning switch win over the configured effort", async () => {
    const { ai, run } = recordingBinding(chatCompletionsReply);
    await generateText({
      model: workersAIModel(
        { AI: ai },
        { modelId: "@cf/test/model", reasoningEffort: "high" }
      ),
      prompt: "summarize",
      reasoning: "none"
    }).catch(() => undefined);

    const input = (run[0]?.input ?? {}) as {
      reasoning_effort?: unknown;
      chat_template_kwargs?: { enable_thinking?: boolean };
    };
    // The configured effort does not reach the request...
    expect(JSON.stringify(input)).not.toContain("high");
    // ...and the switch the call asked for does, in whichever spelling the
    // provider's compat layer uses for the model: `reasoning_effort: null`, or
    // a chat-template flag for a model that reads one instead.
    expect(
      input.reasoning_effort === null ||
        input.chat_template_kwargs?.enable_thinking === false
    ).toBe(true);
  });

  it("keeps the configured effort when the call names the provider's default", async () => {
    const { ai, run } = recordingBinding(chatCompletionsReply);
    await generateText({
      model: workersAIModel(
        { AI: ai },
        { modelId: "@cf/test/model", reasoningEffort: "high" }
      ),
      prompt: "hi",
      reasoning: "provider-default"
    }).catch(() => undefined);

    expect(run[0]?.input).toEqual(
      expect.objectContaining({ reasoning_effort: "high" })
    );
  });

  it("re-sends an earlier turn's tool-call ids in a form the provider accepts", async () => {
    const { ai, run } = recordingBinding(chatCompletionsReply);
    await generateText({
      model: workersAIModel({ AI: ai }, { modelId: "@cf/test/model" }),
      messages: RESENT_HISTORY
    }).catch(() => undefined);

    // Nothing strips the marker on the way out any more, so the rewrite has to
    // hold on this path too.
    const sent = JSON.stringify(run[0]?.input);
    expect(sent).toContain(RESENT_TOOL_CALL_ID);
    expect(sent).not.toContain("::cf-wai-tool-call::");
  });
});

describe("an AI Gateway catalog model", () => {
  it("addresses a non-OpenAI provider by slug on the run path", async () => {
    const { ai, run, native } = recordingBinding(chatCompletionsReply);
    await generateText({
      model: catalogModel(
        { AI: ai },
        {
          slug: "xai/grok-4",
          gatewayId: "gw",
          ...gatewayLogFields({ agent: "a", taskId: "t1", phase: "turn" })
        }
      ),
      prompt: "hi"
    });

    // The slug is what the binding is asked for, verbatim: it is the provider's
    // address, not a model name the body carries.
    expect(run[0]?.model).toBe("xai/grok-4");
    expect(native).toHaveLength(0);
    // The same fields a Workers AI call sends, so one log filter matches both.
    expect(run[0]?.options).toEqual(
      expect.objectContaining({
        gateway: expect.objectContaining({
          id: "gw",
          metadata: { agent: "a", taskId: "t1", phase: "turn" },
          eventId: "t1"
        })
      })
    );
    // Chat Completions, and none of the Responses defaults.
    expect(run[0]?.input).toHaveProperty("messages");
    expect(run[0]?.input).not.toHaveProperty("store");
    expect(run[0]?.input).not.toHaveProperty("prompt_cache_key");
  });

  it("defaults to the account's `default` gateway", async () => {
    const { ai, run } = recordingBinding(chatCompletionsReply);
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "xai/grok-4" }),
      prompt: "hi"
    });

    expect(run[0]?.options).toEqual(
      expect.objectContaining({
        gateway: expect.objectContaining({ id: "default" })
      })
    );
  });

  it("sends an OpenAI slug to the provider's own endpoint, carrying no credential", async () => {
    const { ai, run, native } = recordingBinding(responsesReply);
    await generateText({
      model: catalogModel(
        { AI: ai },
        {
          slug: "openai/gpt-6-luna",
          gatewayId: "gw",
          ...gatewayLogFields({ agent: "a", taskId: "t1" })
        }
      ),
      prompt: "hi"
    });

    // The provider-native path, addressed by provider and endpoint rather than
    // by slug, and never the run path.
    expect(run).toHaveLength(0);
    expect(native[0]?.url).toContain("/gateways/gw/openai/");
    expect(native[0]?.url).toContain("responses");
    // The vendor's model id, which the gateway requires verbatim.
    expect(native[0]?.body).toEqual(
      expect.objectContaining({ model: "gpt-6-luna" })
    );
    // The placeholder key `@ai-sdk/openai` was built with does not leave the
    // Worker: `vendorKey: "gateway"` is what drops it.
    const sentHeaders = Object.keys(native[0]?.headers ?? {}).map((name) =>
      name.toLowerCase()
    );
    expect(sentHeaders).not.toContain("authorization");
    expect(sentHeaders).not.toContain("x-api-key");
    expect(JSON.stringify(native[0]?.headers)).not.toContain("unused");
    // The log fields reach this transport as the gateway's own headers.
    expect(native[0]?.headers["cf-aig-metadata"]).toBe(
      JSON.stringify({ agent: "a", taskId: "t1" })
    );
    expect(native[0]?.headers["cf-aig-event-id"]).toBe("t1");
  });

  it("writes an OpenAI slug as an unstored Responses request", async () => {
    const { ai, native } = recordingBinding(responsesReply);
    await generateText({
      model: catalogModel(
        { AI: ai },
        { slug: "openai/gpt-6-luna", sessionAffinity: "caller-1" }
      ),
      prompt: "hi",
      providerOptions: { openai: { reasoningEffort: "max" } }
    });

    const body = native[0]?.body;
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
    const { ai, native } = recordingBinding(responsesReply);
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      prompt: "hi",
      providerOptions: { openai: { store: true } }
    });

    expect(native[0]?.body).toEqual(expect.objectContaining({ store: true }));
  });

  it("re-sends a Workers AI turn's tool-call ids in a form the provider accepts", async () => {
    const { ai, native } = recordingBinding(responsesReply);
    await generateText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      messages: RESENT_HISTORY
    });

    const sent = native[0]?.body as { input: { call_id?: string }[] };
    expect(sent.input[1]?.call_id).toBe(RESENT_TOOL_CALL_ID);
    expect(sent.input[2]?.call_id).toBe(RESENT_TOOL_CALL_ID);
    // OpenAI's ceiling on a tool-call id.
    expect(RESENT_TOOL_CALL_ID.length).toBeLessThanOrEqual(64);
  });

  it("streams a run-path reply, and resumes it where it broke", async () => {
    const chunk = (delta: string) =>
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "grok-4",
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
      });
    const events = [
      `data: ${chunk("o")}\n\n`,
      `data: ${chunk("k")}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "grok-4",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`,
      "data: [DONE]\n\n"
    ];
    // The connection drops after the first delta; the gateway's buffer holds
    // the rest.
    const delivered = 1;
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
      model: catalogModel({ AI: ai }, { slug: "xai/grok-4" }),
      prompt: "hi"
    });

    expect(await result.text).toBe("ok");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toContain("/run/run-1/resume");
    expect(new URL(resumed[0] ?? "").searchParams.get("from")).toBe(
      String(delivered)
    );
  });

  it("does not resume an OpenAI stream, so a broken one is the turn's to recover", async () => {
    const sent: string[] = [];
    const ai = {
      run: async () => {
        throw new Error("the run path is not this model's transport");
      },
      fetch: async (url: string) => {
        sent.push(url);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: response.created\ndata: ${JSON.stringify({
                    type: "response.created",
                    sequence_number: 0,
                    response: {
                      id: "resp_1",
                      object: "response",
                      created_at: 0,
                      status: "in_progress",
                      model: "gpt-6-luna",
                      output: []
                    }
                  })}\n\n`
                )
              );
              controller.error(new Error("Network connection lost."));
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      }
    } as unknown as Ai;

    const result = streamText({
      model: catalogModel({ AI: ai }, { slug: "openai/gpt-6-luna" }),
      prompt: "hi"
    });

    // The provider-native path carries no run id, so there is nothing to resume
    // from and the request is made once. The turn it broke is Think's to
    // continue on the next wake.
    await expect(result.text).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });
});
