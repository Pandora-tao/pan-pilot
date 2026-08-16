import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";
import {
  DeepSeekClient,
  resolveChatApiKey,
  type CreateChatCompletion,
} from "../src/model/deepseek-client.js";

describe("chat provider configuration", () => {
  it("prefers the Volcengine key for an Ark base URL", () => {
    expect(resolveChatApiKey(
      "https://ark.cn-beijing.volces.com/api/coding/v3",
      { VOLCENGINE_API_KEY: "ark-key", DEEPSEEK_API_KEY: "deepseek-key" },
    )).toBe("ark-key");
  });

  it("keeps the DeepSeek key for non-Volcengine providers", () => {
    expect(resolveChatApiKey(
      "https://api.deepseek.com",
      { VOLCENGINE_API_KEY: "ark-key", DEEPSEEK_API_KEY: "deepseek-key" },
    )).toBe("deepseek-key");
  });

  it("falls back to the compatibility key when the Ark key is absent", () => {
    expect(resolveChatApiKey(
      "https://ark.cn-beijing.volces.com/api/coding/v3",
      { DEEPSEEK_API_KEY: "compatibility-key" },
    )).toBe("compatibility-key");
  });
});

describe("DeepSeekClient tool protocol", () => {
  it("forwards a bounded max output token setting", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      completion({ content: "摘要", refusal: null, role: "assistant" }, 8),
    );
    const client = new DeepSeekClient({ createCompletion, model: "request-model" });

    await client.complete({
      messages: [{ role: "user", content: "压缩" }],
      tools: [],
      maxOutputTokens: 321,
    });

    expect(createCompletion).toHaveBeenCalledWith({
      model: "request-model",
      messages: [{ role: "user", content: "压缩" }],
      max_tokens: 321,
    }, undefined);
  });

  it("maps a text completion without exposing tools", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      completion({ content: "  你好  ", refusal: null, role: "assistant" }, 12),
    );
    const client = new DeepSeekClient({
      createCompletion,
      model: "request-model",
    });

    await expect(client.complete({
      messages: [{ role: "user", content: "你好" }],
      tools: [],
    })).resolves.toEqual({
      content: "你好",
      toolCalls: [],
      model: "response-model",
      totalTokens: 12,
    });
    expect(createCompletion).toHaveBeenCalledWith({
      model: "request-model",
      messages: [{ role: "user", content: "你好" }],
    }, undefined);
  });

  it("maps tool definitions, conversation messages and tool calls", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      completion({
        content: null,
        refusal: null,
        role: "assistant",
        tool_calls: [{
          id: "call-time",
          type: "function",
          function: {
            name: "get_current_time",
            arguments: "{\"timeZone\":\"Asia/Shanghai\"}",
          },
        }],
      }),
    );
    const client = new DeepSeekClient({
      createCompletion,
      model: "request-model",
    });
    const controller = new AbortController();

    const result = await client.complete({
      messages: [
        { role: "user", content: "六乘七，再告诉我时间" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call-calc",
            name: "calculator",
            arguments: { operation: "multiply", left: 6, right: 7 },
          }],
        },
        {
          role: "tool",
          toolCallId: "call-calc",
          name: "calculator",
          content: "{\"result\":42}",
        },
      ],
      tools: [{
        name: "get_current_time",
        description: "获取当前时间",
        parameters: { type: "object", additionalProperties: false },
      }],
      signal: controller.signal,
    });

    expect(result).toEqual({
      content: "",
      toolCalls: [{
        id: "call-time",
        name: "get_current_time",
        arguments: { timeZone: "Asia/Shanghai" },
      }],
      model: "response-model",
    });
    expect(createCompletion).toHaveBeenCalledWith({
      model: "request-model",
      messages: [
        { role: "user", content: "六乘七，再告诉我时间" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-calc",
            type: "function",
            function: {
              name: "calculator",
              arguments: "{\"operation\":\"multiply\",\"left\":6,\"right\":7}",
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-calc",
          content: "{\"result\":42}",
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "get_current_time",
          description: "获取当前时间",
          parameters: { type: "object", additionalProperties: false },
        },
      }],
      tool_choice: "auto",
    }, { signal: controller.signal });
  });

  it("rejects malformed tool argument JSON", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      completion({
        content: null,
        refusal: null,
        role: "assistant",
        tool_calls: [{
          id: "call-bad",
          type: "function",
          function: { name: "calculator", arguments: "{bad json" },
        }],
      }),
    );
    const client = new DeepSeekClient({ createCompletion });

    await expect(client.complete({ messages: [], tools: [] }))
      .rejects.toThrow("Model returned invalid tool arguments JSON");
  });

  it("rejects a response with neither text nor tool calls", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      completion({ content: null, refusal: null, role: "assistant" }),
    );
    const client = new DeepSeekClient({ createCompletion });

    await expect(client.complete({ messages: [], tools: [] }))
      .rejects.toThrow("Model returned neither content nor tool calls");
  });

  it("rejects a streaming response for a non-streaming request", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      streamOf([]),
    );
    const client = new DeepSeekClient({ createCompletion });

    await expect(client.complete({ messages: [], tools: [] }))
      .rejects.toThrow(
        "Model client returned a streaming response for a non-streaming request",
      );
  });
});

