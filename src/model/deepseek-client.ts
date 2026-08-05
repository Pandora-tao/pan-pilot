import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { lookup as systemLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
  ModelRequest,
  ModelToolCall,
} from "./model-client.js";

/** 供测试注入的最窄 SDK 边界，避免测试访问真实模型和网络。 */
export type CreateChatCompletion = (
  body: ChatCompletionCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
) => PromiseLike<ChatCompletion>;

export interface DeepSeekClientOptions {
  createCompletion?: CreateChatCompletion;
  model?: string;
}

/** 使用 OpenAI 兼容协议连接 DeepSeek，并把厂商响应转换为项目内部模型。 */
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

    const apiKey = process.env.DEEPSEEK_API_KEY;

    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required");
    }

    const baseURL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
    const apiHost = new URL(baseURL).hostname;
    const resolvedAddress = process.env.DEEPSEEK_RESOLVED_ADDRESS?.trim();

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
    const tools: ChatCompletionTool[] = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: request.messages.map(toProviderMessage),
      ...(tools.length === 0
        ? {}
        : { tools, tool_choice: "auto" as const }),
    };
    const response = await this.createCompletion(
      body,
      request.signal === undefined ? undefined : { signal: request.signal },
    );

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
