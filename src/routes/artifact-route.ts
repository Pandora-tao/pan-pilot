import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  ARTIFACT_ID_PATTERN,
  artifactContentType,
  type ArtifactStore,
  type StoredArtifact,
} from "../artifacts/artifact-store.js";
import { attachmentHeader } from "./download-headers.js";

const artifactParamsSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID_PATTERN),
}).strict();

/** 代码产物的附件响应头；GET 与 Fastify 自动提供的 HEAD 共用（HEAD 不发 body）。 */
function setArtifactHeaders(reply: FastifyReply, artifact: StoredArtifact): void {
  reply
    .header("content-type", artifactContentType(artifact.format))
    .header("content-disposition", attachmentHeader(artifact.name))
    .header("content-length", artifact.sizeBytes)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "sandbox");
}

/**
 * 下载受控代码产物；始终作为附件返回，服务端不执行也不内联渲染 HTML。
 * Fastify 对 GET 自动提供 HEAD（运行同一 handler、省略 body），
 * 前端可用 HEAD 解析真实文件名。
 */
export function registerArtifactRoute(
  app: FastifyInstance,
  store: ArtifactStore,
): void {
  app.get<{ Params: { artifactId: string } }>(
    "/v1/artifacts/:artifactId",
    async (request, reply) => {
      const parsed = artifactParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "artifactId 不正确",
        });
      }
      const artifact = await store.read(parsed.data.artifactId);
      if (artifact === undefined) {
        return reply.code(404).send({
          error: "ARTIFACT_NOT_FOUND",
          message: "代码产物不存在",
        });
      }
      setArtifactHeaders(reply, artifact);
      return reply.send(Buffer.from(artifact.content, "utf8"));
    },
  );
}