describe("DeepSeekClient streaming", () => {
  it("yields content deltas and a final completion with usage", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      streamOf([
        chunk({
          choices: [{ delta: { content: "你" }, finish_reason: null, index: 0 }],
        }),
        chunk({
          choices: [{ delta: { content: "好" }, finish_reason: null, index: 0 }],
        }),
        chunk({
          choices: [],
          usage: {
            completion_tokens: 3,
            prompt_tokens: 4,
            total_tokens: 7,
          },
        }),
      ]),
    );
    const client = new DeepSeekClient({
      createCompletion,
      model: "request-model",
    });

    const events: unknown[] = [];
    for await (const event of client.completeStream({
      messages: [{ role: "user", content: "你好" }],
      tools: [],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "content", content: "你" },
      { type: "content", content: "好" },
      { type: "activity" },
      {
        type: "completion",
        completion: {
          content: "你好",
          toolCalls: [],
          model: "response-model",
          totalTokens: 7,
        },
      },
    ]);
    expect(createCompletion).toHaveBeenCalledWith({
      model: "request-model",
      messages: [{ role: "user", content: "你好" }],
      stream: true,
      stream_options: { include_usage: true },
    }, undefined);
  });

  it("accumulates split tool call deltas across chunks", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      streamOf([
        chunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-calc",
                function: { name: "calculator", arguments: "" },
              }],
            },
            finish_reason: null,
            index: 0,
          }],
        }),
        chunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "{\"operation\":\"a" },
              }],
            },
            finish_reason: null,
            index: 0,
          }],
        }),
        chunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: "dd\"}" },
              }],
            },
            finish_reason: "tool_calls",
            index: 0,
          }],
        }),
      ]),
    );
    const client = new DeepSeekClient({ createCompletion });
    const controller = new AbortController();

    const events: unknown[] = [];
    for await (const event of client.completeStream({
      messages: [{ role: "user", content: "六加七" }],
      tools: [{
        name: "calculator",
        description: "计算",
        parameters: { type: "object", additionalProperties: false },
      }],
      signal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "activity" },
      { type: "activity" },
      { type: "activity" },
      {
        type: "completion",
        completion: {
          content: "",
          toolCalls: [{
            id: "call-calc",
            name: "calculator",
            arguments: { operation: "add" },
          }],
          model: "response-model",
        },
      },
    ]);
    expect(createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        stream_options: { include_usage: true },
        tools: [{
          type: "function",
          function: {
            name: "calculator",
            description: "计算",
            parameters: { type: "object", additionalProperties: false },
          },
        }],
        tool_choice: "auto",
      }),
      { signal: controller.signal },
    );
  });

  it("rejects malformed tool argument JSON in a stream", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      streamOf([
        chunk({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-bad",
                function: { name: "calculator", arguments: "{bad json" },
              }],
            },
            finish_reason: null,
            index: 0,
          }],
        }),
      ]),
    );
    const client = new DeepSeekClient({ createCompletion });

    await expect(async () => {
      for await (const _ of client.completeStream({
        messages: [],
        tools: [],
      })) {
        // 消费完整个流才会触发参数解析。
      }
    }).rejects.toThrow("Model returned invalid tool arguments JSON");
  });

  it("rejects a stream with neither text nor tool calls", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      streamOf([]),
    );
    const client = new DeepSeekClient({ createCompletion });

    await expect(async () => {
      for await (const _ of client.completeStream({
        messages: [],
        tools: [],
      })) {
        // 空流不会有任何事件。
      }
    }).rejects.toThrow("Model returned neither content nor tool calls");
  });

  it("never forwards provider reasoning content to the client", async () => {
    const createCompletion = vi.fn<CreateChatCompletion>().mockResolvedValue(
      streamOf([
        chunk({
          choices: [{
            // 部分厂商会把原始思维链放在 reasoning_content；协议只转发可见正文。
            delta: {
              content: "",
              reasoning_content: "内部思维链：不应暴露给客户端",
            } as ChatCompletionChunk["choices"][number]["delta"],
            finish_reason: null,
            index: 0,
          }],
        }),
        chunk({
          choices: [{
            delta: { content: "可见回答" },
            finish_reason: "stop",
            index: 0,
          }],
        }),
      ]),
    );
    const client = new DeepSeekClient({ createCompletion });

    const events: unknown[] = [];
    for await (const event of client.completeStream({
      messages: [{ role: "user", content: "你好" }],
      tools: [],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "activity" },
      { type: "content", content: "可见回答" },
      {
        type: "completion",
        completion: {
          content: "可见回答",
          toolCalls: [],
          model: "response-model",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("思维链");
  });
});

function completion(
  message: ChatCompletion["choices"][number]["message"],
  totalTokens?: number,
): ChatCompletion {
  return {
    id: "chatcmpl-test",
    choices: [{
      finish_reason: message.tool_calls?.length ? "tool_calls" : "stop",
      index: 0,
      logprobs: null,
      message,
    }],
    created: 0,
    model: "response-model",
    object: "chat.completion",
    ...(totalTokens === undefined
      ? {}
      : {
          usage: {
            completion_tokens: 5,
            prompt_tokens: totalTokens - 5,
            total_tokens: totalTokens,
          },
        }),
  };
}

function chunk(overrides: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [{ delta: { content: "" }, finish_reason: null, index: 0 }],
    created: 0,
    model: "response-model",
    object: "chat.completion.chunk",
    ...overrides,
  };
}

async function* streamOf(
  chunks: readonly ChatCompletionChunk[],
): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk;
}
