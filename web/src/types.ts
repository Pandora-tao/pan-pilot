export type ViewName = "chat" | "plugins" | "tasks" | "capabilities";

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

export interface FileAsset {
  fileId: string;
  name: string;
  size: number;
  downloadUrl?: string;
}

export interface MediaAsset {
  mediaId: string;
  name: string;
  size: number;
  kind: "image" | "audio" | "text" | "document" | "binary";
  mimeType: string;
}

export interface ToolExecution {
  id?: string;
  name: string;
  status: "success" | "error";
}

export interface ChatResult {
  content: string;
  modelId?: string;
  model: string;
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
