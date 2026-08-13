import { z } from "zod";
import { extractText } from "../docs/word-editor.js";
import { MEDIA_ID_PATTERN, type MediaStore } from "../media/media-store.js";
import type { AgentTool } from "./tool.js";

/** 一次回填给模型的正文上限，避免超长文件撑爆上下文。 */
const MAX_TEXT_CHARS = 30_000;

const readAttachmentInputSchema = z.object({
  // 只接受受控存储中的 mediaId，不接受文件路径或远程 URL。
  mediaId: z.string().regex(MEDIA_ID_PATTERN),
}).strict();

export type ReadAttachmentInput = z.infer<typeof readAttachmentInputSchema>;

export interface ReadAttachmentOutput {
  mediaId: string;
  name: string;
  kind: "image" | "audio" | "text" | "document" | "binary";
  mimeType: string;
  size: number;
  /** 内容是否可读取；binary 为 false，模型只能提及元信息。 */
  textAvailable: boolean;
  text: string;
  truncated: boolean;
}

/**
 * 读取已上传附件：
 * - text：UTF-8 解码并截断到 MAX_TEXT_CHARS；
 * - document：docx 提取正文 / pdf 提取文本（同样截断）；
 * - binary：只返回名称/大小/类型，不返回内容；
 * - image/audio：拒绝，指向对应的多模态分析工具。
 */
export function createReadAttachmentTool(
  store: MediaStore,
): AgentTool<ReadAttachmentInput, ReadAttachmentOutput> {
  return {
    name: "read_attachment",
    description:
      "读取已上传附件的内容：文本文件直接读取，docx/pdf 提取正文；"
      + "二进制文件只返回名称与大小，图片/音频请改用分析工具",
    inputSchema: readAttachmentInputSchema,
    async execute(input, signal) {
      signal?.throwIfAborted();
      const media = await store.read(input.mediaId);
      if (media === undefined) {
        throw new Error(`附件 ${input.mediaId} 不存在`);
      }

      const { name, kind, mimeType, size } = media.meta;
      if (kind === "image") {
        throw new Error("附件是图片，请使用 analyze_image 工具分析");
      }
      if (kind === "audio") {
        throw new Error("附件是音频，请使用 transcribe_audio 或 analyze_audio 工具分析");
      }
      if (kind === "binary") {
        return {
          mediaId: input.mediaId,
          name,
          kind,
          mimeType,
          size,
          textAvailable: false,
          text: "",
          truncated: false,
        };
      }

      const fullText = kind === "text"
        ? media.buffer.toString("utf8")
        : kind === "document" && media.meta.extension === "pdf"
          ? await extractPdfText(media.buffer)
          : (await extractText(media.buffer)).paragraphs.join("\n");
      const truncated = fullText.length > MAX_TEXT_CHARS;
      return {
        mediaId: input.mediaId,
        name,
        kind,
        mimeType,
        size,
        textAvailable: true,
        text: truncated ? fullText.slice(0, MAX_TEXT_CHARS) : fullText,
        truncated,
      };
    },
  };
}

/** 用 unpdf（pdfjs 封装）提取 PDF 全部页面的合并文本。 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  // 懒加载：只有真正读取 PDF 时才引入 pdfjs，避免拖慢服务启动。
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
  return text;
}
