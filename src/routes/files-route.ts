import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  FILE_ID_PATTERN,
  type DocStore,
} from "../docs/doc-store.js";
import {
  assertDocxStructure,
  isDocxMagic,
} from "../docs/word-editor.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const fileParamsSchema = z.object({
  fileId: z.string().regex(FILE_ID_PATTERN),
}).strict();

/**
 * 文件适配层：
 * - POST /v1/files 上传 .docx（multipart，字段名 file），校验格式后落盘；
 * - GET /v1/files/:fileId 下载文件，带鉴权和附件文件名。
 */
export function registerFilesRoute(app: FastifyInstance, store: DocStore): void {
  app.post("/v1/files", async (request, reply) => {
    let part: Awaited<ReturnType<typeof request.file>>;
    try {
      part = await request.file();
    } catch {
      return reply.code(413).send({
        error: "FILE_TOO_LARGE",
        message: `文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
      });
    }
    if (!part) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "缺少 file 字段",
      });
    }
    if (!part.filename.toLowerCase().endsWith(".docx")) {
      return reply.code(415).send({
        error: "UNSUPPORTED_FILE_TYPE",
        message: "仅支持 .docx 文件",
      });
    }

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      return reply.code(413).send({
        error: "FILE_TOO_LARGE",
        message: `文件不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
      });
    }

    if (!isDocxMagic(buffer)) {
      return reply.code(415).send({
        error: "INVALID_DOCX",
        message: "文件内容不是有效的 docx",
      });
    }
    try {
      await assertDocxStructure(buffer);
    } catch {
      return reply.code(415).send({
        error: "INVALID_DOCX",
        message: "文件内容不是有效的 docx",
      });
    }

    const saved = await store.saveUpload(buffer, part.filename);
    return reply.code(201).send({
      fileId: saved.fileId,
      name: saved.name,
      size: saved.size,
      downloadUrl: `/v1/files/${saved.fileId}`,
    });
  });

  app.get<{ Params: { fileId: string } }>("/v1/files/:fileId", async (request, reply) => {
    const parsed = fileParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "fileId 不正确",
      });
    }

    const file = await store.read(parsed.data.fileId);
    if (!file) {
      return reply.code(404).send({
        error: "FILE_NOT_FOUND",
        message: "文件不存在",
      });
    }

    return reply
      .header("content-type", DOCX_MIME)
      .header("content-disposition", attachmentHeader(file.meta.name))
      .header("content-length", file.buffer.length)
      .send(file.buffer);
  });
}

/** 中文文件名用 RFC 5987 filename* 传递，同时保留 ASCII fallback。 */
function attachmentHeader(name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
