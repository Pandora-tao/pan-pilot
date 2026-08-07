import { z } from "zod";
import type { DocStore } from "../docs/doc-store.js";
import { createDocx } from "../docs/word-editor.js";
import type { AgentTool } from "./tool.js";

const headingLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const blockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    level: headingLevelSchema,
    text: z.string().trim().min(1, "text 不能为空").max(500),
  }).strict(),
  z.object({
    type: z.literal("paragraph"),
    text: z.string().trim().min(1, "text 不能为空").max(5000),
  }).strict(),
  z.object({
    type: z.literal("bullet"),
    text: z.string().trim().min(1, "text 不能为空").max(2000),
  }).strict(),
  z.object({
    type: z.literal("table"),
    headers: z.array(
      z.string().trim().min(1, "表头不能为空").max(200),
    ).min(1).max(8),
    rows: z.array(
      z.array(z.string().max(500)).min(1).max(8),
    ).min(1).max(50),
  }).strict().refine(
    (value) => value.rows.every((row) => row.length === value.headers.length),
    { message: "rows 每行的列数必须与 headers 一致", path: ["rows"] },
  ),
]);

const createInputSchema = z.object({
  title: z.string().trim().min(1, "title 不能为空").max(200),
  blocks: z.array(blockSchema).min(1).max(100),
}).strict();

export type CreateWordDocumentInput = z.infer<typeof createInputSchema>;

export interface CreateWordDocumentOutput {
  fileId: string;
  name: string;
  sizeBytes: number;
  /** 新文档的下载地址（相对路径，调用方拼接自己的 Host）。 */
  downloadUrl: string;
  blocks: number;
}

/**
 * 从零生成 Word 文档：标题 + 标题/段落块，产物落盘为不可变新文件，
 * 返回文件 ID 和下载地址，正文本身不回传给 HTTP。
 */
export function createCreateWordDocumentTool(
  store: DocStore,
): AgentTool<CreateWordDocumentInput, CreateWordDocumentOutput> {
  return {
    name: "create_word_document",
    description:
      "根据标题和结构化内容（一级到三级标题、段落、项目符号、表格）"
      + "生成排版完整（A4、样式、页边距）的 Word 文档，返回下载地址",
    inputSchema: createInputSchema,
    async execute(input, signal) {
      signal?.throwIfAborted();
      const buffer = await createDocx({
        title: input.title,
        blocks: input.blocks,
      });
      const saved = await store.saveCreated(
        buffer,
        `${sanitizeFileName(input.title)}.docx`,
      );
      return {
        fileId: saved.fileId,
        name: saved.name,
        sizeBytes: saved.size,
        downloadUrl: `/v1/files/${saved.fileId}`,
        blocks: input.blocks.length,
      };
    },
  };
}

/** 去掉文件名非法字符并限长，避免标题里的 / \ : 等破坏下载文件名。 */
function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned === "" ? "文档" : cleaned;
}
