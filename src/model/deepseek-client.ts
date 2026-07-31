import OpenAI from "openai";
import { lookup as systemLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
} from "./model-client.js";

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
            fetch: undiciFetch as unknown as typeof globalThis.fetch,
            fetchOptions: { dispatcher },
          }),
    });
  }

  async complete(messages: readonly ModelMessage[]): Promise<ModelCompletion> {
    const response = await this.client.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
      messages: [...messages],
    });

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
