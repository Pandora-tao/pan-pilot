import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { lookup as systemLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { AgentToolDefinition } from "../tools/tool.js";
import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
} from "./model-client.js";

/**
 * 供测试注入的最窄 SDK 边界，避免测试访问真实模型和网络。
 * 流式请求返回 AsyncIterable 增量，非流式请求返回完整 ChatCompletion。
 */
export type CreateChatCompletion = (
  body: ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming,
  options?: { signal?: AbortSignal },
) => PromiseLike<ChatCompletion | AsyncIterable<ChatCompletionChunk>>;

export interface DeepSeekClientOptions {
  createCompletion?: CreateChatCompletion;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  resolvedAddress?: string;
}

type ChatProviderEnv = Readonly<Record<string, string | undefined>>;

/**
 * 方舟主对话与图片理解共用同一把 VOLCENGINE_API_KEY；非方舟地址继续使用
 * DEEPSEEK_API_KEY，保留原有直连 DeepSeek 的兼容能力。
 */
export function resolveChatApiKey(
  baseURL: string,
  env: ChatProviderEnv = process.env,
): string | undefined {
  const hostname = new URL(baseURL).hostname.toLowerCase();
  const isVolcengine = hostname === "volces.com"
    || hostname.endsWith(".volces.com");
  return isVolcengine
    ? env.VOLCENGINE_API_KEY ?? env.DEEPSEEK_API_KEY
    : env.DEEPSEEK_API_KEY;
}

/** 使用 OpenAI 兼容协议连接主对话模型，并把厂商响应转换为项目内部模型。 */
export class DeepSeekClient implements ModelClient {
  private readonly createCompletion: CreateChatCompletion;
  private readonly model: string;

