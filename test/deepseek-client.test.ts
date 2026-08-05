import { describe, expect, it, vi } from "vitest";
import type { ChatCompletion } from "openai/resources/chat/completions";
import {
  DeepSeekClient,
  type CreateChatCompletion,
} from "../src/model/deepseek-client.js";

describe("DeepSeekClient tool protocol", () => {
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
