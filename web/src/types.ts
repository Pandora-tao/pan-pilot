export type ViewName = "chat" | "settings";

/** 设置页内的页签：连接 / 插件 / 任务 / 能力。 */
export type SettingsTab = "connection" | "plugins" | "tasks" | "capabilities";

export interface ConsoleSettings {
  baseUrl: string;
  token: string;
}

export type CapabilityStatus = "available" | "blocked" | "reserved" | string;

export interface Capability {
  status: CapabilityStatus;
  streaming?: boolean;
  [key: string]: unknown;
}

export interface CapabilitiesResponse {
  apiVersion: string;
  capabilities: Record<string, Capability>;
}

export interface ChatModelOption {
  id: string;
  provider: "volcengine" | "deepseek" | string;
  label: string;
  upstreamModel: string;
  status: "available" | "unavailable";
  reason?: "missing_api_key" | string;
}

export interface ModelsResponse {
  defaultModelId: string;
  models: ChatModelOption[];
}

export interface PluginStatus {
  name: string;
  state: "loaded" | "disabled" | "error";
  enabled: boolean;
  toolNames: string[];
  loadedAt?: string;
  error?: string;
  /** manifest 描述，用于展示插件用途；加载失败时缺省。 */
  description?: string;
  /** 执行器类型：内置引用或 HTTP 请求。 */
  executorType?: "builtin" | "http";
  /** HTTP 型插件的完整目标 URL；builtin 型缺省。 */
  httpUrl?: string;
}

export interface PluginInstallPreview {
  summary: string;
  changes: string[];
  riskSummary: string;
  pluginName: string;
  executorType: "builtin" | "http";
  targetHost?: string;
  httpMethod?: string;
  envVarNames?: string[];
}

export interface PluginSuggestion {
  id: string;
  createdAt: string;
  preview: PluginInstallPreview;
}

export type TaskSchedule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekday: number; time: string }
  | { type: "cron"; expression: string };

export interface ScheduledTaskInput {
  name: string;
  prompt: string;
  modelId: string;
  enabled: boolean;
  schedule: TaskSchedule;
}

export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestRun?: ScheduledTaskRunSummary;
}

export type ScheduledTaskRunStatus =
  | "queued" | "running" | "pausing" | "paused" | "needs_confirmation"
  | "succeeded" | "failed" | "timed_out"
  | "skipped_overlap" | "skipped_misfire" | "interrupted";

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  trigger: "scheduled" | "manual";
  status: ScheduledTaskRunStatus;
  task: { taskId: string; name: string; prompt: string; modelId: string; schedule: TaskSchedule };
  scheduledFor: string | null;
  queuedAt: string;
  startedAt?: string;
  pauseRequestedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  finishedAt?: string;
  content?: string;
  error?: string;
  model?: string;
  totalTokens?: number;
  steps?: number;
  toolExecutions?: ToolExecution[];
  recoveryReason?: string;
  context?: ContextUsage;
}

export type ScheduledTaskRunSummary = Pick<ScheduledTaskRun,
  "id" | "taskId" | "trigger" | "status" | "scheduledFor" | "queuedAt"
> & Partial<Pick<ScheduledTaskRun,
  "startedAt" | "pauseRequestedAt" | "pausedAt" | "resumedAt"
  | "finishedAt" | "error" | "model"
>>;

export interface ScheduledTasksResponse {
  serverNow: string;
  serverTimeZone: string;
  scheduler: { status: "available" | "unavailable"; reason?: string };
  tasks: ScheduledTask[];
}

export interface MediaAsset {
  mediaId: string;
  name: string;
  size: number;
  kind: "image" | "audio" | "text" | "document" | "binary";
  mimeType: string;
}

export interface SessionAttachment {
  mediaId: string;
  name: string;
  kind: MediaAsset["kind"];
  size: number;
  mimeType: string;
}

export interface ChatSessionMessage {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: SessionAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatSessionMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ToolExecution {
  id?: string;
  name: string;
  status: "success" | "error";
  durationMs?: number;
}

/** /v1/chat SSE 事件集合：控制台据此渲染处理过程反馈。 */
export type ChatStreamStage = "accepted" | "model" | "tool" | string;

export interface ChatStatusEvent {
  type: "status";
  stage: ChatStreamStage;
  step?: number;
  elapsedMs?: number;
}

export interface ChatToolStartEvent {
  type: "tool_start";
  id: string;
  name: string;
  step?: number;
}

export interface ChatToolExecutionEvent {
  type: "tool_execution";
  execution: ToolExecution;
}

export interface ChatContentEvent {
  type: "content";
  content: string;
}

/** 模型思考/推理内容增量（思维链），客户端可折叠展示。 */
export interface ChatReasoningEvent {
  type: "reasoning";
  content: string;
}

export interface ChatHeartbeatEvent {
  type: "heartbeat";
  elapsedMs: number;
  stage?: ChatStreamStage;
}

export interface ChatWarningEvent {
  type: "warning";
  code?: string;
  message: string;
  elapsedMs?: number;
}

export interface ChatDoneEvent {
  type: "done";
  result: ChatResult;
}

export interface ChatErrorEvent {
  type: "error";
  error: string;
  message: string;
  elapsedMs?: number;
}

export type ChatStreamEvent =
  | ChatStatusEvent
  | ChatToolStartEvent
  | ChatToolExecutionEvent
  | ChatReasoningEvent
  | ChatContentEvent
  | ChatHeartbeatEvent
  | ChatWarningEvent
  | ChatDoneEvent
  | ChatErrorEvent;

export interface ChatResult {
  content: string;
  modelId?: string;
  model: string;
  /** 模型思考/推理内容（思维链），不持久化到会话。 */
  reasoning?: string;
  steps?: number;
  totalTokens?: number;
  toolExecutions?: ToolExecution[];
  context?: ContextUsage;
  contextMessages?: ChatMessage[];
}

export interface ContextUsage {
  compactions: number;
  summarizedMessages: number;
  estimatedInputTokens: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
