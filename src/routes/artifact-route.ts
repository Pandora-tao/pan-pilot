import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ARTIFACT_ID_PATTERN,
  artifactContentType,
  type ArtifactStore,
} from "../artifacts/artifact-store.js";
import { attachmentHeader } from "./download-headers.js";

const artifactParamsSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID_PATTERN),
}).strict();

/** 下载受控代码产物；始终作为附件返回，服务端不执行也不内联渲染 HTML。 */
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
      const body = Buffer.from(artifact.content, "utf8");
      return reply
        .header("content-type", artifactContentType(artifact.format))
        .header("content-disposition", attachmentHeader(artifact.name))
        .header("content-length", body.length)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox")
        .send(body);
    },
  );
}
