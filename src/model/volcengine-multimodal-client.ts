import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
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

export interface VolcengineMultimodalClientOptions {
  /** 图片通道测试传输；保留原名以兼容已有注入代码。 */
  createCompletion?: CreateMultimodalCompletion;
  /** 音频通道测试传输；省略时复用 createCompletion。 */
  createAudioCompletion?: CreateMultimodalCompletion;
  model?: string;
  baseUrl?: string;
  audioModel?: string;
  audioBaseUrl?: string;
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

    if (injectedImage) {
      this.createImageCompletion = injectedImage;
    } else {
      const imageClient = new OpenAI({
        apiKey: apiKey!,
        baseURL: options.baseUrl
          ?? process.env.VOLCENGINE_BASE_URL
          ?? DEFAULT_IMAGE_BASE_URL,
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
