import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type {
  MultimodalAnalysis,
  MultimodalClient,
  MultimodalRequest,
} from "./multimodal-client.js";

/**
 * 供测试注入的最窄 SDK 边界，避免测试访问真实模型和网络。
 * 与 DeepSeekClient 的 CreateChatCompletion 同构，但只走非流式多模态请求。
 */
export type CreateMultimodalCompletion = (
  body: ChatCompletionCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
) => PromiseLike<ChatCompletion>;

/**
 * 与 OpenAI SDK ClientOptions.fetch 结构兼容的传输函数。
 * init 额外携带 undici dispatcher（代理场景由 EnvHttpProxyAgent 提供）。
 */
export type MultimodalFetch = (
  input: string | URL | Request,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

export interface VolcengineMultimodalClientOptions {
  /** 图片通道测试传输；保留原名以兼容已有注入代码。 */
  createCompletion?: CreateMultimodalCompletion;
  /** 音频通道测试传输；省略时复用 createCompletion。 */
  createAudioCompletion?: CreateMultimodalCompletion;
  model?: string;
  baseUrl?: string;
  audioModel?: string;
  audioBaseUrl?: string;
  /** 测试注入的传输实现；默认 undici fetch（代理环境自动 EnvHttpProxyAgent）。 */
  fetchImpl?: MultimodalFetch | undefined;
}

export interface MultimodalTransport {
  /** 是否启用代理传输（仅布尔值，可安全记录；代理值/密钥绝不落日志）。 */
  proxyEnabled: boolean;
  /** 代理 fetch 包装器；无代理环境为 undefined，保持 SDK 默认直连。 */
  fetch: MultimodalFetch | undefined;
}

/**
 * 依据标准代理环境变量决定传输配置：
 * - 存在 http_proxy/HTTP_PROXY/https_proxy/HTTPS_PROXY 之一时，用 undici
 *   EnvHttpProxyAgent 包裹 fetch，让 OpenAI SDK 遵循上述变量以及
 *   no_proxy/NO_PROXY（EnvHttpProxyAgent 内部处理，大小写不敏感）；
 * - 无代理环境返回空配置（现有直连行为不变）。
 */
export function buildMultimodalTransport(
  options: { fetchImpl?: MultimodalFetch | undefined } = {},
): MultimodalTransport {
  if (!hasProxyEnv()) {
    return { proxyEnabled: false, fetch: undefined };
  }
  // undici 的 fetch 是完整实现但其 Response 类型与 DOM 类型结构不等价，
  // 经 unknown 窄化到本模块的传输签名（运行时行为不变）。
  const fetchImpl = options.fetchImpl
    ?? (undiciFetch as unknown as MultimodalFetch);
  const proxyAgent = new EnvHttpProxyAgent();
  return {
    proxyEnabled: true,
    fetch: (input, init) =>
      fetchImpl(input, { ...(init ?? {}), dispatcher: proxyAgent }),
  };
}

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
] as const;

function hasProxyEnv(): boolean {
  return PROXY_ENV_NAMES.some((name) => {
    const value = process.env[name];
    return value !== undefined && value.trim() !== "";
  });
}

const DEFAULT_IMAGE_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
// 用户指定的模型字符串，必须精确保持（点号分隔，不要改写成连字符形式）。
const DEFAULT_IMAGE_MODEL = "doubao-seed-2.1-turbo";
// 官方音频理解文档指定的版本；音频不走 Coding Plan 端点。
const DEFAULT_AUDIO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_AUDIO_MODEL = "doubao-seed-2-0-lite-260428";

/**
 * 火山方舟 OpenAI 兼容多模态实现。
 *
 * 图片走 Coding Plan + `image_url`；音频走标准方舟端点 + `input_audio`。
 * 音频模型需要账号单独开通，不能因为它出现在 Coding Plan 模型列表中就
 * 假定该端点接受音频输入。凭据只从环境变量读取，不落日志。
 */
