import {
  ArrowUp,
  Paperclip,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { gsap } from "gsap";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiClient, readError } from "../../api";
import { withMotion } from "../../animations";
import { keepAwake, stopAwake } from "../../keep-awake";
import { modelDisplayLabel } from "../../model-selection";
import { randomId } from "../../random-id";
import type {
  ChatMessage,
  ChatResult,
  ChatSessionMessage,
  ChatStreamEvent,
  MediaAsset,
  ModelsResponse,
  PermissionRequest,
  ToolExecution,
} from "../../types";
import { FileLink } from "./FileLink";
import { MarkdownContent } from "./markdown";
import { PermissionModal } from "./PermissionModal";
import { SseEventParser } from "./sse-events";

// 系统提示词由服务端统一注入（唯一来源）；前端不携带可覆盖服务端 system 消息。

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: MediaAsset[];
  tools?: ToolExecution[];
  /** 模型思考/推理内容（思维链），仅本次会话展示，不持久化。 */
  reasoning?: string;
  meta?: string;
  error?: string;
  streaming?: boolean;
}

/** 处理过程面板中的单次工具执行状态。 */
interface UiToolProgress {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  durationMs?: number;
}

/** 当前（或最近一次）请求的处理过程反馈状态。 */
interface UiProgress {
  stage: "accepted" | "model" | "tool" | "done" | "stopped" | "failed";
  step: number;
  tools: UiToolProgress[];
  startedAtMs: number;
  finishedAtMs?: number;
  expanded: boolean;
  warning?: string;
  error?: string;
}

interface ChatViewProps {
  client: ApiClient;
  mediaAssets: MediaAsset[];
  selectedMediaIds: Set<string>;
  draft: string;
  modelCatalog: ModelsResponse | null;
  selectedModelId: string;
  sessionKey: number;
  /** 当前会话标题；新对话（尚未命名）时缺省。 */
  sessionTitle?: string;
  initialMessages: ChatSessionMessage[];
  onDraftChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
  onSaveSession: (messages: ChatSessionMessage[]) => void;
  onNewSession: () => void;
  onRequestMediaUpload: () => void;
  onToggleMedia: (mediaId: string) => void;
  onSent: () => void;
  toast: (message: string) => void;
}

