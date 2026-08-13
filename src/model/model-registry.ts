import { DeepSeekClient } from "./deepseek-client.js";
import type { ModelClient } from "./model-client.js";

export const VOLCENGINE_DEEPSEEK_V4_FLASH =
  "volcengine/deepseek-v4-flash";
export const VOLCENGINE_DEEPSEEK_V4_PRO =
  "volcengine/deepseek-v4-pro";
export const DEEPSEEK_OFFICIAL_V4_FLASH =
  "deepseek/deepseek-v4-flash";
export const DEEPSEEK_OFFICIAL_V4_PRO =
  "deepseek/deepseek-v4-pro";
export const DEFAULT_CHAT_MODEL_ID = VOLCENGINE_DEEPSEEK_V4_FLASH;
const DEEPSEEK_V4_FLASH = "deepseek-v4-flash";
const DEEPSEEK_V4_PRO = "deepseek-v4-pro";

export type ChatModelStatus = "available" | "unavailable";

export interface ChatModelDescriptor {
  id: string;
  provider: "volcengine" | "deepseek" | "injected";
  label: string;
  upstreamModel: string;
  status: ChatModelStatus;
  reason?: "missing_api_key";
}

export interface ChatModelEntry {
  descriptor: ChatModelDescriptor;
  client?: ModelClient;
}

export interface ResolvedChatModel {
  descriptor: ChatModelDescriptor & { status: "available" };
  client: ModelClient;
}

export class UnsupportedChatModelError extends Error {
  constructor(readonly modelId: string) {
    super(`Unsupported chat model: ${modelId}`);
    this.name = "UnsupportedChatModelError";
  }
}

export class UnavailableChatModelError extends Error {
  constructor(readonly modelId: string) {
    super(`Chat model is unavailable: ${modelId}`);
    this.name = "UnavailableChatModelError";
  }
}

/**
 * PanPilot 对外只接受稳定 modelId；注册表把它解析为固定供应商客户端。
 * resolve() 每轮只调用一次，后续工具循环始终复用同一个 ModelClient。
 */
export class ChatModelRegistry {
  private readonly entries = new Map<string, ChatModelEntry>();

  constructor(
    entries: readonly ChatModelEntry[],
    readonly defaultModelId: string,
  ) {
    for (const entry of entries) {
      if (this.entries.has(entry.descriptor.id)) {
        throw new Error(`Duplicate chat model id: ${entry.descriptor.id}`);
      }
      this.entries.set(entry.descriptor.id, entry);
    }
    if (!this.entries.has(defaultModelId)) {
      throw new Error(`Unknown default chat model id: ${defaultModelId}`);
    }
    if (this.entries.get(defaultModelId)?.client === undefined) {
      throw new Error(`Default chat model is unavailable: ${defaultModelId}`);
    }
  }

  list(): readonly ChatModelDescriptor[] {
    return [...this.entries.values()].map(({ descriptor }) => ({ ...descriptor }));
  }

  resolve(requestedModelId?: string): ResolvedChatModel {
    const modelId = requestedModelId?.trim() || this.defaultModelId;
    const entry = this.entries.get(modelId);
    if (!entry) throw new UnsupportedChatModelError(modelId);
    if (!entry.client) throw new UnavailableChatModelError(modelId);
    return {
      descriptor: { ...entry.descriptor, status: "available" },
      client: entry.client,
    };
  }
}

type ModelRegistryEnv = Readonly<Record<string, string | undefined>>;

export function createChatModelRegistry(
  env: ModelRegistryEnv = process.env,
): ChatModelRegistry {
  const volcengineKey = trimmed(env.VOLCENGINE_API_KEY);
  const deepseekKey = trimmed(env.DEEPSEEK_API_KEY);
  const entries: ChatModelEntry[] = [
    providerEntry({
      id: VOLCENGINE_DEEPSEEK_V4_FLASH,
      provider: "volcengine",
      label: "火山方舟 · DeepSeek V4 Flash",
      upstreamModel: DEEPSEEK_V4_FLASH,
      apiKey: volcengineKey,
      baseURL: trimmed(env.VOLCENGINE_BASE_URL)
        ?? "https://ark.cn-beijing.volces.com/api/coding/v3",
      resolvedAddress: trimmed(env.VOLCENGINE_CHAT_RESOLVED_ADDRESS),
    }),
    providerEntry({
      id: VOLCENGINE_DEEPSEEK_V4_PRO,
      provider: "volcengine",
      label: "火山方舟 · DeepSeek V4 Pro",
      upstreamModel: DEEPSEEK_V4_PRO,
      apiKey: volcengineKey,
      baseURL: trimmed(env.VOLCENGINE_BASE_URL)
        ?? "https://ark.cn-beijing.volces.com/api/coding/v3",
      resolvedAddress: trimmed(env.VOLCENGINE_CHAT_RESOLVED_ADDRESS),
    }),
    providerEntry({
      id: DEEPSEEK_OFFICIAL_V4_FLASH,
      provider: "deepseek",
      label: "DeepSeek 官方 · V4 Flash",
      upstreamModel: DEEPSEEK_V4_FLASH,
      apiKey: deepseekKey,
      baseURL: trimmed(env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com",
      resolvedAddress: trimmed(env.DEEPSEEK_RESOLVED_ADDRESS),
    }),
    providerEntry({
      id: DEEPSEEK_OFFICIAL_V4_PRO,
      provider: "deepseek",
      label: "DeepSeek 官方 · V4 Pro",
      upstreamModel: DEEPSEEK_V4_PRO,
      apiKey: deepseekKey,
      baseURL: trimmed(env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com",
      resolvedAddress: trimmed(env.DEEPSEEK_RESOLVED_ADDRESS),
    }),
  ];
  const defaultModelId = trimmed(env.PAN_PILOT_DEFAULT_MODEL_ID)
    ?? DEFAULT_CHAT_MODEL_ID;
  return new ChatModelRegistry(entries, defaultModelId);
}

/** 测试或嵌入调用方保留单 ModelClient 注入能力。 */
export function createInjectedChatModelRegistry(
  client: ModelClient,
  modelId = DEFAULT_CHAT_MODEL_ID,
): ChatModelRegistry {
  return new ChatModelRegistry([{
    descriptor: {
      id: modelId,
      provider: "injected",
      label: "Injected chat model",
      upstreamModel: "injected",
      status: "available",
    },
    client,
  }], modelId);
}

function providerEntry(options: {
  id: string;
  provider: "volcengine" | "deepseek";
  label: string;
  upstreamModel: string;
  apiKey: string | undefined;
  baseURL: string;
  resolvedAddress: string | undefined;
}): ChatModelEntry {
  const descriptor: ChatModelDescriptor = {
    id: options.id,
    provider: options.provider,
    label: options.label,
    upstreamModel: options.upstreamModel,
    status: options.apiKey ? "available" : "unavailable",
    ...(options.apiKey ? {} : { reason: "missing_api_key" as const }),
  };
  return {
    descriptor,
    ...(options.apiKey
      ? {
          client: new DeepSeekClient({
            model: options.upstreamModel,
            apiKey: options.apiKey,
            baseURL: options.baseURL,
            ...(options.resolvedAddress === undefined
              ? {}
              : { resolvedAddress: options.resolvedAddress }),
          }),
        }
      : {}),
  };
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
