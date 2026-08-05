import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
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

    if (parsed.data.stream) {
      return streamChatReply(request, reply, chatAgent, messages, options, startedAt);
    }

    try {
      const result = await chatAgent.chat(messages);
      if (options.logChatContent) {
        request.log.info({
          event: "pan_pilot.chat.reply",
          reply: result.content,
          model: result.model,
          totalTokens: result.totalTokens ?? null,
          steps: result.steps,
          toolExecutions: result.toolExecutions,
          durationMs: Date.now() - startedAt,
        }, "PanPilot chat reply");
      }
      return {
        message: result.content,
        model: result.model,
        usage: result.totalTokens === undefined
          ? null
          : { totalTokens: result.totalTokens },
        execution: {
          mode: "chat",
          // 只返回执行摘要（id/name/status）；原始参数和工具结果可能含敏感数据，不回传 HTTP。
          toolExecutions: result.toolExecutions,
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

/**
 * SSE 流式响应：每个事件是一行 `data: {json}`，事件类型由 JSON 的 type 字段区分。
 * 错误发生在响应建立之后，因此失败也以事件形式返回，而不是改变 HTTP 状态码。
 */
async function streamChatReply(
  request: FastifyRequest,
  reply: FastifyReply,
  chatAgent: ChatAgent,
  messages: readonly ModelMessage[],
  options: { logChatContent: boolean },
  startedAt: number,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  // 客户端中途断开会产生写错误（如 EPIPE），只忽略、不当作服务端故障。
  raw.on("error", () => {});
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const abortSignal = clientAbortSignal(reply);

  try {
    for await (const event of chatAgent.chatStream(
      messages,
      abortSignal,
    )) {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done" && options.logChatContent) {
        request.log.info({
          event: "pan_pilot.chat.reply",
          reply: event.result.content,
          model: event.result.model,
          totalTokens: event.result.totalTokens ?? null,
          steps: event.result.steps,
          toolExecutions: event.result.toolExecutions,
          durationMs: Date.now() - startedAt,
        }, "PanPilot chat reply");
      }
    }
    raw.end();
  } catch (error) {
    if (abortSignal.aborted) {
      // 客户端已断开，不再尝试发送错误事件。
      raw.destroy();
      return;
    }
    request.log.error({ err: error }, "Chat stream failed");
    // 对外隐藏 SDK、网络及密钥等内部错误细节，详细原因只进入服务端日志。
    raw.write(`data: ${JSON.stringify({
      type: "error",
      error: "CHAT_FAILED",
      message: "Agent 调用失败",
    })}\n\n`);
    raw.end();
  }
}

/**
 * 构造随客户端断开的取消信号。
 * Node 22 的 IncomingMessage 还没有标准 signal 属性，因此监听响应流的 close：
 * 响应未正常写完就关闭说明连接被提前终止。
 */
function clientAbortSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}
