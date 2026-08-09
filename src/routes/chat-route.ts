import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import type { ChatAgent } from "../agent/chat-agent.js";
import { MEDIA_ID_PATTERN, type MediaStore } from "../media/media-store.js";
import type { ModelMessage } from "../model/model-client.js";

// 兼容早期只有 `message` 字段的调用方；完整 `messages` 模式由调用方自行提供上下文。
const legacySystemMessage: ModelMessage = {
  role: "system",
  content:
    "你是 PanPilot，一个简洁、准确的 AI 助手。"
    + "当工具返回下载地址时，把完整的 /v1/files/xxx 地址写在回复末尾。",
};

// strict() 会拒绝未声明字段，避免拼写错误被静默忽略后仍然调用付费模型。
const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().trim().min(1, "content 不能为空").max(100_000),
}).strict();

const chatAttachmentSchema = z.object({
  // 附件只能引用受控 MediaStore 中的 mediaId，不接受文件路径或远程 URL。
  mediaId: z.string().regex(MEDIA_ID_PATTERN, "mediaId 格式不正确"),
  kind: z.enum(["image", "audio"]).optional(),
}).strict();

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, "message 不能为空").max(10_000).optional(),
  messages: z.array(modelMessageSchema).min(1).max(100).optional(),
  attachments: z.array(chatAttachmentSchema).max(10).optional(),
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
  options: { logChatContent: boolean; mediaStore: MediaStore },
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
    const baseMessages = parsed.data.messages ?? [
      legacySystemMessage,
      { role: "user" as const, content: parsed.data.message ?? "" },
    ];
    const attachmentResolution = await resolveAttachments(
      baseMessages,
      parsed.data.attachments ?? [],
      options.mediaStore,
    );
    if (attachmentResolution.errors.length > 0) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "附件不正确",
        details: attachmentResolution.errors,
      });
    }
    const messages = attachmentResolution.messages;
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

interface AttachmentError {
  mediaId: string;
  reason: string;
}

/**
 * 把 attachments 转成强制调用分析工具的 user 提示消息。
 *
 * 上传的媒体必须先存在（受控 mediaId），类型不符立即拒绝；提示消息只含
 * mediaId，不携带媒体字节或 Base64，也不使用「需要时调用」的弱措辞——
 * 必须明确要求：分析该附件之前先调用对应工具（图片 analyze_image；
 * 音频按用户请求选择 transcribe_audio 或 analyze_audio）。
 */
async function resolveAttachments(
  messages: readonly ModelMessage[],
  attachments: readonly z.infer<typeof chatAttachmentSchema>[],
  mediaStore: MediaStore,
): Promise<{
  messages: readonly ModelMessage[];
  errors: readonly AttachmentError[];
}> {
  if (attachments.length === 0) return { messages, errors: [] };

  const hints: ModelMessage[] = [];
  const errors: AttachmentError[] = [];
  for (const attachment of attachments) {
    const media = await mediaStore.read(attachment.mediaId);
    if (media === undefined) {
      errors.push({ mediaId: attachment.mediaId, reason: "媒体不存在" });
      continue;
    }

    const kind = attachment.kind ?? media.meta.kind;
    if (kind !== media.meta.kind) {
      errors.push({
        mediaId: attachment.mediaId,
        reason: `kind 与媒体实际类型（${media.meta.kind}）不符`,
      });
      continue;
    }

    hints.push(kind === "image"
      ? {
          role: "user",
          content:
            `[附件] 用户上传了一张图片（mediaId: ${attachment.mediaId}）。`
            + "回答任何与这张图片相关的问题之前，你必须先调用"
            + ` analyze_image 工具（mediaId: ${attachment.mediaId}）分析该附件，`
            + "再基于分析结果作答。",
        }
      : {
          role: "user",
          content:
            `[附件] 用户上传了一段音频（mediaId: ${attachment.mediaId}）。`
            + "回答任何与这段音频相关的问题之前，你必须先调用音频工具分析该附件："
            + `如果用户要求语音转写，调用 transcribe_audio（mediaId: ${attachment.mediaId}）；`
            + `否则调用 analyze_audio（mediaId: ${attachment.mediaId}）转写并分析`
            + "说话人、语气与背景声音。",
        });
  }

  if (errors.length > 0) return { messages, errors };
  return { messages: [...messages, ...hints], errors: [] };
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
