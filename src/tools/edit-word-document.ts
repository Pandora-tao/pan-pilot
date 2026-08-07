import { z } from "zod";
import { FILE_ID_PATTERN, type DocStore } from "../docs/doc-store.js";
import { applyEdits, type WordEditResult } from "../docs/word-editor.js";
import type { AgentTool } from "./tool.js";

const replaceTextEditSchema = z.object({
  type: z.literal("replace_text"),
  oldText: z.string().trim().min(1, "oldText 不能为空").max(1000),
  newText: z.string().max(2000),
}).strict();

const insertParagraphEditSchema = z.object({
  type: z.literal("insert_paragraph"),
  afterText: z.string().trim().min(1, "afterText 不能为空").max(1000),
  paragraph: z.string().min(1, "paragraph 不能为空").max(5000),
}).strict();

const wordEditSchema = z.discriminatedUnion("type", [
  replaceTextEditSchema,
  insertParagraphEditSchema,
]);

const editInputSchema = z.object({
  fileId: z.string().regex(FILE_ID_PATTERN),
  edits: z.array(wordEditSchema).min(1).max(10),
}).strict();

export type EditWordDocumentInput = z.infer<typeof editInputSchema>;

export interface EditWordDocumentOutput {
  fileId: string;
  name: string;
  sizeBytes: number;
  /** 修改后文件的下载地址（相对路径，调用方拼接自己的 Host）。 */
  downloadUrl: string;
  edits: readonly WordEditResult[];
}

/**
 * 修改已上传的 Word 文档：原件保持不变，编辑结果另存为新文件，
 * 返回文件 ID 和下载地址，正文本身不回传给 HTTP。
 */
export function createEditWordDocumentTool(
  store: DocStore,
): AgentTool<EditWordDocumentInput, EditWordDocumentOutput> {
  return {
    name: "edit_word_document",
    description:
      "修改已上传的 Word 文档：替换文本或在指定段落后插入新段落；"
      + "原件不变，返回修改后文件的下载地址",
    inputSchema: editInputSchema,
    async execute(input, signal) {
      signal?.throwIfAborted();
      const source = await store.read(input.fileId);
      if (!source) {
        throw new Error(`文件 ${input.fileId} 不存在`);
      }

      const edited = await applyEdits(source.buffer, input.edits);
      const saved = await store.saveEdited(edited.buffer, source.fileId);
      return {
        fileId: saved.fileId,
        name: saved.name,
        sizeBytes: saved.size,
        downloadUrl: `/v1/files/${saved.fileId}`,
        edits: edited.results,
      };
    },
  };
}
