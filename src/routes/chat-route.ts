import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChatAgent } from "../agent/chat-agent.js";
import type { ModelMessage } from "../model/model-client.js";

// 兼容早期只有 `message` 字段的调用方；完整 `messages` 模式由调用方自行提供上下文。
const legacySystemMessage: ModelMessage = {
  role: "system",
  content: "你是 PanPilot，一个简洁、准确的 AI 助手。",
};

// strict() 会拒绝未声明字段，避免拼写错误被静默忽略后仍然调用付费模型。
const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().trim().min(1, "content 不能为空").max(100_000),
}).strict();

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, "message 不能为空").max(10_000).optional(),
  messages: z.array(modelMessageSchema).min(1).max(100).optional(),
  stream: z.boolean().optional().default(false),
}).strict().refine(
  // 简写 message 与完整 messages 是两种互斥的请求形式，必须且只能选择一种。
  (value) => (value.message === undefined) !== (value.messages === undefined),
  { message: "message 和 messages 必须且只能提供一个" },
).refine(
  (value) => value.messages === undefined
    || value.messages.some((message) => message.role === "user"),
  { message: "messages 至少需要一条 user 消息", path: ["messages"] },
);

/**
 * HTTP 适配层：负责校验、协议兼容、状态码和日志，不包含模型厂商调用细节。
 */
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
      // 明确返回“尚未实现”，防止调用方误以为拿到的是流式响应。
      return reply.code(501).send({
        error: "CAPABILITY_NOT_IMPLEMENTED",
        message: "PanPilot 流式聊天接口已保留，但当前版本尚未实现",
      });
    }

    try {
      // 在进入 Agent 层前，把两种 HTTP 请求格式统一成消息数组。
      const messages = parsed.data.messages ?? [
        legacySystemMessage,
        { role: "user" as const, content: parsed.data.message ?? "" },
      ];
      const startedAt = Date.now();
      if (options.logChatContent) {
        // 完整对话可能含隐私或密钥，因此只有显式开启时才记录内容。
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
          // 为未来的工具调用结果预留稳定响应结构，当前阶段始终为空。
          toolCalls: [],
        },
      };
    } catch (error) {
      request.log.error({ err: error }, "Chat request failed");

      // 对外隐藏 SDK、网络及密钥等内部错误细节，详细原因只进入服务端日志。
      return reply.code(502).send({
        error: "CHAT_FAILED",
        message: "Agent 调用失败",
      });
    }
  });
}
