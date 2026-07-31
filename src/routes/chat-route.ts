import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatAgent } from "../agent/chat-agent.js";
import type { ModelMessage } from "../model/model-client.js";

const legacySystemMessage: ModelMessage = {
  role: "system",
  content: "你是 PanPilot，一个简洁、准确的 AI 助手。",
};

const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().trim().min(1, "content 不能为空").max(100_000),
}).strict();

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, "message 不能为空").max(10_000).optional(),
  messages: z.array(modelMessageSchema).min(1).max(100).optional(),
  stream: z.boolean().optional().default(false),
}).strict().refine(
  (value) => (value.message === undefined) !== (value.messages === undefined),
  { message: "message 和 messages 必须且只能提供一个" },
).refine(
  (value) => value.messages === undefined
    || value.messages.some((message) => message.role === "user"),
  { message: "messages 至少需要一条 user 消息", path: ["messages"] },
);

export function registerChatRoute(
  app: FastifyInstance,
  chatAgent: ChatAgent,
  options: { logChatContent: boolean },
): void {
  app.post("/v1/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "请求参数不正确",
        details: parsed.error.issues,
      });
    }

    if (parsed.data.stream) {
      return reply.code(501).send({
        error: "CAPABILITY_NOT_IMPLEMENTED",
        message: "PanPilot 流式聊天接口已保留，但当前版本尚未实现",
      });
    }

    try {
      const messages = parsed.data.messages ?? [
        legacySystemMessage,
        { role: "user" as const, content: parsed.data.message ?? "" },
      ];
      const startedAt = Date.now();
      if (options.logChatContent) {
        request.log.info({
          event: "pan_pilot.chat.prompt",
          messageCount: messages.length,
          messages,
        }, "PanPilot chat prompt");
      }
      const completion = await chatAgent.chat(messages);
      if (options.logChatContent) {
        request.log.info({
          event: "pan_pilot.chat.reply",
          reply: completion.content,
          model: completion.model,
          totalTokens: completion.totalTokens ?? null,
          durationMs: Date.now() - startedAt,
        }, "PanPilot chat reply");
      }
      return {
        message: completion.content,
        model: completion.model,
        usage: completion.totalTokens === undefined
          ? null
          : { totalTokens: completion.totalTokens },
        execution: {
          mode: "chat",
          toolCalls: [],
        },
      };
    } catch (error) {
      request.log.error({ err: error }, "Chat request failed");

      return reply.code(502).send({
        error: "CHAT_FAILED",
        message: "Agent 调用失败",
      });
    }
  });
}
