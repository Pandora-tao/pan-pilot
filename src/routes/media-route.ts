import type { FastifyInstance } from "fastify";
import path from "node:path";
import { z } from "zod";
import {
  MEDIA_ID_PATTERN,
  MediaStore,
  MediaStoreError,
} from "../media/media-store.js";
import { attachmentHeader } from "./download-headers.js";

/** 上传前先按扩展名粗筛；真正的类型判定以魔数为准（MediaStore 二次校验）。 */
const ALLOWED_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif|mp3|wav)$/i;

const mediaParamsSchema = z.object({
  mediaId: z.string().regex(MEDIA_ID_PATTERN),
}).strict();

/**
 * 媒体适配层：
 * - POST /v1/media 上传图片/音频（multipart，字段名 file），校验格式后落盘；
 * - GET /v1/media/:mediaId 下载受控媒体，供本地核对与鉴权测试。
 */
export function registerMediaRoute(
  app: FastifyInstance,
  store: MediaStore,
  maxBytes: number,
): void {
  app.post("/v1/media", async (request, reply) => {
    let part: Awaited<ReturnType<typeof request.file>>;
    try {
      part = await request.file();
    } catch {
      return reply.code(413).send({
        error: "MEDIA_TOO_LARGE",
        message: `媒体不能超过 ${maxBytes / 1024 / 1024}MB`,
      });
    }
    if (!part) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "缺少 file 字段",
      });
    }

    const originalName = path.basename(part.filename || "upload");
    if (!ALLOWED_EXTENSION_PATTERN.test(originalName)) {
      return reply.code(415).send({
        error: "UNSUPPORTED_MEDIA_TYPE",
        message: "仅支持图片（png/jpg/jpeg/webp/gif）与音频（mp3/wav）",
      });
    }

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      return reply.code(413).send({
        error: "MEDIA_TOO_LARGE",
        message: `媒体不能超过 ${maxBytes / 1024 / 1024}MB`,
      });
    }

    try {
      const saved = await store.save(buffer, originalName);
      return reply.code(201).send({
        mediaId: saved.mediaId,
        name: saved.name,
        kind: saved.kind,
        mimeType: saved.mimeType,
        size: saved.size,
      });
    } catch (error) {
      if (error instanceof MediaStoreError) {
        if (error.code === "MEDIA_TOO_LARGE") {
          return reply.code(413).send({
            error: "MEDIA_TOO_LARGE",
            message: `媒体不能超过 ${maxBytes / 1024 / 1024}MB`,
          });
        }
        if (error.code === "UNSUPPORTED_EXTENSION") {
          return reply.code(415).send({
            error: "UNSUPPORTED_MEDIA_TYPE",
            message: "仅支持图片（png/jpg/jpeg/webp/gif）与音频（mp3/wav）",
          });
        }
        if (error.code === "INVALID_MEDIA") {
          return reply.code(415).send({
            error: "INVALID_MEDIA",
            message: "文件内容不是受支持的图片或音频",
          });
        }
      }
      throw error;
    }
  });

  app.get<{ Params: { mediaId: string } }>(
    "/v1/media/:mediaId",
    async (request, reply) => {
      const parsed = mediaParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "mediaId 不正确",
        });
      }

      const media = await store.read(parsed.data.mediaId);
      if (!media) {
        return reply.code(404).send({
          error: "MEDIA_NOT_FOUND",
          message: "媒体不存在",
        });
      }

      return reply
        .header("content-type", media.meta.mimeType)
        .header("content-disposition", attachmentHeader(media.meta.name))
        .header("content-length", media.buffer.length)
        .send(media.buffer);
    },
  );
}
