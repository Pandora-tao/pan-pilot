import {
  Paperclip,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { gsap } from "gsap";
import {
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiClient, downloadBlob, readError } from "../../api";
import { withMotion } from "../../animations";
import { modelDisplayLabel } from "../../model-selection";
import type {
  ChatMessage,
  ChatResult,
  MediaAsset,
  ModelsResponse,
  ToolExecution,
} from "../../types";

const SYSTEM_MESSAGE: ChatMessage = {
  role: "system",
  content: "你是 PanPilot，一个简洁、准确的 AI 助手。你可以使用计算器、当前时间、读取、创建与编辑 Word 文档等工具；使用工具前先说明你的计划。当工具返回下载地址时，把完整的 /v1/files/xxx 地址写在回复末尾，方便用户直接下载。",
};

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: MediaAsset[];
  tools?: ToolExecution[];
  meta?: string;
  error?: string;
  streaming?: boolean;
}

interface ChatViewProps {
  client: ApiClient;
  mediaAssets: MediaAsset[];
  selectedMediaIds: Set<string>;
  draft: string;
  modelCatalog: ModelsResponse | null;
  selectedModelId: string;
  onDraftChange: (value: string) => void;
  onModelChange: (modelId: string) => void;
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
  onDraftChange,
  onModelChange,
  onRequestMediaUpload,
  onToggleMedia,
  onSent,
  toast,
}: ChatViewProps) {
  const [conversation, setConversation] = useState<ChatMessage[]>([SYSTEM_MESSAGE]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const selected = mediaAssets.filter((item) => selectedMediaIds.has(item.mediaId));

  function clearChat() {
    if (running) return;
    setConversation([SYSTEM_MESSAGE]);
    setMessages([]);
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || running) return;
    const requestAttachments = selected;
    const userMessage: ChatMessage = { role: "user", content: text };
    const nextConversation = [...conversation, userMessage];
    const assistantId = crypto.randomUUID();
    setConversation(nextConversation);
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
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
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await client.chat(
        nextConversation,
        stream,
        requestAttachments.map(({ mediaId, kind }) => ({ mediaId, kind })),
        selectedModelId,
        controller.signal,
      );
      if (!response.ok) throw new Error(await readError(response));
      const result = stream
        ? await consumeSse(response, assistantId, setMessages)
        : normalizeNonStreaming(await response.json());
      finalizeAssistant(assistantId, result);
      setConversation((current) => [
        ...(result.contextMessages ?? current),
        { role: "assistant", content: result.content },
      ]);
      onSent();
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      setMessages((current) => current.map((message) => (
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
    }
  }

  function finalizeAssistant(id: string, result: ChatResult) {
    setMessages((current) => current.map((message) => (
      message.id === id
        ? {
            ...message,
            content: result.content || message.content || "空回复",
            tools: result.toolExecutions ?? message.tools,
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
                <textarea
                  id="composer-message"
                  aria-label="消息内容"
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入消息；Enter 发送，Shift + Enter 换行"
                />
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
                    <label className="stream-toggle">
                      <input
                        type="checkbox"
                        checked={stream}
                        onChange={(event) => setStream(event.target.checked)}
                      />
                      流式输出
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
                      onClick={clearChat}
                      disabled={running}
                      title="清空对话"
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      清空
                    </button>
                  </div>
                  <span className="composer-status">
                    {selected.length ? `已添加 ${selected.length} 个附件` : "未添加附件"}
                  </span>
                </div>
              </div>
              <div className="composer-actions">
                <button
                  className="composer-stop"
                  type="button"
                  disabled={!running}
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square aria-hidden="true" size={14} />
                  停止
                </button>
                <button
                  className={`composer-send ${draft.trim() && !running ? "is-ready" : ""}`}
                  type="submit"
                  disabled={running || !draft.trim()}
                >
                  <Send aria-hidden="true" size={17} />
                  发送
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
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
        <div className="message-content">
          <LinkedContent text={message.content} client={client} toast={toast} />
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

const LINK_PATTERN = /(\/v1\/files\/[A-Za-z0-9-]+|https?:\/\/[^\s<>"')\]]+)/g;

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
    if (raw.startsWith("/v1/files/")) {
      parts.push(
        <button
          className="inline-link"
          type="button"
          key={`${raw}-${index}`}
          onClick={async () => {
            try {
              const response = await client.request(raw);
              if (!response.ok) throw new Error(await readError(response));
              downloadBlob(await response.blob(), "download.docx");
            } catch (error) {
              toast("下载失败：" + errorMessage(error));
            }
          }}
        >
          {raw}
        </button>,
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
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>,
): Promise<ChatResult> {
  if (!response.body) throw new Error("响应没有可读取的流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let doneResult: ChatResult | null = null;
  const tools: ToolExecution[] = [];

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const line = raw.split("\n").find((entry) => entry.startsWith("data: "));
      if (line) {
        const event = JSON.parse(line.slice(6)) as {
          type: string;
          content?: string;
          execution?: ToolExecution;
          result?: ChatResult;
          message?: string;
        };
        if (event.type === "content") {
          content += event.content ?? "";
        } else if (event.type === "tool_execution" && event.execution) {
          tools.push(event.execution);
        } else if (event.type === "done" && event.result) {
          doneResult = event.result;
        } else if (event.type === "error") {
          throw new Error(event.message ?? "Agent 调用失败");
        }
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content, tools: [...tools] } : message
        )));
      }
      separator = buffer.indexOf("\n\n");
    }
  }
  if (!doneResult) throw new Error("流意外结束，没有收到完成事件");
  return {
    ...doneResult,
    content: doneResult.content || content,
    toolExecutions: doneResult.toolExecutions ?? tools,
  };
}

function normalizeNonStreaming(data: {
  message?: string;
  modelId?: string;
  model?: string;
  usage?: { totalTokens?: number };
  execution?: {
    toolExecutions?: ToolExecution[];
    context?: ChatResult["context"];
    contextMessages?: ChatMessage[];
  };
}): ChatResult {
  return {
    content: data.message ?? "",
    modelId: data.modelId,
    model: data.model ?? "",
    totalTokens: data.usage?.totalTokens,
    toolExecutions: data.execution?.toolExecutions ?? [],
    context: data.execution?.context,
    contextMessages: data.execution?.contextMessages,
  };
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
