import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ExtensionError } from "../extension/validate.js";
import type { SandboxPackageManager } from "../extension/package-manager.js";

/**
 * 自我扩展候选审核接口（仅当 PAN_PILOT_SELF_EXTENSION_ENABLED 且已配置 API 鉴权时注册）。
 * Agent 只能产生候选包；这里只有已鉴权用户能确认安装。安装必须携带候选摘要，
 * 服务端重算完整性，任何变化都要求重新审核。
 */

const ID_PATTERN = /^[A-Za-z0-9-]{1,200}$/;

const idParamsSchema = z.object({ id: z.string().regex(ID_PATTERN) }).strict();
const installSchema = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export function registerPluginCandidatesRoute(
  app: FastifyInstance,
  manager: SandboxPackageManager,
): void {
  app.get("/v1/plugin-candidates", async (_request, reply) => {
    return handle(reply, async () => {
      const candidates = await manager.listCandidates();
      return { candidates: candidates.map((c) => publicCandidate(c)) };
    });
  });

  app.get("/v1/plugin-candidates/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    return handle(reply, async () => {
      const candidate = await manager.getCandidate(params.data.id);
      if (candidate === undefined) {
        throw new ExtensionError("CANDIDATE_NOT_FOUND", "候选不存在或已过期");
      }
      return { candidate };
    });
  });

  app.post("/v1/plugin-candidates/:id/install", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = installSchema.safeParse(request.body);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    if (!body.success) return invalidRequest(reply, body.error.issues);
    return handle(reply, async () => reply.code(201).send({
      installed: await manager.installCandidate(params.data.id, body.data.digest),
    }));
  });

  app.delete("/v1/plugin-candidates/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    return handle(reply, async () => {
      await manager.discardCandidate(params.data.id);
      return reply.code(204).send();
    });
  });
}

function publicCandidate(candidate: { id: string; name: string; version: string; digest: string; createdAt: string; expiresAt: string }) {
  return {
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    digest: candidate.digest,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
  };
}

async function handle<T>(
  reply: FastifyReply,
  action: () => T | Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ExtensionError) {
      return reply.code(statusFor(error.code)).send({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }
    throw error;
  }
}

function statusFor(code: ExtensionError["code"]): number {
  switch (code) {
    case "NOT_FOUND":
    case "CANDIDATE_NOT_FOUND":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "NOT_ENABLED":
      return 503;
    case "DIGEST_MISMATCH":
    case "CANDIDATE_EXPIRED":
    case "DUPLICATE_DECISION":
    case "VERSION_REGRESSION":
    case "ALREADY_INSTALLED":
      return 409;
    default:
      return 400;
  }
}

function invalidRequest(reply: FastifyReply, details: unknown): FastifyReply {
  return reply.code(400).send({
    error: "INVALID_REQUEST",
    message: "请求参数不正确",
    details,
  });
}
