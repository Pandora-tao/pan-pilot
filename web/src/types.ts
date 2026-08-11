export type ViewName = "chat" | "assets" | "plugins" | "approvals" | "capabilities";

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

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "expired";

export interface ApprovalPreview {
  summary: string;
  changes: string[];
  riskSummary: string;
}

export interface Approval {
  id: string;
  hash: string;
  type: string;
  status: ApprovalStatus;
  expiresAt: string;
  preview: ApprovalPreview;
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
  kind: "image" | "audio";
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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