export class VolcengineMultimodalClient implements MultimodalClient {
  private readonly createImageCompletion: CreateMultimodalCompletion;
  private readonly createAudioCompletion: CreateMultimodalCompletion;
  private readonly imageModel: string;
  private readonly audioModel: string;

  constructor(options: VolcengineMultimodalClientOptions = {}) {
    this.imageModel = options.model
      ?? process.env.VOLCENGINE_MULTIMODAL_MODEL
      ?? DEFAULT_IMAGE_MODEL;
    this.audioModel = options.audioModel
      ?? process.env.VOLCENGINE_AUDIO_MODEL
      ?? DEFAULT_AUDIO_MODEL;

    const apiKey = process.env.VOLCENGINE_API_KEY;
    const injectedImage = options.createCompletion;
    const injectedAudio = options.createAudioCompletion ?? injectedImage;
    if ((!injectedImage || !injectedAudio) && !apiKey) {
      throw new Error("VOLCENGINE_API_KEY is required");
    }
    const transport = buildMultimodalTransport({
      fetchImpl: options.fetchImpl,
    });

    if (injectedImage) {
      this.createImageCompletion = injectedImage;
    } else {
      const imageClient = new OpenAI({
        apiKey: apiKey!,
        baseURL: options.baseUrl
          ?? process.env.VOLCENGINE_BASE_URL
          ?? DEFAULT_IMAGE_BASE_URL,
        ...(transport.fetch === undefined
          ? {}
          : { fetch: transport.fetch }),
      });
      this.createImageCompletion = (body, requestOptions) =>
        imageClient.chat.completions.create(body, requestOptions);
    }

    if (injectedAudio) {
      this.createAudioCompletion = injectedAudio;
    } else {
      const audioClient = new OpenAI({
        apiKey: process.env.VOLCENGINE_AUDIO_API_KEY ?? apiKey!,
        baseURL: options.audioBaseUrl
          ?? process.env.VOLCENGINE_AUDIO_BASE_URL
          ?? DEFAULT_AUDIO_BASE_URL,
        ...(transport.fetch === undefined
          ? {}
          : { fetch: transport.fetch }),
      });
      this.createAudioCompletion = (body, requestOptions) =>
        audioClient.chat.completions.create(body, requestOptions);
    }
  }

  async analyze(request: MultimodalRequest): Promise<MultimodalAnalysis> {
    request.signal?.throwIfAborted();

    const isAudio = request.kind === "audio";
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: isAudio ? this.audioModel : this.imageModel,
      messages: [toUserMessage(request)],
    };
    const createCompletion = isAudio
      ? this.createAudioCompletion
      : this.createImageCompletion;
    const response = await createCompletion(
      body,
      request.signal === undefined ? undefined : { signal: request.signal },
    );

    const content = response.choices[0]?.message.content?.trim() ?? "";
    if (!content) {
      throw new Error("多模态模型没有返回文本内容");
    }
    const totalTokens = response.usage?.total_tokens;
    return {
      content,
      model: response.model,
      ...(totalTokens === undefined ? {} : { totalTokens }),
    };
  }
}

/** 按媒体类型构造 OpenAI 兼容的 user 消息内容数组。 */
function toUserMessage(request: MultimodalRequest): ChatCompletionMessageParam {
  if (request.kind === "image") {
    return {
      role: "user",
      content: [
        { type: "text", text: request.prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:${request.mimeType};base64,${request.dataBase64}`,
          },
        },
      ],
    };
  }

  // 音频只支持协议确认的 wav/mp3（与 openai SDK 的 input_audio format 一致）。
  if (request.format !== "wav" && request.format !== "mp3") {
    throw new Error(`不支持的音频格式: ${request.format}`);
  }
  return {
    role: "user",
    content: [
      { type: "text", text: request.prompt },
      {
        type: "input_audio",
        input_audio: { data: request.dataBase64, format: request.format },
      },
    ],
  };
}