  constructor(options: DeepSeekClientOptions = {}) {
    this.model = options.model
      ?? process.env.DEEPSEEK_MODEL
      ?? "deepseek-v4-flash";

    if (options.createCompletion) {
      this.createCompletion = options.createCompletion;
      return;
    }

    const baseURL = options.baseURL
      ?? process.env.DEEPSEEK_BASE_URL
      ?? "https://api.deepseek.com";
    const apiKey = options.apiKey ?? resolveChatApiKey(baseURL);

    if (!apiKey) {
      throw new Error(
        "VOLCENGINE_API_KEY or DEEPSEEK_API_KEY is required for the chat provider",
      );
    }

    const apiHost = new URL(baseURL).hostname;
    const resolvedAddress = options.resolvedAddress
      ?? process.env.DEEPSEEK_RESOLVED_ADDRESS?.trim();

    /*
     * 某些部署环境的 DNS 可能无法正确解析 DeepSeek。
     * 这里仅替换目标主机的 DNS 结果，URL 中的域名仍然保留，因此 HTTP Host、
     * TLS SNI 和证书校验仍以原域名为准；其他主机继续使用系统 DNS。
     */
    const dispatcher = resolvedAddress
      ? new Agent({
          connect: {
            lookup(hostname, options, callback) {
              if (hostname !== apiHost) {
                systemLookup(hostname, options, callback);
                return;
              }
              const family = isIP(resolvedAddress);
              if (!family) {
                callback(new Error("DEEPSEEK_RESOLVED_ADDRESS must be an IP address"), "", 0);
                return;
              }
              // Node/Undici 的 lookup 既可能请求单个地址，也可能请求完整地址数组。
              if (typeof options === "object" && options.all) {
                callback(null, [{ address: resolvedAddress, family }]);
                return;
              }
              callback(null, resolvedAddress, family);
            },
          },
        })
      : undefined;

    const client = new OpenAI({
      apiKey,
      baseURL,
      ...(dispatcher === undefined
        ? {}
        : {
            // OpenAI SDK 通过 fetch 发请求；显式换成 Undici fetch 才能传入 dispatcher。
            fetch: undiciFetch as unknown as typeof globalThis.fetch,
            fetchOptions: { dispatcher },
          }),
    });
    this.createCompletion = (body, requestOptions) =>
      client.chat.completions.create(body, requestOptions);
  }

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    const tools = toProviderTools(request.tools);
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: request.messages.map(toProviderMessage),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_tokens: request.maxOutputTokens }),
      ...(tools.length === 0
        ? {}
        : { tools, tool_choice: "auto" as const }),
    };
    const response = await this.createCompletion(
      body,
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    if (!isChatCompletion(response)) {
      throw new Error(
        "Model client returned a streaming response for a non-streaming request",
      );
    }

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("Model returned no message");
    }

    const toolCalls = (message.tool_calls ?? []).map(toModelToolCall);
    const content = message.content?.trim() ?? "";

    // 工具调用阶段通常没有正文；只有两者同时为空才是无效模型响应。
    if (!content && toolCalls.length === 0) {
      throw new Error("Model returned neither content nor tool calls");
    }

    const totalTokens = response.usage?.total_tokens;
    return {
      content,
      toolCalls,
      model: response.model,
      ...(totalTokens === undefined ? {} : { totalTokens }),
    };
  }

  async *completeStream(
    request: ModelRequest,
  ): AsyncGenerator<ModelStreamEvent> {
    const tools = toProviderTools(request.tools);
    const body: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: request.messages.map(toProviderMessage),
      stream: true,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_tokens: request.maxOutputTokens }),
      // 兼容 OpenAI 的 usage 汇总：最后一个 chunk 会带完整 token 统计。
      stream_options: { include_usage: true },
      ...(tools.length === 0
        ? {}
        : { tools, tool_choice: "auto" as const }),
    };
    const stream = await this.createCompletion(
      body,
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    if (!isAsyncIterable(stream)) {
      throw new Error(
        "Model client returned a non-streaming response for a streaming request",
      );
    }

    // OpenAI 兼容协议把工具调用拆成多个增量：按 index 累积 id/name/arguments 片段。
    const toolCallDeltas = new Map<
      number,
      { id?: string; name: string; arguments: string }
    >();
    let content = "";
    let totalTokens: number | undefined;
    let model = "";

    for await (const chunk of stream) {
      let emittedVisibleContent = false;
      model = chunk.model;
      if (chunk.usage?.total_tokens !== undefined) {
        totalTokens = chunk.usage.total_tokens;
      }

      const choice = chunk.choices[0];
      if (!choice) {
        yield { type: "activity" };
        continue;
      }

      const delta = choice.delta;
      if (delta?.content) {
        content += delta.content;
        emittedVisibleContent = true;
        yield { type: "content", content: delta.content };
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        const current = toolCallDeltas.get(toolCall.index)
          ?? { name: "", arguments: "" };
        if (toolCall.id !== undefined && toolCall.id !== null) {
          current.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          current.name += toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          current.arguments += toolCall.function.arguments;
        }
        toolCallDeltas.set(toolCall.index, current);
      }

      // 工具参数、推理内容、usage 及厂商保活块都属于真实上游活动。
      // 只发无内容的内部事件，让 Agent 刷新空闲计时；绝不透传原始分片。
      if (!emittedVisibleContent) {
        yield { type: "activity" };
      }
    }

    const toolCalls: ModelToolCall[] = [...toolCallDeltas.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, delta]) => {
        if (!delta.id) {
          throw new Error("Model returned tool call without id");
        }
        if (!delta.name) {
          throw new Error("Model returned tool call without name");
        }
        return {
          id: delta.id,
          name: delta.name,
          arguments: parseToolArguments(delta.arguments),
        };
      });

    const finalContent = content.trim();

    // 工具调用阶段通常没有正文；只有两者同时为空才是无效模型响应。
    if (!finalContent && toolCalls.length === 0) {
      throw new Error("Model returned neither content nor tool calls");
    }

    yield {
      type: "completion",
      completion: {
        content: finalContent,
        toolCalls,
        model,
        ...(totalTokens === undefined ? {} : { totalTokens }),
      },
    };
  }
}

function toProviderTools(tools: readonly AgentToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function isChatCompletion(
  value: ChatCompletion | AsyncIterable<ChatCompletionChunk>,
): value is ChatCompletion {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChatCompletion>;
  return Array.isArray(candidate.choices);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
    === "function";
}

function toProviderMessage(message: ModelMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    case "assistant": {
      const toolCalls = message.toolCalls ?? [];
      return {
        role: "assistant",
        content: message.content,
        ...(toolCalls.length === 0
          ? {}
          : {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: stringifyToolArguments(call),
                },
              })),
            }),
      };
    }
  }
}

function toModelToolCall(call: ChatCompletionMessageToolCall): ModelToolCall {
  if (call.type !== "function") {
    throw new Error(`Unsupported tool call type: ${call.type}`);
  }
  return {
    id: call.id,
    name: call.function.name,
    arguments: parseToolArguments(call.function.arguments),
  };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Model returned invalid tool arguments JSON", {
      cause: error,
    });
  }
}

function stringifyToolArguments(call: ModelToolCall): string {
  let value: string | undefined;
  try {
    value = JSON.stringify(call.arguments);
  } catch (error) {
    throw new Error(`Tool call ${call.id} has non-serializable arguments`, {
      cause: error,
    });
  }
  if (value === undefined) {
    throw new Error(`Tool call ${call.id} has non-serializable arguments`);
  }
  return value;
}
