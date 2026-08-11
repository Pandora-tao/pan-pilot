import {
  Paperclip,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { ApiClient, downloadBlob, readError } from "../../api";
import { ViewHeader } from "../../components/ViewHeader";
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
  onClearSelected: () => void;
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
  onClearSelected,
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
    const nextConversation = trimHistory([...conversation, userMessage]);
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
      setConversation((current) => trimHistory([
        ...current,
        { role: "assistant", content: result.content },
      ]));
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
      <ViewHeader
        number="01"
        title="与 Agent 对话"
        description="发送消息、观察工具执行过程，并把已上传的图片或音频附加到本次请求。"
        actions={(
          <>
            <label className="model-picker">
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
            <button type="button" onClick={clearChat} disabled={running}>
              <Trash2 aria-hidden="true" size={16} />
              清空对话
            </button>
          </>
        )}
      />

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
            <div className="composer-row">
              <textarea
                aria-label="消息内容"
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息；Enter 发送，Shift + Enter 换行"
              />
              <div className="composer-actions">
                <button
                  className="danger"
                  type="button"
                  disabled={!running}
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square aria-hidden="true" size={15} />
                  停止
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={running || !draft.trim()}
                  onClick={() => void sendMessage()}
                >
                  <Send aria-hidden="true" size={16} />
                  发送
                </button>
              </div>
            </div>
            <div className="composer-meta">
              <label>
                <input
                  type="checkbox"
                  checked={stream}
                  onChange={(event) => setStream(event.target.checked)}
                />
                流式输出
              </label>
              <button className="quiet small" type="button" onClick={onRequestMediaUpload}>
                <Paperclip aria-hidden="true" size={15} />
                添加图片或音频
              </button>
              <span>{selected.length ? `已添加 ${selected.length} 个附件` : "未添加附件"}</span>
            </div>
          </div>
        </div>

        <aside className="context-column">
          <section className="surface">
            <div className="section-head">
              <h3>本次附件</h3>
              <button className="small" type="button" onClick={onClearSelected}>
                全部移除
              </button>
            </div>
            {selected.length ? (
              <div className="attachment-list">
                {selected.map((item) => (
                  <div className="attachment-item" key={item.mediaId}>
                    <div>
                      <div className="attachment-name">{item.name}</div>
                      <div className="attachment-meta">
                        {item.kind === "image" ? "图片" : "音频"} · {formatSize(item.size)}
                      </div>
                    </div>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`移除 ${item.name}`}
                      onClick={() => onToggleMedia(item.mediaId)}
                    >
                      <X aria-hidden="true" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="selected-empty">从资产页选择，或直接上传图片和音频。</div>
            )}
          </section>
          <section className="surface">
            <div className="section-head"><h3>请求说明</h3></div>
            <div className="section-body">
              <p className="context-note">
                图片会调用 <code>analyze_image</code>。音频会根据请求调用{" "}
                <code>transcribe_audio</code> 或 <code>analyze_audio</code>。
              </p>
            </div>
          </section>
        </aside>
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
  return (
    <article className={`message ${message.role} ${message.error ? "error" : ""}`}>
      <div className="message-role">{message.role === "user" ? "YOU" : "AI"}</div>
      <div className="message-body">
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
  execution?: { toolExecutions?: ToolExecution[] };
}): ChatResult {
  return {
    content: data.message ?? "",
    modelId: data.modelId,
    model: data.model ?? "",
    totalTokens: data.usage?.totalTokens,
    toolExecutions: data.execution?.toolExecutions ?? [],
  };
}

function resultMeta(result: ChatResult, catalog: ModelsResponse | null): string {
  return [
    result.modelId ? modelDisplayLabel(catalog, result.modelId) : "",
    result.model ? `模型 ${result.model}` : "",
    result.steps === undefined ? "" : `${result.steps} 步`,
    result.totalTokens === undefined ? "" : `${result.totalTokens} tokens`,
  ].filter(Boolean).join(" · ");
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 60) return messages;
  return [messages[0] ?? SYSTEM_MESSAGE, ...messages.slice(-55)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
