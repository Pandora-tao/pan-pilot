import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import {
  AgentTimeoutError,
  ChatAgent,
  findAgentTimeout,
  isAbortError,
} from "../agent/chat-agent.js";
import {
  MEDIA_ID_PATTERN,
  type MediaStore,
  type StoredMedia,
} from "../media/media-store.js";
import type { ModelMessage } from "../model/model-client.js";
import {
  type ChatModelRegistry,
  UnavailableChatModelError,
  UnsupportedChatModelError,
} from "../model/model-registry.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ContextManagerOptions } from "../agent/context-manager.js";

// 兼容早期只有 `message` 字段的调用方；完整 `messages` 模式由调用方自行提供上下文。
const legacySystemMessage: ModelMessage = {
  role: "system",
  content:
    "你是 PanPilot，一个简洁、准确的 AI 助手。"
    + "网页、小游戏和源码任务优先使用 create_code_artifact；只有用户明确要求"
    + " Word 或 DOCX 时才使用 Word 工具。代码产物保存成功后只给出简短说明和"
    + "下载地址，不要重复整份源码。小游戏先生成 8000 字符以内、核心可玩的紧凑"
    + " MVP，不要为了附加功能输出半截源码。当工具返回下载地址时，把完整地址写在回复末尾。",
};

// strict() 会拒绝未声明字段，避免拼写错误被静默忽略后仍然调用付费模型。
const modelMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().trim().min(1, "content 不能为空").max(100_000),
}).strict();

const chatAttachmentSchema = z.object({
  // 附件只能引用受控 MediaStore 中的 mediaId，不接受文件路径或远程 URL。
  mediaId: z.string().regex(MEDIA_ID_PATTERN, "mediaId 格式不正确"),
  kind: z.enum(["image", "audio", "text", "document", "binary"]).optional(),
}).strict();

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, "message 不能为空").max(10_000).optional(),
  messages: z.array(modelMessageSchema).min(1).max(100).optional(),
  attachments: z.array(chatAttachmentSchema).max(10).optional(),
  model: z.string().trim().min(1, "model 不能为空").max(120).optional(),
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

/** SSE 心跳间隔：路由独立发送，与 Agent 生成器无关。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
/** 自最后一次 Agent 事件起超过该时长未收到进展时发出 warning。 */
export const DEFAULT_SLOW_WARNING_MS = 30_000;

export interface ChatRouteTimeoutOptions {
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
  timeoutMs?: number;
}

/**
 * HTTP 适配层：负责校验、协议兼容、状态码和日志，不包含模型厂商调用细节。
 */
