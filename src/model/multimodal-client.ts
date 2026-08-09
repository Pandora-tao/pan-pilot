import type { MediaKind } from "../media/media-store.js";

/** 一次多模态分析请求：数据必须来自受控 MediaStore，不能传任意文件路径或远程 URL。 */
export interface MultimodalRequest {
  kind: MediaKind;
  /** 受控媒体字节的 Base64 编码（由 MediaStore 校验后的数据产生）。 */
  dataBase64: string;
  /** 规范 MIME 类型，图片 data URL 使用。 */
  mimeType: string;
  /** 媒体格式（如 png / mp3），对应厂商协议的 format 字段。 */
  format: string;
  prompt: string;
  signal?: AbortSignal;
}

/** 厂商无关的多模态分析结果。 */
export interface MultimodalAnalysis {
  content: string;
  model: string;
  totalTokens?: number;
}

/**
 * 多模态厂商隔离端口。
 *
 * 主 ModelClient 只承载文本/工具协议；图片与音频理解走这个端口，
 * 火山方舟、其他厂商或测试替身各自实现，上层不感知厂商细节。
 */
export interface MultimodalClient {
  analyze(request: MultimodalRequest): Promise<MultimodalAnalysis>;
}
