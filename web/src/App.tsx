import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClient } from "./api";
import { Modal } from "./components/Modal";
import { Sidebar } from "./components/Sidebar";
import { ApprovalsView } from "./features/approvals/ApprovalsView";
import { AssetsView } from "./features/assets/AssetsView";
import { CapabilitiesView } from "./features/capabilities/CapabilitiesView";
import { ChatView } from "./features/chat/ChatView";
import { PluginsView } from "./features/plugins/PluginsView";
import { chooseModelId } from "./model-selection";
import type {
  Approval,
  CapabilitiesResponse,
  ConsoleSettings,
  FileAsset,
  MediaAsset,
  ModelsResponse,
  PluginStatus,
  ViewName,
} from "./types";

const STORAGE_KEY = "panpilot.console";
const DEFAULT_BASE_URL = location.origin && location.origin !== "null"
  ? location.origin
  : "http://127.0.0.1:3000";

interface StoredConsoleState extends ConsoleSettings {
  activeView?: ViewName;
  selectedModelId?: string;
}

export function App() {
  const initial = useMemo(loadStoredState, []);
  const [settings, setSettings] = useState<ConsoleSettings>({
    baseUrl: initial.baseUrl,
    token: initial.token,
  });
  const [activeView, setActiveView] = useState<ViewName>(initial.activeView ?? "chat");
  const [health, setHealth] = useState<"checking" | "ok" | "error">("checking");
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelsResponse | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(initial.selectedModelId ?? "");
  const [plugins, setPlugins] = useState<PluginStatus[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [files, setFiles] = useState<FileAsset[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approvalPrompt, setApprovalPrompt] = useState<{
    approval: Approval;
    title: string;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState("");
  const [directUpload, setDirectUpload] = useState(false);
  const mediaInput = useRef<HTMLInputElement>(null);
  const client = useMemo(
    () => new ApiClient(settings.baseUrl, settings.token),
    [settings],
  );

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => {
      setToastMessage((current) => current === message ? "" : current);
    }, 2800);
  }, []);

  const refreshCapabilities = useCallback(async () => {
    try {
      setCapabilities(await client.capabilities());
    } catch (error) {
      toast("能力状态获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshModels = useCallback(async () => {
    try {
      const catalog = await client.models();
      setModelCatalog(catalog);
      setSelectedModelId((current) => chooseModelId(catalog, current));
    } catch (error) {
      setModelCatalog(null);
      toast("模型目录获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshPlugins = useCallback(async () => {
    try {
      setPlugins(await client.plugins());
    } catch (error) {
      toast("插件状态获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals(await client.approvals());
    } catch (error) {
      toast("审批记录获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const checkHealth = useCallback(async () => {
    try {
      const result = await client.health();
      setHealth(result.status === "ok" ? "ok" : "error");
    } catch {
      setHealth("error");
    }
  }, [client]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...settings,
        activeView,
        selectedModelId,
      } satisfies StoredConsoleState));
    } catch {
      // 浏览器隐私模式下保持内存态。
    }
  }, [activeView, selectedModelId, settings]);

  useEffect(() => {
    setHealth("checking");
    void checkHealth();
    void refreshCapabilities();
    void refreshModels();
    void refreshPlugins();
    void refreshApprovals();
    const timer = window.setInterval(() => void checkHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [checkHealth, refreshApprovals, refreshCapabilities, refreshModels, refreshPlugins]);

  function toggleMedia(mediaId: string) {
    setSelectedMediaIds((current) => {
      const next = new Set(current);
      if (next.has(mediaId)) next.delete(mediaId);
      else next.add(mediaId);
      return next;
    });
  }

  async function uploadFromChat(file: File) {
    setDirectUpload(true);
    try {
      const uploaded = await client.uploadMedia(file);
      setMedia((current) => [uploaded, ...current]);
      setSelectedMediaIds((current) => new Set(current).add(uploaded.mediaId));
      toast("媒体已上传并添加到本次对话");
    } catch (error) {
      toast("上传失败：" + errorMessage(error));
    } finally {
      setDirectUpload(false);
      if (mediaInput.current) mediaInput.current.value = "";
    }
  }

  async function confirmApproval() {
    if (!approvalPrompt) return;
    try {
      await client.approve(approvalPrompt.approval);
      await client.execute(approvalPrompt.approval);
      setApprovalPrompt(null);
      await Promise.all([refreshApprovals(), refreshPlugins()]);
      toast("审批动作已执行");
    } catch (error) {
      toast("审批执行失败：" + errorMessage(error));
    }
  }

  const counts = {
    assets: files.length + media.length,
    plugins: plugins.length,
    approvals: approvals.filter(({ status }) => (
      status === "pending" || status === "approved"
    )).length,
    capabilities: Object.keys(capabilities?.capabilities ?? {}).length,
  };

  return (
    <>
      <div className="app-shell">
        <Sidebar
          activeView={activeView}
          onChangeView={setActiveView}
          onOpenSettings={() => setSettingsOpen(true)}
          health={health}
          baseUrl={settings.baseUrl}
          counts={counts}
        />
        <main className="workspace">
          {activeView === "chat" && (
            <ChatView
              client={client}
              mediaAssets={media}
              selectedMediaIds={selectedMediaIds}
              draft={chatDraft}
              modelCatalog={modelCatalog}
              selectedModelId={selectedModelId}
              onDraftChange={setChatDraft}
              onModelChange={setSelectedModelId}
              onRequestMediaUpload={() => mediaInput.current?.click()}
              onToggleMedia={toggleMedia}
              onClearSelected={() => setSelectedMediaIds(new Set())}
              onSent={() => setSelectedMediaIds(new Set())}
              toast={toast}
            />
          )}
          {activeView === "assets" && (
            <AssetsView
              client={client}
              files={files}
              media={media}
              selectedMediaIds={selectedMediaIds}
              onFilesChange={setFiles}
              onMediaChange={setMedia}
              onToggleMedia={toggleMedia}
              onUseDocument={(fileId) => {
                setChatDraft(`请读取文档 ${fileId} 并总结内容；如需要，再修改一处可以改进的文字。`);
                setActiveView("chat");
              }}
              toast={toast}
            />
          )}
          {activeView === "plugins" && (
            <PluginsView
              client={client}
              plugins={plugins}
              refresh={refreshPlugins}
              requestApproval={(approval, title) => setApprovalPrompt({ approval, title })}
              toast={toast}
            />
          )}
          {activeView === "approvals" && (
            <ApprovalsView
              client={client}
              approvals={approvals}
              refresh={refreshApprovals}
              requestApproval={(approval, title) => setApprovalPrompt({ approval, title })}
              toast={toast}
            />
          )}
          {activeView === "capabilities" && (
            <CapabilitiesView data={capabilities} refresh={refreshCapabilities} />
          )}
        </main>
      </div>

      <input
        ref={mediaInput}
        type="file"
        hidden
        disabled={directUpload}
        accept=".png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadFromChat(file);
        }}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => {
          setSettings(next);
          setSettingsOpen(false);
          toast("连接设置已保存");
        }}
        onClear={() => {
          setSettings({ baseUrl: DEFAULT_BASE_URL, token: "" });
          setSettingsOpen(false);
          toast("本地设置已清除");
        }}
      />

      <Modal
        open={approvalPrompt !== null}
        title={approvalPrompt?.title ?? "确认审批"}
        onClose={() => setApprovalPrompt(null)}
        footer={(
          <>
            <button type="button" onClick={() => setApprovalPrompt(null)}>取消</button>
            <button className="primary" type="button" onClick={() => void confirmApproval()}>
              批准并执行
            </button>
          </>
        )}
      >
        {approvalPrompt && (
          <>
            <strong>{approvalPrompt.approval.preview.summary}</strong>
            <div className="preview-block">
              <h3>影响</h3>
              <ul>
                {approvalPrompt.approval.preview.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </div>
            <div className="preview-block">
              <h3>风险</h3>
              <p>{approvalPrompt.approval.preview.riskSummary}</p>
            </div>
          </>
        )}
      </Modal>

      <div className={`toast ${toastMessage ? "show" : ""}`} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </>
  );
}

function SettingsModal({
  open,
  settings,
  onClose,
  onSave,
  onClear,
}: {
  open: boolean;
  settings: ConsoleSettings;
  onClose: () => void;
  onSave: (settings: ConsoleSettings) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings, open]);

  return (
    <Modal
      open={open}
      title="连接设置"
      onClose={onClose}
      footer={(
        <>
          <button type="button" onClick={onClear}>清除本地保存</button>
          <button
            className="primary"
            type="button"
            onClick={() => onSave({
              baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
              token: draft.token.trim(),
            })}
          >
            保存
          </button>
        </>
      )}
    >
      <form className="settings-grid" onSubmit={(event) => event.preventDefault()}>
        <label className="field">
          <span>服务地址</span>
          <input
            type="url"
            value={draft.baseUrl}
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            placeholder="http://127.0.0.1:3000"
          />
        </label>
        <label className="field">
          <span>API Token</span>
          <input
            type="password"
            value={draft.token}
            onChange={(event) => setDraft({ ...draft, token: event.target.value })}
            placeholder="服务端未配置时留空"
            autoComplete="off"
          />
        </label>
      </form>
    </Modal>
  );
}

function loadStoredState(): StoredConsoleState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { baseUrl: DEFAULT_BASE_URL, token: "" };
    const parsed = JSON.parse(raw) as Partial<StoredConsoleState>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULT_BASE_URL,
      token: typeof parsed.token === "string" ? parsed.token : "",
      ...(isViewName(parsed.activeView) ? { activeView: parsed.activeView } : {}),
      ...(typeof parsed.selectedModelId === "string"
        ? { selectedModelId: parsed.selectedModelId }
        : {}),
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, token: "" };
  }
}

function isViewName(value: unknown): value is ViewName {
  return value === "chat"
    || value === "assets"
    || value === "plugins"
    || value === "approvals"
    || value === "capabilities";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
