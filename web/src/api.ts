import type {
  CapabilitiesResponse,
  ChatSession,
  ChatMessage,
  ChatSessionMessage,
  MediaAsset,
  ModelsResponse,
  PluginStatus,
  PluginSuggestion,
  SessionSummary,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTasksResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly onUnauthorized?: () => void,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const response = await fetch(
      this.baseUrl.replace(/\/+$/, "") + path,
      { ...init, headers },
    );
    return response;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) {
      const error = new ApiError(await readError(response), response.status);
      if (response.status === 401) this.onUnauthorized?.();
      throw error;
    }
    return response.json() as Promise<T>;
  }

  login(password: string): Promise<{ passport: string; expiresAt: string }> {
    return this.json("/v1/auth/login", jsonBody("POST", { password }));
  }

  health(): Promise<{ status: string }> {
    return this.json("/health");
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.json("/v1/capabilities");
  }

  models(): Promise<ModelsResponse> {
    return this.json("/v1/models");
  }

  async plugins(): Promise<PluginStatus[]> {
    const data = await this.json<{ plugins: PluginStatus[] }>("/v1/plugins");
    return data.plugins ?? [];
  }

  async pluginSuggestions(): Promise<PluginSuggestion[]> {
    const data = await this.json<{ suggestions: PluginSuggestion[] }>(
      "/v1/plugins/suggestions",
    );
    return data.suggestions ?? [];
  }

  async reloadPlugins(): Promise<{ result: { applied: boolean; plugins: PluginStatus[] } }> {
    return this.json("/v1/plugins/reload", { method: "POST" });
  }

  async setPluginEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ plugin: PluginStatus }> {
    return this.json(
      `/v1/plugins/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    );
  }

  installPlugin(manifest: unknown): Promise<unknown> {
    return this.json("/v1/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
  }

  installPluginSuggestion(id: string): Promise<unknown> {
    return this.json(`/v1/plugins/suggestions/${encodeURIComponent(id)}/install`, {
      method: "POST",
    });
  }

  dismissPluginSuggestion(id: string): Promise<unknown> {
    return this.json(`/v1/plugins/suggestions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  scheduledTasks(): Promise<ScheduledTasksResponse> {
    return this.json("/v1/scheduled-tasks");
  }

  async scheduledTaskRuns(taskId?: string, limit = 50): Promise<ScheduledTaskRun[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (taskId) query.set("taskId", taskId);
    const data = await this.json<{ runs: ScheduledTaskRun[] }>(
      `/v1/scheduled-task-runs?${query}`,
    );
    return data.runs;
  }

  createScheduledTask(input: ScheduledTaskInput): Promise<{ task: ScheduledTask }> {
    return this.json("/v1/scheduled-tasks", jsonBody("POST", input));
  }

  updateScheduledTask(id: string, input: ScheduledTaskInput): Promise<{ task: ScheduledTask }> {
    return this.json(`/v1/scheduled-tasks/${encodeURIComponent(id)}`, jsonBody("PUT", input));
  }

  deleteScheduledTask(id: string): Promise<unknown> {
    return this.request(`/v1/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) throw new ApiError(await readError(response), response.status);
      });
  }

  async sessions(): Promise<SessionSummary[]> {
    const data = await this.json<{ sessions: SessionSummary[] }>("/v1/sessions");
    return data.sessions ?? [];
  }

  createSession(): Promise<{ session: ChatSession }> {
    return this.json("/v1/sessions", { method: "POST" });
  }

  getSession(id: string): Promise<{ session: ChatSession }> {
    return this.json(`/v1/sessions/${encodeURIComponent(id)}`);
  }

  saveSession(
    id: string,
    input: { title?: string; messages: ChatSessionMessage[] },
  ): Promise<{ session: ChatSession }> {
    return this.json(
      `/v1/sessions/${encodeURIComponent(id)}`,
      jsonBody("PUT", input),
    );
  }

  deleteSession(id: string): Promise<unknown> {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) throw new ApiError(await readError(response), response.status);
      });
  }

  setScheduledTaskEnabled(id: string, enabled: boolean): Promise<{ task: ScheduledTask }> {
    return this.json(
      `/v1/scheduled-tasks/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    );
  }

  runScheduledTask(id: string): Promise<{ run: ScheduledTaskRun }> {
    return this.json(`/v1/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
  }

  pauseScheduledTaskRun(id: string): Promise<{ run: ScheduledTaskRun }> {
    return this.json(
      `/v1/scheduled-task-runs/${encodeURIComponent(id)}/pause`,
      { method: "POST" },
    );
  }

  resumeScheduledTaskRun(id: string): Promise<{ run: ScheduledTaskRun }> {
    return this.json(
      `/v1/scheduled-task-runs/${encodeURIComponent(id)}/resume`,
      { method: "POST" },
    );
  }

  resolveScheduledTaskRunRecovery(
    id: string,
    action: "retry" | "terminate",
  ): Promise<{ run: ScheduledTaskRun }> {
    return this.json(
      `/v1/scheduled-task-runs/${encodeURIComponent(id)}/recovery`,
      jsonBody("POST", { action }),
    );
  }

  async uploadMedia(file: File): Promise<MediaAsset> {
    const body = new FormData();
    body.append("file", file);
    return this.json("/v1/media", { method: "POST", body });
  }

  deleteMedia(mediaId: string): Promise<unknown> {
    return this.json(`/v1/media/${mediaId}`, { method: "DELETE" });
  }

  chat(
    messages: ChatMessage[],
    stream: boolean,
    attachments: Array<{
      mediaId: string;
      kind: "image" | "audio" | "text" | "document" | "binary";
    }>,
    modelId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.request("/v1/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify({
        messages,
        stream,
        ...(modelId ? { model: modelId } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
      signal,
    });
  }
}

function jsonBody(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function readError(response: Response): Promise<string> {
  try {
    const data = await response.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
