import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  PermissionDecisionError,
  type PermissionService,
} from "../permissions/permission-service.js";

/**
 * 授权闭环的认证接口：
 * - 列出待决授权请求（含路径 / 命令 / diff 预览，供控制台决定或恢复）；
 * - 提交决定（allow_once / allow_always / reject）；决定携带 runId 时，
 *   通过服务端的 onRequestDecided 回调触发定时任务从同一待执行工具续跑；
 * - 列出 / 撤销永久授权规则。
 *
 * 本路由不记录待决请求内容（路径 / 命令 / diff 永不进入日志）。
 * 鉴权沿用 /v1 全局 Bearer 钩子（配置 token 即全部要求鉴权）。
 */

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,200}$/;
const RULE_ID_PATTERN = /^[A-Za-z0-9-]{1,200}$/;

const idParamsSchema = z.object({
  id: z.string().regex(REQUEST_ID_PATTERN),
}).strict();

const decisionSchema = z.object({
  action: z.enum(["allow_once", "allow_always", "reject"]),
}).strict();

export function registerPermissionRoute(
  app: FastifyInstance,
  service: PermissionService,
): void {
  app.get("/v1/permission/requests", async () => ({
    requests: service.listPending(),
  }));

  app.post(
    "/v1/permission/requests/:id/decision",
    async (request, reply) => {
      const params = idParamsSchema.safeParse(request.params);
      const body = decisionSchema.safeParse(request.body);
      if (!params.success) return invalidRequest(reply, params.error.issues);
      if (!body.success) return invalidRequest(reply, body.error.issues);
      return handle(reply, () => ({
        request: service.decide(params.data.id, body.data.action),
      }));
    },
  );

  app.get("/v1/permission/rules", async () => ({
    rules: service.listRules(),
  }));

  app.delete(
    "/v1/permission/rules/:id",
    async (request, reply) => {
      const params = z.object({ id: z.string().regex(RULE_ID_PATTERN) })
        .strict().safeParse(request.params);
      if (!params.success) return invalidRequest(reply, params.error.issues);
      const removed = service.revokeRule(params.data.id);
      if (!removed) {
        return reply.code(404).send({
          error: "RULE_NOT_FOUND",
          message: "授权规则不存在",
        });
      }
      return reply.code(204).send();
    },
  );
}

async function handle<T>(
  reply: FastifyReply,
  action: () => T | Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PermissionDecisionError) {
      const status = error.code === "NOT_FOUND" ? 404 : 409;
      return reply.code(status).send({
        error: error.code,
        message: error.message,
      });
    }
    throw error;
  }
}

function invalidRequest(reply: FastifyReply, details: unknown): FastifyReply {
  return reply.code(400).send({
    error: "INVALID_REQUEST",
    message: "请求参数不正确",
    details,
  });
}