export function registerChatRoute(
  app: FastifyInstance,
  modelRegistry: ChatModelRegistry,
  toolRegistry: ToolRegistry,
  options: {
    logChatContent: boolean;
    mediaStore: MediaStore;
    contextOptions?: ContextManagerOptions;
    timeouts?: ChatRouteTimeoutOptions;
    heartbeatIntervalMs?: number;
    slowWarningMs?: number;
  },
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

    let selectedModel;
    try {
      selectedModel = modelRegistry.resolve(parsed.data.model);
    } catch (error) {
      if (error instanceof UnsupportedChatModelError) {
        return reply.code(400).send({
          error: "UNSUPPORTED_MODEL",
          message: "不支持该聊天模型",
          modelId: error.modelId,
        });
      }
      if (error instanceof UnavailableChatModelError) {
        return reply.code(503).send({
          error: "MODEL_UNAVAILABLE",
          message: "该聊天模型当前不可用",
          modelId: error.modelId,
        });
      }
      throw error;
    }
    // 每轮只解析一次模型；固定客户端贯穿后续全部工具步骤，禁止供应商漂移。
    const modelId = selectedModel.descriptor.id;
    const chatAgent = new ChatAgent(selectedModel.client, toolRegistry, {
      ...(options.contextOptions === undefined ? {} : { context: options.contextOptions }),
      ...(options.timeouts === undefined ? {} : options.timeouts),
    });

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
        modelId,
        messageCount: messages.length,
        messages,
      }, "PanPilot chat prompt");
    }

    if (parsed.data.stream) {
      return streamChatReply(
        request,
        reply,
        chatAgent,
        modelId,
        messages,
        options,
        startedAt,
      );
    }

    try {
      const result = await chatAgent.chat(messages);
      if (options.logChatContent) {
        request.log.info({
          event: "pan_pilot.chat.reply",
          reply: result.content,
          modelId,
          model: result.model,
          totalTokens: result.totalTokens ?? null,
          steps: result.steps,
          toolExecutions: result.toolExecutions,
          context: result.context ?? null,
          durationMs: Date.now() - startedAt,
        }, "PanPilot chat reply");
      }
      return {
        message: result.content,
        modelId,
        model: result.model,
        usage: result.totalTokens === undefined
          ? null
          : { totalTokens: result.totalTokens },
        // 思考内容（思维链）默认随响应返回，由客户端决定展示；不写入会话历史。
        ...(result.reasoning === undefined ? {} : { reasoning: result.reasoning }),
        execution: {
          mode: "chat",
          // 只返回执行摘要（id/name/status）；原始参数和工具结果可能含敏感数据，不回传 HTTP。
          toolExecutions: result.toolExecutions,
          ...(result.context === undefined ? {} : { context: result.context }),
          ...(result.contextMessages === undefined
            ? {}
            : { contextMessages: result.contextMessages }),
        },
      };
    } catch (error) {
      request.log.error({ err: error }, "Chat request failed");

      const timeout = findAgentTimeout(error);
      if (timeout !== undefined) {
        return reply.code(504).send(timeoutFailure(timeout));
      }
      if (isAbortError(error)) {
        // 客户端已经取消；用非标 499（客户端关闭请求）与普通失败区分。
        return reply.code(499).send({
          error: "USER_ABORTED",
          message: "请求已停止",
        });
      }
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
 * mediaId，不携带媒体字节或 Base64，也不使用「需要时调用」的弱措辞：
 * - image → 必须先调用 analyze_image；
 * - audio → 按用户请求调用 transcribe_audio 或 analyze_audio；
 * - text → 必须先调用 read_attachment 读取内容；
 * - document → 必须调用对应的 Office MCP 工具；
 * - binary → 只能提及文件名/大小/类型，不得编造内容。
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

    const hint = attachmentHint(attachment.mediaId, media);
    hints.push({ role: "user" as const, content: hint });
  }

  if (errors.length > 0) return { messages, errors };
  return { messages: [...messages, ...hints], errors: [] };
}

/** 按附件类型生成强制/限制性提示消息。 */
function attachmentHint(
  mediaId: string,
  media: StoredMedia,
): string {
  const kind = media.meta.kind;
  if (kind === "image") {
    return `[附件] 用户上传了一张图片（mediaId: ${mediaId}）。`
      + "回答任何与这张图片相关的问题之前，你必须先调用"
      + ` analyze_image 工具（mediaId: ${mediaId}）分析该附件，`
      + "再基于分析结果作答。";
  }
  if (kind === "audio") {
    return `[附件] 用户上传了一段音频（mediaId: ${mediaId}）。`
      + "回答任何与这段音频相关的问题之前，你必须先调用音频工具分析该附件："
      + `如果用户要求语音转写，调用 transcribe_audio（mediaId: ${mediaId}）；`
      + `否则调用 analyze_audio（mediaId: ${mediaId}）转写并分析`
      + "说话人、语气与背景声音。";
  }
  if (kind === "binary") {
    return `[附件] 用户上传了文件「${media.meta.name}」`
      + `（${media.meta.size} 字节，类型 ${media.meta.mimeType}）。`
      + "该附件无法读取内容，回答时只能提及文件名与大小，不得编造内容。";
  }
  if (kind === "document") {
    const tool = officeReaderTool(media.meta.extension);
    return `[附件] 用户上传了一份 Office 文档「${media.meta.name}」`
      + `（mediaId: ${mediaId}）。回答任何与该附件相关的问题之前，你必须先调用`
      + ` ${tool}（mediaId: ${mediaId}）读取内容，再基于内容作答。`
      + "如果该工具不在可用工具列表中，必须明确说明 Office 插件未连接，不得编造文档内容。";
  }
  return `[附件] 用户上传了一个文本文件「${media.meta.name}」（mediaId: ${mediaId}）。`
    + "回答任何与该附件相关的问题之前，你必须先调用"
    + ` read_attachment 工具（mediaId: ${mediaId}）读取该附件的内容，`
    + "再基于内容作答。";
}

function officeReaderTool(extension: string): string {
  switch (extension) {
    case "docx":
      return "mcp__office__read_word_document";
    case "pptx":
      return "mcp__office__read_presentation";
    case "pdf":
      return "mcp__office__read_pdf";
    default:
      return "对应的 Office MCP 读取工具";
  }
}

/**
 * SSE 流式响应：每个事件是一行 `data: {json}`，事件类型由 JSON 的 type 字段区分。
 * 错误发生在响应建立之后，因此失败也以事件形式返回，而不是改变 HTTP 状态码。
 */
