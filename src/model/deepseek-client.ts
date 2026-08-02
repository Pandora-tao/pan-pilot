import OpenAI from "openai";
import { lookup as systemLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
} from "./model-client.js";

/** 使用 OpenAI 兼容协议连接 DeepSeek，并把厂商响应转换为项目内部模型。 */
export class DeepSeekClient implements ModelClient {
  private readonly client: OpenAI;

  constructor() {
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

    this.client = new OpenAI({
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
  }

  async complete(messages: readonly ModelMessage[]): Promise<ModelCompletion> {
    const response = await this.client.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
      // 对外接收只读数组，传给 SDK 时复制一份，避免放宽 Agent 层的可变性约束。
      messages: [...messages],
    });

    // 上层只处理有效文本；空响应在模型边界直接转成明确错误。
    const content = response.choices[0]?.message.content?.trim() ?? "";
    if (!content) {
      throw new Error("Model returned an empty response");
    }

    const totalTokens = response.usage?.total_tokens;
    return {
      content,
      model: response.model,
      ...(totalTokens === undefined ? {} : { totalTokens }),
    };
  }
}
