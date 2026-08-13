import type { FastifyInstance } from "fastify";
import path from "node:path";
import { z } from "zod";
import {
  MEDIA_ID_PATTERN,
  MediaStore,
  MediaStoreError,
} from "../media/media-store.js";
import { attachmentHeader } from "./download-headers.js";

const mediaParamsSchema = z.object({
  mediaId: z.string().regex(MEDIA_ID_PATTERN),
}).strict();

/**
 * 附件适配层：
 * - POST /v1/media 上传任意附件（multipart，字段名 file），内容检测后落盘；
 * - GET /v1/media/:mediaId 下载受控附件，供本地核对与鉴权测试。
 * - DELETE /v1/media/:mediaId 删除受控附件（文件 + 元数据边车），
 *   供调用方在会话删除/事务回滚时联动清理；不返回媒体内容。
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
        message: `附件不能超过 ${maxBytes / 1024 / 1024}MB`,
      });
    }
    if (!part) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "缺少 file 字段",
      });
    }

    const originalName = path.basename(part.filename || "upload");

    let buffer: Buffer;
    try {
      buffer = await part.toBuffer();
    } catch {
      return reply.code(413).send({
        error: "MEDIA_TOO_LARGE",
        message: `附件不能超过 ${maxBytes / 1024 / 1024}MB`,
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
            message: `附件不能超过 ${maxBytes / 1024 / 1024}MB`,
          });
        }
        if (error.code === "UNSUPPORTED_EXTENSION") {
          return reply.code(415).send({
            error: "UNSUPPORTED_MEDIA_TYPE",
            message: "扩展名与文件内容不符或不受支持",
          });
        }
        if (error.code === "INVALID_MEDIA") {
          return reply.code(415).send({
            error: "INVALID_MEDIA",
            message: "附件内容为空或无法识别",
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

  app.delete<{ Params: { mediaId: string } }>(
    "/v1/media/:mediaId",
    async (request, reply) => {
      const parsed = mediaParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "mediaId 不正确",
        });
      }

      try {
        const deleted = await store.delete(parsed.data.mediaId);
        if (!deleted) {
          return reply.code(404).send({
            error: "MEDIA_NOT_FOUND",
            message: "媒体不存在",
          });
        }

        // 只回传删除结果，不回传媒体内容。
        return reply.code(200).send({
          deleted: true,
          mediaId: parsed.data.mediaId,
        });
      } catch (error) {
        // 底层删除失败（EACCES/EPERM/EIO 等）：返回通用 5xx，
        // 不泄露路径/内部细节；详细原因只进服务端日志。
        request.log.error({ err: error }, "Media delete failed");
        return reply.code(500).send({
          error: "MEDIA_DELETE_FAILED",
          message: "媒体删除失败，请稍后再试",
        });
      }
    },
  );
}