async function streamChatReply(
  request: FastifyRequest,
  reply: FastifyReply,
  chatAgent: ChatAgent,
  modelId: string,
  messages: readonly ModelMessage[],
  options: {
    logChatContent: boolean;
    heartbeatIntervalMs?: number;
    slowWarningMs?: number;
  },
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
  // SSE 建立后立即发送 accepted 状态并 flush，客户端无需等待模型即可看到进度。
  raw.flushHeaders();
  // 关闭 Nagle 算法，避免小体积 SSE 事件被 TCP 合并造成额外延迟。
  raw.socket?.setNoDelay?.(true);
  writeSseEvent(raw, { type: "status", stage: "accepted", elapsedMs: 0 });
  const abortSignal = clientAbortSignal(reply);
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const slowWarningMs = options.slowWarningMs ?? DEFAULT_SLOW_WARNING_MS;

  // 路由侧独立心跳：Agent 生成器可能长时间不产出事件，心跳保活并驱动慢响应提示。
  let lastActivityAt = Date.now();
  let currentStage = "accepted";
  let slowWarned = false;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const elapsedMs = now - startedAt;
    writeSseEvent(raw, {
      type: "heartbeat",
      elapsedMs,
      stage: currentStage,
    });
    if (!slowWarned && now - lastActivityAt >= slowWarningMs) {
      slowWarned = true;
      writeSseEvent(raw, {
        type: "warning",
        code: "SLOW_RESPONSE",
        message: "等待模型响应时间较长，请耐心等待",
        elapsedMs,
      });
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();
  const stopHeartbeat = () => clearInterval(heartbeat);
  raw.once("close", stopHeartbeat);

  try {
    for await (const event of chatAgent.chatStream(
      messages,
      abortSignal,
    )) {
      lastActivityAt = Date.now();
      if (event.type === "status") {
        currentStage = event.stage;
      } else if (event.type === "tool_start") {
        currentStage = "tool";
      }
      const responseEvent = event.type === "done"
        ? { ...event, result: { ...event.result, modelId } }
        : event;
      writeSseEvent(raw, responseEvent);
      if (event.type === "done" && options.logChatContent) {
        request.log.info({
          event: "pan_pilot.chat.reply",
          reply: event.result.content,
          modelId,
          model: event.result.model,
          totalTokens: event.result.totalTokens ?? null,
          steps: event.result.steps,
          toolExecutions: event.result.toolExecutions,
          context: event.result.context ?? null,
          durationMs: Date.now() - startedAt,
        }, "PanPilot chat reply");
      }
    }
    raw.end();
  } catch (error) {
    const failure = classifyStreamFailure(error, abortSignal);
    request.log.error(
      { err: error, errorCode: failure.error },
      "Chat stream failed",
    );
    // 连接尚在时把分类后的失败事件发给客户端；用户中止通常连接已断开，写入会被忽略。
    writeSseEvent(raw, {
      type: "error",
      error: failure.error,
      message: failure.message,
      elapsedMs: Date.now() - startedAt,
    });
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  } finally {
    stopHeartbeat();
  }
}

/** 对外只返回稳定错误码与用户可读消息，不暴露 SDK、网络或内部细节。 */
function classifyStreamFailure(
  error: unknown,
  clientSignal: AbortSignal,
): { error: string; message: string } {
  const timeout = findAgentTimeout(error);
  if (timeout !== undefined) return timeoutFailure(timeout);
  if (clientSignal.aborted || isAbortError(error)) {
    return { error: "USER_ABORTED", message: "请求已停止" };
  }
  return { error: "CHAT_FAILED", message: "Agent 调用失败" };
}

function timeoutFailure(
  timeout: AgentTimeoutError,
): { error: string; message: string } {
  switch (timeout.kind) {
    case "model":
      return { error: "MODEL_TIMEOUT", message: "模型响应超时，已取消" };
    case "tool":
      return { error: "TOOL_TIMEOUT", message: "工具执行超时，已取消" };
    case "request":
      return { error: "REQUEST_TIMEOUT", message: "整体请求超时，已取消" };
  }
}

/** 写入完整的一条 SSE 事件；连接销毁后静默跳过，避免 EPIPE 噪声。 */
function writeSseEvent(raw: ServerResponse, event: unknown): void {
  if (raw.destroyed || raw.writableEnded) return;
  raw.write(`data: ${JSON.stringify(event)}\n\n`);
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
