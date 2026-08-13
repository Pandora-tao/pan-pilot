import { gsap } from "gsap";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiClient } from "./api";
import { withMotion } from "./animations";
import { Modal } from "./components/Modal";
import { Sidebar } from "./components/Sidebar";
import { CapabilitiesView } from "./features/capabilities/CapabilitiesView";
import { ChatView } from "./features/chat/ChatView";
import { PluginsView } from "./features/plugins/PluginsView";
import { TasksView } from "./features/tasks/TasksView";
import { chooseModelId } from "./model-selection";
import type {
  CapabilitiesResponse,
  ConsoleSettings,
  MediaAsset,
  ModelsResponse,
  PluginStatus,
  PluginSuggestion,
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
  const [pluginSuggestions, setPluginSuggestions] = useState<PluginSuggestion[]>([]);
  const [taskCount, setTaskCount] = useState(0);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [directUpload, setDirectUpload] = useState(false);
  const mediaInput = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const client = useMemo(
    () => new ApiClient(settings.baseUrl, settings.token),
    [settings],
  );

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    return withMotion(() => {
      const view = workspace.querySelector<HTMLElement>(".view");
      if (!view) return;
      gsap.fromTo(
        view,
        { autoAlpha: 0, y: 14 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.42,
          ease: "power3.out",
          clearProps: "transform,opacity,visibility",
        },
      );
      gsap.fromTo(
        Array.from(view.children),
        { autoAlpha: 0, y: 10 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.38,
          stagger: 0.06,
          delay: 0.05,
          ease: "power2.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    });
  }, [activeView]);

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

  const refreshPluginSuggestions = useCallback(async () => {
    try {
      setPluginSuggestions(await client.pluginSuggestions());
    } catch (error) {
      toast("待安装插件获取失败：" + errorMessage(error));
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
    void refreshPluginSuggestions();
    const timer = window.setInterval(() => void checkHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [checkHealth, refreshCapabilities, refreshModels, refreshPluginSuggestions, refreshPlugins]);

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
      toast("附件已上传并添加到本次对话");
    } catch (error) {
      toast("上传失败：" + errorMessage(error));
    } finally {
      setDirectUpload(false);
      if (mediaInput.current) mediaInput.current.value = "";
    }
  }

  const counts = {
    plugins: plugins.length,
    tasks: taskCount,
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
        <main ref={workspaceRef} className={`workspace workspace-${activeView}`}>
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
              onSent={() => setSelectedMediaIds(new Set())}
              toast={toast}
            />
          )}
          {activeView === "plugins" && (
            <PluginsView
              client={client}
              plugins={plugins}
              suggestions={pluginSuggestions}
              refresh={() => Promise.all([
                refreshPlugins(),
                refreshPluginSuggestions(),
              ]).then(() => undefined)}
              toast={toast}
            />
          )}
          {activeView === "tasks" && (
            <TasksView
              client={client}
              modelCatalog={modelCatalog}
              toast={toast}
              onCountChange={setTaskCount}
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
    || value === "plugins"
    || value === "tasks"
    || value === "capabilities";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