export function ChatView({
  client,
  mediaAssets,
  selectedMediaIds,
  draft,
  modelCatalog,
  selectedModelId,
  sessionKey,
  sessionTitle,
  initialMessages,
  onDraftChange,
  onModelChange,
  onSaveSession,
  onNewSession,
  onRequestMediaUpload,
  onToggleMedia,
  onSent,
  toast,
}: ChatViewProps) {
  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<UiProgress | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<UiMessage[]>([]);
  const selected = mediaAssets.filter((item) => selectedMediaIds.has(item.mediaId));

  // 进行中的请求每 250ms 刷新一次本地时钟，驱动处理过程面板的累计耗时。
  const progressActive = progress !== null && progress.finishedAtMs === undefined;
  useEffect(() => {
    if (!progressActive) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [progressActive]);

  /** 同步维护 state 与 ref，保证保存会话时能拿到最新消息数组。 */
  function updateMessages(
    updater: (current: UiMessage[]) => UiMessage[],
  ) {
    const next = updater(messagesRef.current);
    messagesRef.current = next;
    setMessages(next);
  }

  // 会话切换/新建时：中止进行中的请求并加载目标会话消息。
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopAwake();
    const restored = initialMessages
      .filter((message) => message.role !== "system")
      .map(toUiMessage);
    messagesRef.current = restored;
    setMessages(restored);
    setConversation(restored.map(({ role, content }) => ({ role, content })));
    setRunning(false);
    setProgress(null);
    setPendingPermission(null);
  }, [sessionKey]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || running) return;
    // 长任务期间保持屏幕常亮，避免手机锁屏导致 SSE 连接被回收。
    void keepAwake();
    const requestAttachments = selected;
    const userMessage: ChatMessage = { role: "user", content: text };
    const nextConversation = [...conversation, userMessage];
    const assistantId = randomId();
    setConversation(nextConversation);
    updateMessages((current) => [
      ...current,
      {
        id: randomId(),
        role: "user",
        content: text,
        attachments: requestAttachments,
      },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        tools: [],
        streaming: true,
      },
    ]);
    onDraftChange("");
    setRunning(true);
    setProgress({
      stage: "accepted",
      step: 0,
      tools: [],
      startedAtMs: Date.now(),
      expanded: true,
    });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await client.chat(
        nextConversation,
        true,
        requestAttachments.map(({ mediaId, kind }) => ({ mediaId, kind })),
        selectedModelId,
        controller.signal,
      );
      if (!response.ok) throw new Error(await readError(response));
      const result = await consumeSse(
        response,
        (event) => handleStreamEvent(event, assistantId),
      );
      finalizeAssistant(assistantId, result);
      onSaveSession(toSessionMessages(messagesRef.current));
      setConversation((current) => [
        ...(result.contextMessages ?? current),
        { role: "assistant", content: result.content },
      ]);
      onSent();
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      setProgress((current) => current === null || current.finishedAtMs !== undefined
        ? current
        : {
            ...current,
            stage: stopped ? "stopped" : "failed",
            finishedAtMs: Date.now(),
            expanded: true,
            ...(stopped ? {} : { error: errorMessage(error) }),
          });
      updateMessages((current) => current.map((message) => (
        message.id === assistantId
          ? {
              ...message,
              streaming: false,
              content: message.content || (stopped ? "已停止。" : "请求失败。"),
              error: stopped ? undefined : errorMessage(error),
              meta: stopped ? "已由用户停止" : undefined,
            }
          : message
      )));
      if (!stopped) toast("对话请求失败：" + errorMessage(error));
    } finally {
      abortRef.current = null;
      setRunning(false);
      stopAwake();
    }
  }

  /** 消费一条 SSE 事件：同步更新助手消息与处理过程面板。 */
  function handleStreamEvent(event: ChatStreamEvent, assistantId: string) {
    switch (event.type) {
      case "reasoning":
        // 模型思考增量：追加到助手消息的思考块。
        updateMessages((current) => current.map((message) => (
          message.id === assistantId
            ? {
                ...message,
                reasoning: (message.reasoning ?? "") + event.content,
              }
            : message
        )));
        break;
      case "content":
        updateMessages((current) => current.map((message) => (
          message.id === assistantId
            ? { ...message, content: message.content + event.content }
            : message
        )));
        break;
      case "status":
        setProgress((current) => current === null ? current : {
          ...current,
          stage: event.stage === "accepted" ? "accepted"
            : event.stage === "model" ? "model"
            : event.stage === "tool" ? "tool"
            : current.stage,
          step: event.step ?? current.step,
        });
        break;
      case "tool_start":
        setProgress((current) => upsertProgressTool(current, {
          id: event.id,
          name: event.name,
          status: "running",
        }, event.step));
        break;
      case "permission_request":
        // 工具需要授权：弹出授权弹窗，决定提交后服务端在同一调用处恢复。
        setPendingPermission(event.request);
        break;
      case "tool_execution":
        updateMessages((current) => current.map((message) => (
          message.id === assistantId
            ? { ...message, tools: mergeTools(message.tools, event.execution) }
            : message
        )));
        setProgress((current) => upsertProgressTool(current, {
          id: event.execution.id ?? event.execution.name,
          name: event.execution.name,
          status: event.execution.status,
          durationMs: event.execution.durationMs,
        }));
        break;
      case "warning":
        setProgress((current) => current === null ? current : {
          ...current,
          warning: event.message,
        });
        break;
      case "done":
        setProgress((current) => current === null ? current : {
          ...current,
          stage: "done",
          finishedAtMs: Date.now(),
          expanded: false,
        });
        break;
      case "heartbeat":
      case "error":
        // 心跳仅用于保活；error 由 consumeSse 抛出后走统一失败路径。
        break;
    }
  }

  function finalizeAssistant(id: string, result: ChatResult) {
    updateMessages((current) => current.map((message) => (
      message.id === id
        ? {
            ...message,
            content: result.content || message.content || "空回复",
            tools: result.toolExecutions ?? message.tools,
            // 流式路径已累积全部轮次的思考；done 结果只带最终轮的完整值，为空时保留累积。
            ...(result.reasoning === undefined && message.reasoning === undefined
              ? {}
              : { reasoning: result.reasoning ?? message.reasoning }),
            meta: resultMeta(result, modelCatalog),
            streaming: false,
          }
        : message
    )));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <section className="view active">
      <div className="chat-layout">
        <div className="surface conversation">
          <div className="chat-heading">
            <span className="chat-title">{sessionTitle || "新对话"}</span>
          </div>
          <div className="chat-log" aria-live="polite">
            {messages.length === 0 && (
              <div className="empty-tip">输入消息开始对话。PanPilot 会按需调用已启用的工具。</div>
            )}
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                client={client}
                toast={toast}
              />
            ))}
          </div>

          <div className="composer">
            <form
              className="composer-form"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage();
              }}
            >
              <div className="composer-input-wrap">
                <label className="composer-label" htmlFor="composer-message">MESSAGE</label>
                <div className="composer-textarea-wrap">
                  <textarea
                    id="composer-message"
                    aria-label="消息内容"
                    value={draft}
                    onChange={(event) => onDraftChange(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="输入消息；Enter 发送，Shift + Enter 换行"
                  />
                  {running ? (
                    <button
                      className="composer-submit submit-stop"
                      type="button"
                      title="停止当前回复"
                      aria-label="停止当前回复"
                      onClick={() => abortRef.current?.abort()}
                    >
                      <Square aria-hidden="true" size={15} />
                    </button>
                  ) : (
                    <button
                      className={`composer-submit submit-send ${draft.trim() ? "is-ready" : ""}`}
                      type="submit"
                      disabled={!draft.trim()}
                      title="发送消息（Enter）"
                      aria-label="发送消息"
                    >
                      <ArrowUp aria-hidden="true" size={16} strokeWidth={2.4} />
                    </button>
                  )}
                </div>
                {selected.length > 0 && (
                  <div className="composer-attachments">
                    {selected.map((item) => (
                      <span className="composer-attachment" key={item.mediaId}>
                        <span className="attachment-chip-name">{item.name}</span>
                        <span className="attachment-chip-meta">
                          {kindLabel(item.kind)} · {formatSize(item.size)}
                        </span>
                        <button
                          className="icon-button"
                          type="button"
                          aria-label={`移除 ${item.name}`}
                          onClick={() => onToggleMedia(item.mediaId)}
                        >
                          <X aria-hidden="true" size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="composer-footer">
                  <div className="composer-tools">
                    <label className="model-picker compact">
                      <span>模型</span>
                      <select
                        aria-label="选择聊天模型"
                        value={selectedModelId}
                        disabled={running || !modelCatalog}
                        onChange={(event) => onModelChange(event.target.value)}
                      >
                        {!modelCatalog && <option value="">正在加载模型…</option>}
                        {modelCatalog?.models.map((model) => (
                          <option
                            key={model.id}
                            value={model.id}
                            disabled={model.status !== "available"}
                          >
                            {model.label}{model.status === "available" ? "" : "（未配置）"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="composer-tool"
                      type="button"
                      onClick={onRequestMediaUpload}
                    >
                      <Paperclip aria-hidden="true" size={14} />
                      附件
                    </button>
                    <button
                      className="composer-tool danger"
                      type="button"
                      onClick={onNewSession}
                      disabled={running}
                      title="清空对话并新建会话"
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      清空
                    </button>
                  </div>
                  <span className="composer-status">
                    {selected.length ? `已添加 ${selected.length} 个附件` : "未添加附件"}
                  </span>
                </div>
                {progress !== null && progress.finishedAtMs === undefined && (
                  <span className="composer-progress">
                    {composerProgressText(progress, nowMs)}
                  </span>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
      {pendingPermission !== null && (
        <PermissionModal
          request={pendingPermission}
          client={client}
          toast={toast}
          onDecided={() => setPendingPermission(null)}
        />
      )}
    </section>
  );
}

function MessageRow({
  message,
  client,
  toast,
}: {
  message: UiMessage;
  client: ApiClient;
  toast: (message: string) => void;
}) {
  const rowRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    return withMotion(() => {
      gsap.fromTo(
        row,
        { autoAlpha: 0, y: 10 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.3,
          ease: "power2.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    });
  }, []);

  return (
    <article
      ref={rowRef}
      className={`message ${message.role}${message.error ? " error" : ""}`}
    >
      <div className="message-author">{message.role === "user" ? "你" : "PanPilot"}</div>
      <div className="message-card">
        {message.reasoning ? (
          <details
            className="thinking"
            // 流式期间自动展开让用户看到思考进行，完成后收起可点击展开。
            key={message.streaming ? "thinking-open" : "thinking-closed"}
            open={message.streaming}
          >
            <summary>思考过程</summary>
            <div className="thinking-content">{message.reasoning}</div>
          </details>
        ) : null}
        <div className="message-content">
          {message.role === "assistant"
            ? <MarkdownContent text={message.content} client={client} toast={toast} />
            : <LinkedContent text={message.content} client={client} toast={toast} />}
          {message.streaming && <span className="cursor" />}
        </div>
        {message.attachments?.length ? (
          <div className="tool-list">
            {message.attachments.map((item) => (
              <span className="tool-chip" key={item.mediaId}>{item.name}</span>
            ))}
          </div>
        ) : null}
        {message.tools?.length ? (
          <div className="tool-list">
            {message.tools.map((tool, index) => (
              <span
                className={`tool-chip ${tool.status === "error" ? "error" : ""}`}
                key={tool.id ?? `${tool.name}-${index}`}
              >
                {tool.name} · {tool.status === "success" ? "成功" : "失败"}
              </span>
            ))}
          </div>
        ) : null}
        {message.meta && <div className="message-meta">{message.meta}</div>}
        {message.error && <div className="message-error">{message.error}</div>}
      </div>
    </article>
  );
}

const LINK_PATTERN = /(\/v1\/(?:media|artifacts)\/[A-Za-z0-9-]+|https?:\/\/[^\s<>"')\]]+)/g;

function LinkedContent({
  text,
  client,
  toast,
}: {
  text: string;
  client: ApiClient;
  toast: (message: string) => void;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    if (raw.startsWith("/v1/media/") || raw.startsWith("/v1/artifacts/")) {
      parts.push(
        <FileLink
          key={`${raw}-${index}`}
          url={raw}
          client={client}
          toast={toast}
        />,
      );
    } else {
      parts.push(
        <a key={`${raw}-${index}`} href={raw} target="_blank" rel="noreferrer">
          {raw}
        </a>,
      );
    }
    last = index + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

async function consumeSse(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<ChatResult> {
  if (!response.body) throw new Error("响应没有可读取的流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser<ChatStreamEvent>();
  let content = "";
  let doneResult: ChatResult | null = null;
  const tools: ToolExecution[] = [];

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
      if (event.type === "content") {
        content += event.content;
      } else if (event.type === "tool_execution") {
        tools.push(event.execution);
      } else if (event.type === "done") {
        doneResult = event.result;
      } else if (event.type === "error") {
        throw new Error(event.message || "Agent 调用失败");
      }
      onEvent(event);
    }
  }
  if (!doneResult) throw new Error("流意外结束，没有收到完成事件");
  return {
    ...doneResult,
    content: doneResult.content || content,
    toolExecutions: doneResult.toolExecutions ?? tools,
  };
}

function upsertProgressTool(
  progress: UiProgress | null,
  tool: UiToolProgress,
  step?: number,
): UiProgress | null {
  if (progress === null) return progress;
  const exists = progress.tools.some((item) => item.id === tool.id);
  return {
    ...progress,
    step: step ?? progress.step,
    tools: exists
      ? progress.tools.map((item) => item.id === tool.id ? { ...item, ...tool } : item)
      : [...progress.tools, tool],
  };
}

function mergeTools(current: ToolExecution[] | undefined, next: ToolExecution): ToolExecution[] {
  const tools = [...(current ?? [])];
  const index = tools.findIndex((item) => (item.id ?? item.name) === (next.id ?? next.name));
  if (index === -1) {
    tools.push(next);
  } else {
    tools[index] = next;
  }
  return tools;
}

function stageLabel(stage: UiProgress["stage"]): string {
  switch (stage) {
    case "accepted":
      return "已受理请求";
    case "model":
      return "等待模型响应";
    case "tool":
      return "正在执行工具";
    case "done":
      return "处理完成";
    case "stopped":
      return "已停止";
    case "failed":
      return "处理失败";
  }
}

/** 输入框下方的进行中状态小文本；仅在请求尚未结束时渲染。 */
function composerProgressText(progress: UiProgress, nowMs: number): string {
  const elapsedMs = Math.max(
    0,
    (progress.finishedAtMs ?? nowMs) - progress.startedAtMs,
  );
  return `${stageLabel(progress.stage)}… · 用时 ${formatDuration(elapsedMs)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function resultMeta(result: ChatResult, catalog: ModelsResponse | null): string {
  return [
    result.modelId ? modelDisplayLabel(catalog, result.modelId) : "",
    result.model ? `模型 ${result.model}` : "",
    result.steps === undefined ? "" : `${result.steps} 步`,
    result.totalTokens === undefined ? "" : `${result.totalTokens} tokens`,
    result.context === undefined
      ? ""
      : `已压缩 ${result.context.summarizedMessages} 条上下文`,
  ].filter(Boolean).join(" · ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function kindLabel(kind: MediaAsset["kind"]): string {
  switch (kind) {
    case "image":
      return "图片";
    case "audio":
      return "音频";
    case "text":
      return "文本";
    case "document":
      return "文档";
    case "binary":
      return "文件";
  }
}

/** 把服务端会话消息还原为 UI 消息（system 已在上层过滤）。 */
function toUiMessage(message: ChatSessionMessage): UiMessage {
  return {
    id: randomId(),
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((item) => ({
            mediaId: item.mediaId,
            name: item.name,
            size: item.size,
            kind: item.kind,
            mimeType: item.mimeType,
          })),
        }
      : {}),
  };
}

/** 把 UI 消息转为可持久化的会话消息（含附件引用，不含执行细节）。 */
function toSessionMessages(rows: UiMessage[]): ChatSessionMessage[] {
  return rows.map((row) => ({
    role: row.role,
    content: row.content,
    ...(row.attachments?.length
      ? {
          attachments: row.attachments.map((item) => ({
            mediaId: item.mediaId,
            name: item.name,
            size: item.size,
            kind: item.kind,
            mimeType: item.mimeType,
          })),
        }
      : {}),
  }));
}
