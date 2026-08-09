import type { MediaKind, MediaStore } from "../media/media-store.js";
import type { MultimodalClient } from "../model/multimodal-client.js";

/**
 * 懒加载的多模态客户端工厂。
 *
 * 工具通过工厂在首次执行时才构造厂商客户端，因此未配置
 * VOLCENGINE_API_KEY 时服务仍可正常启动，只有真正调用工具才报错。
 */
export type MultimodalClientProvider = () => MultimodalClient;

/** 工具回填给主 Agent 的结构化结果；不包含媒体字节或 Base64。 */
export interface MediaToolOutput {
  mediaId: string;
  kind: MediaKind;
  /** 厂商返回的分析文本（图片描述 / 音频转写与分析）。 */
  summary: string;
  model: string;
}

export interface MediaAnalyzeDeps {
  mediaStore: MediaStore;
  provider: MultimodalClientProvider;
}

/**
 * 读取受控媒体并调用多模态厂商。
 *
 * 入参只接受 mediaId；媒体字节只以 Base64 形式发给厂商，绝不进入日志或 HTTP 响应。
 */
export async function analyzeControlledMedia(
  deps: MediaAnalyzeDeps,
  input: { mediaId: string; prompt?: string | undefined },
  expectedKind: MediaKind,
  defaultPrompt: string,
  signal?: AbortSignal,
): Promise<MediaToolOutput> {
  signal?.throwIfAborted();

  const media = await deps.mediaStore.read(input.mediaId);
  if (media === undefined) {
    throw new Error(`媒体 ${input.mediaId} 不存在`);
  }
  if (media.meta.kind !== expectedKind) {
    throw new Error(
      `媒体 ${input.mediaId} 不是${expectedKind === "image" ? "图片" : "音频"}`,
    );
  }

  const analysis = await deps.provider().analyze({
    kind: media.meta.kind,
    mimeType: media.meta.mimeType,
    dataBase64: media.buffer.toString("base64"),
    format: media.meta.extension,
    prompt: input.prompt?.trim() || defaultPrompt,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    mediaId: input.mediaId,
    kind: media.meta.kind,
    summary: analysis.content,
    model: analysis.model,
  };
}

/** 让每次执行复用同一个厂商客户端实例。 */
export function memoizeProvider(
  provider: MultimodalClientProvider,
): MultimodalClientProvider {
  let client: MultimodalClient | undefined;
  return () => {
    client ??= provider();
    return client;
  };
}
