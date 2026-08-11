import type {
  Approval,
  CapabilitiesResponse,
  ChatMessage,
  FileAsset,
  MediaAsset,
  ModelsResponse,
  PluginStatus,
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
    if (!response.ok) throw new ApiError(await readError(response), response.status);
    return response.json() as Promise<T>;
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

  async approvals(): Promise<Approval[]> {
    const data = await this.json<{ approvals: Approval[] }>("/v1/plugins/approvals");
    return data.approvals ?? [];
  }

  async reloadPlugins(): Promise<{ approval?: Approval; applied?: boolean; plugins?: PluginStatus[] }> {
    return this.json("/v1/plugins/reload", { method: "POST" });
  }

  async setPluginEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ approval?: Approval }> {
    return this.json(
      `/v1/plugins/${encodeURIComponent(name)}/${enabled ? "enable" : "disable"}`,
      { method: "POST" },
    );
  }

  async createPluginDraft(manifest: unknown): Promise<Approval> {
    const data = await this.json<{ approval: Approval }>("/v1/plugins/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: { type: "create_plugin", manifest } }),
    });
    return data.approval;
  }

  approve(approval: Approval): Promise<unknown> {
    return this.json(`/v1/plugins/approvals/${approval.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: approval.hash }),
    });
  }

  reject(approval: Approval): Promise<unknown> {
    return this.json(`/v1/plugins/approvals/${approval.id}/reject`, {
      method: "POST",
    });
  }

  execute(approval: Approval): Promise<unknown> {
    return this.json(`/v1/plugins/approvals/${approval.id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: approval.hash }),
    });
  }

  async uploadFile(file: File): Promise<FileAsset> {
    const body = new FormData();
    body.append("file", file);
    return this.json("/v1/files", { method: "POST", body });
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
    attachments: Array<{ mediaId: string; kind: "image" | "audio" }>,
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
