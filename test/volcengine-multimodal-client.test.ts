import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatCompletion,
} from "openai/resources/chat/completions";
import { EnvHttpProxyAgent } from "undici";
import {
  buildMultimodalTransport,
  VolcengineMultimodalClient,
  type CreateMultimodalCompletion,
  type MultimodalFetch,
} from "../src/model/volcengine-multimodal-client.js";

/*
 * 火山多模态客户端单元测试：通过注入 createCompletion 隔离真实网络与密钥，
 * 验证图片 image_url / 音频 input_audio 的请求结构与响应归一化。
 */
describe("VolcengineMultimodalClient", () => {
  const previousApiKey = process.env.VOLCENGINE_API_KEY;

  afterEach(() => {
    if (previousApiKey === undefined) {
      delete process.env.VOLCENGINE_API_KEY;
    } else {
      process.env.VOLCENGINE_API_KEY = previousApiKey;
    }
  });

  it("maps an image request to an OpenAI-compatible image_url body", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>().mockResolvedValue(
      completion("图中是一只猫", 9),
    );
    const client = new VolcengineMultimodalClient({
      createCompletion,
      model: "doubao-seed-2.1-turbo",
    });

    const result = await client.analyze({
      kind: "image",
      dataBase64: "aW1hZ2UtYnl0ZXM=",
      mimeType: "image/png",
      format: "png",
      prompt: "这是什么？",
    });

    expect(result).toEqual({
      content: "图中是一只猫",
      model: "response-model",
      totalTokens: 9,
    });
    expect(createCompletion).toHaveBeenCalledWith({
      model: "doubao-seed-2.1-turbo",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这是什么？" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
          },
        ],
      }],
    }, undefined);
  });

  it("maps an mp3 request to an input_audio body", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>().mockResolvedValue(
      completion("转写结果", undefined),
    );
    const client = new VolcengineMultimodalClient({ createCompletion });

    const result = await client.analyze({
      kind: "audio",
      dataBase64: "YXVkaW8tYnl0ZXM=",
      mimeType: "audio/mpeg",
      format: "mp3",
      prompt: "请转写",
    });

    expect(result).toEqual({
      content: "转写结果",
      model: "response-model",
    });
    expect(createCompletion).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请转写" },
          {
            type: "input_audio",
            input_audio: { data: "YXVkaW8tYnl0ZXM=", format: "mp3" },
          },
        ],
      }],
    }), undefined);
  });

  it("routes audio to its separately configured Ark model and transport", async () => {
    const createImageCompletion = vi.fn<CreateMultimodalCompletion>();
    const createAudioCompletion = vi.fn<CreateMultimodalCompletion>()
      .mockResolvedValue(completion("没有语音，只有纯音", 7));
    const client = new VolcengineMultimodalClient({
      createCompletion: createImageCompletion,
      createAudioCompletion,
      model: "doubao-seed-2.1-turbo",
      audioModel: "doubao-seed-2-0-lite-260428",
    });

    await client.analyze({
      kind: "audio",
      dataBase64: "AAAA",
      mimeType: "audio/wav",
      format: "wav",
      prompt: "分析声音",
    });

    expect(createImageCompletion).not.toHaveBeenCalled();
    expect(createAudioCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "doubao-seed-2-0-lite-260428" }),
      undefined,
    );
  });

  it("supports wav format and forwards the caller signal", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>().mockResolvedValue(
      completion("ok", undefined),
    );
    const client = new VolcengineMultimodalClient({ createCompletion });
    const controller = new AbortController();

    await client.analyze({
      kind: "audio",
      dataBase64: "AAAA",
      mimeType: "audio/wav",
      format: "wav",
      prompt: "转写",
      signal: controller.signal,
    });

    expect(createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: "转写" }),
              expect.objectContaining({
                type: "input_audio",
                input_audio: { data: "AAAA", format: "wav" },
              }),
            ]),
          }),
        ]),
      }),
      { signal: controller.signal },
    );
  });

  it("rejects audio formats without official protocol confirmation", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>();
    const client = new VolcengineMultimodalClient({ createCompletion });

    await expect(client.analyze({
      kind: "audio",
      dataBase64: "AAAA",
      mimeType: "audio/flac",
      format: "flac",
      prompt: "转写",
    })).rejects.toThrow("不支持的音频格式: flac");
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("propagates provider errors", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>()
      .mockRejectedValue(new Error("上游 500"));
    const client = new VolcengineMultimodalClient({ createCompletion });

    await expect(client.analyze({
      kind: "image",
      dataBase64: "AAAA",
      mimeType: "image/png",
      format: "png",
      prompt: "描述",
    })).rejects.toThrow("上游 500");
  });

  it("does not call the provider when the signal is already aborted", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>();
    const client = new VolcengineMultimodalClient({ createCompletion });
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));

    await expect(client.analyze({
      kind: "image",
      dataBase64: "AAAA",
      mimeType: "image/png",
      format: "png",
      prompt: "描述",
      signal: controller.signal,
    })).rejects.toThrow("用户取消");
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("rejects a response without text content", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>().mockResolvedValue(
      completion("   ", undefined),
    );
    const client = new VolcengineMultimodalClient({ createCompletion });

    await expect(client.analyze({
      kind: "image",
      dataBase64: "AAAA",
      mimeType: "image/png",
      format: "png",
      prompt: "描述",
    })).rejects.toThrow("多模态模型没有返回文本内容");
  });

  it("uses the exact doubao-seed-2.1-turbo default model", async () => {
    const createCompletion = vi.fn<CreateMultimodalCompletion>().mockResolvedValue(
      completion("ok", undefined),
    );
    delete process.env.VOLCENGINE_API_KEY;
    const client = new VolcengineMultimodalClient({ createCompletion });

    await client.analyze({
      kind: "image",
      dataBase64: "AAAA",
      mimeType: "image/png",
      format: "png",
      prompt: "描述",
    });

    expect(createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "doubao-seed-2.1-turbo" }),
      undefined,
    );
  });

  it("requires VOLCENGINE_API_KEY when no transport is injected", () => {
    delete process.env.VOLCENGINE_API_KEY;
    expect(() => new VolcengineMultimodalClient()).toThrow(
      "VOLCENGINE_API_KEY is required",
    );
  });
});

