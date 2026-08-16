import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SESSION_ID_PATTERN,
  deriveSessionTitle,
  sessionMessageSchema,
  type SessionStore,
} from "../sessions/session-store.js";

const sessionParamsSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
}).strict();

const sessionUpdateSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  messages: z.array(sessionMessageSchema).max(500).optional(),
}).strict().refine(
  (value) => value.title !== undefined || value.messages !== undefined,
  { message: "至少提供 title 或 messages 之一" },
);

/**
 * 会话历史适配层：
 * - GET /v1/sessions 会话摘要列表（按更新时间倒序，不含消息正文）；
 * - POST /v1/sessions 新建空会话；
 * - GET /v1/sessions/:sessionId 读取完整会话（含消息）；
 * - PUT /v1/sessions/:sessionId 保存/更新会话（不存在时按该 ID 创建）；
 * - DELETE /v1/sessions/:sessionId 删除会话。
 */
export function registerSessionRoute(
  app: FastifyInstance,
  store: SessionStore,
): void {
  app.get("/v1/sessions", async () => ({
    sessions: await store.list(),
  }));

  app.post("/v1/sessions", async (_request, reply) => {
    const session = store.newSession();
    await store.save(session);
    return reply.code(201).send({ session });
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const parsed = sessionParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "sessionId 不正确",
        });
      }
      const session = await store.read(parsed.data.sessionId);
      if (session === undefined) {
        return reply.code(404).send({
          error: "SESSION_NOT_FOUND",
          message: "会话不存在",
        });
      }
      return { session };
    },
  );

  app.put<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const params = sessionParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "sessionId 不正确",
        });
      }
      const body = sessionUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "会话内容不正确",
          details: body.error.issues,
        });
      }

      const sessionId = params.data.sessionId;
      const existing = await store.read(sessionId);
      const now = new Date().toISOString();
      const messages = body.data.messages ?? existing?.messages ?? [];
      const session = {
        version: 1 as const,
        id: sessionId,
        title: body.data.title
          ?? (
            messages.length > 0
            && (existing === undefined || existing.title === "新会话")
              ? deriveSessionTitle(messages)
              : existing?.title ?? "新会话"
          ),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages,
      };
      await store.save(session);
      return { session };
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const parsed = sessionParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_REQUEST",
          message: "sessionId 不正确",
        });
      }
      const deleted = await store.delete(parsed.data.sessionId);
      if (!deleted) {
        return reply.code(404).send({
          error: "SESSION_NOT_FOUND",
          message: "会话不存在",
        });
      }
      return { deleted: true, sessionId: parsed.data.sessionId };
    },
  );
}
