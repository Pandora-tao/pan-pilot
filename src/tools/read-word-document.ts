import { z } from "zod";
import { FILE_ID_PATTERN, type DocStore } from "../docs/doc-store.js";
import { extractText } from "../docs/word-editor.js";
import type { AgentTool } from "./tool.js";

/** 一次回填给模型的正文上限，避免整篇长文档撑爆上下文。 */
const MAX_TEXT_CHARS = 30_000;
const MAX_PARAGRAPHS = 300;

const readInputSchema = z.object({
  fileId: z.string().regex(FILE_ID_PATTERN),
}).strict();

export type ReadWordDocumentInput = z.infer<typeof readInputSchema>;

export interface ReadWordDocumentOutput {
  fileId: string;
  name: string;
  paragraphCount: number;
  text: string;
  truncated: boolean;
}

/** 读取已上传的 docx 正文，让模型先了解文档内容再决定如何编辑。 */
export function createReadWordDocumentTool(
  store: DocStore,
): AgentTool<ReadWordDocumentInput, ReadWordDocumentOutput> {
  return {
    name: "read_word_document",
    description:
      "读取已上传 Word 文档的正文文本（按段落返回），用于编辑前了解文档内容",
    inputSchema: readInputSchema,
    async execute(input, signal) {
      signal?.throwIfAborted();
      const file = await store.read(input.fileId);
      if (!file) {
        throw new Error(`文件 ${input.fileId} 不存在`);
      }

      const { paragraphs } = await extractText(file.buffer);
      const visibleParagraphs = paragraphs.slice(0, MAX_PARAGRAPHS);
      let text = visibleParagraphs.join("\n");
      let truncated = paragraphs.length > MAX_PARAGRAPHS;
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        truncated = true;
      }

      return {
        fileId: file.fileId,
        name: file.meta.name,
        paragraphCount: paragraphs.length,
        text,
        truncated,
      };
    },
  };
}