/*
 * 代理传输回归测试：隔离环境真实图片请求超时的根因是 OpenAI SDK 未遵循
 * 标准代理环境变量；本组用例锁定有代理/无代理两种传输配置，不发起网络。
 */
describe("multimodal proxy transport", () => {
  const PROXY_VARS = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  for (const name of PROXY_VARS) {
    savedEnv.set(name, process.env[name]);
  }

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("keeps the direct SDK transport when no proxy env is present", () => {
    for (const name of PROXY_VARS) delete process.env[name];

    const transport = buildMultimodalTransport();

    expect(transport.proxyEnabled).toBe(false);
    expect(transport.fetch).toBeUndefined();
  });

  it("wires an EnvHttpProxyAgent dispatcher when proxy env is present", async () => {
    process.env.HTTPS_PROXY = "http://proxy.internal:3128";
    process.env.NO_PROXY = "127.0.0.1,localhost";
    const captured: Array<{ input: unknown; init?: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ input, init });
        return new Response("{}", { status: 200 });
      },
    ) as unknown as MultimodalFetch;

    const transport = buildMultimodalTransport({ fetchImpl });

    expect(transport.proxyEnabled).toBe(true);
    expect(transport.fetch).toBeDefined();
    await transport.fetch!(
      "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
      { method: "POST" },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.input)
      .toBe("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions");
    const dispatcher = (captured[0]?.init as { dispatcher?: unknown })
      ?.dispatcher;
    expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it("constructs the real client through the proxy transport", () => {
    process.env.VOLCENGINE_API_KEY = "test-key";
    process.env.HTTPS_PROXY = "http://proxy.internal:3128";
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as MultimodalFetch;

    const client = new VolcengineMultimodalClient({ fetchImpl });

    expect(client).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function completion(content: string, totalTokens?: number): ChatCompletion {
  return {
    id: "chatcmpl-media-test",
    choices: [{
      finish_reason: "stop",
      index: 0,
      logprobs: null,
      message: { role: "assistant", content, refusal: null },
    }],
    created: 0,
    model: "response-model",
    object: "chat.completion",
    ...(totalTokens === undefined
      ? {}
      : {
          usage: {
            completion_tokens: 4,
            prompt_tokens: totalTokens - 4,
            total_tokens: totalTokens,
          },
        }),
  };
}
