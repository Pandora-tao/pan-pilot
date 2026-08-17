import { gsap } from "gsap";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError } from "./api";
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
  ChatSessionMessage,
  ConsoleSettings,
  MediaAsset,
  ModelsResponse,
  PluginStatus,
  PluginSuggestion,
  SessionSummary,
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [sessionMessages, setSessionMessages] = useState<ChatSessionMessage[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Set<string>>(new Set());
  const [chatDraft, setChatDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(!initial.token);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [directUpload, setDirectUpload] = useState(false);
  const mediaInput = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const requireLogin = useCallback(() => setLoginOpen(true), []);
  const client = useMemo(
    () => new ApiClient(settings.baseUrl, settings.token, requireLogin),
    [requireLogin, settings],
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
      if (!isUnauthorized(error)) toast("能力状态获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshModels = useCallback(async () => {
    try {
      const catalog = await client.models();
      setModelCatalog(catalog);
      setSelectedModelId((current) => chooseModelId(catalog, current));
    } catch (error) {
      setModelCatalog(null);
      if (!isUnauthorized(error)) toast("模型目录获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshPlugins = useCallback(async () => {
    try {
      setPlugins(await client.plugins());
    } catch (error) {
      if (!isUnauthorized(error)) toast("插件状态获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshPluginSuggestions = useCallback(async () => {
    try {
      setPluginSuggestions(await client.pluginSuggestions());
    } catch (error) {
      if (!isUnauthorized(error)) toast("待安装插件获取失败：" + errorMessage(error));
    }
  }, [client, toast]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await client.sessions());
    } catch (error) {
      if (!isUnauthorized(error)) toast("会话列表获取失败：" + errorMessage(error));
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
    void refreshSessions();
    const timer = window.setInterval(() => void checkHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [
    checkHealth,
    refreshCapabilities,
    refreshModels,
    refreshPluginSuggestions,
    refreshPlugins,
    refreshSessions,
  ]);

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

  function newSession() {
    setCurrentSessionId(null);
    setSessionMessages([]);
    setChatDraft("");
    setSelectedMediaIds(new Set());
    setSessionKey((current) => current + 1);
  }

  async function selectSession(sessionId: string) {
    if (sessionId === currentSessionId) return;
    try {
      const { session } = await client.getSession(sessionId);
      setCurrentSessionId(session.id);
      setSessionMessages(session.messages);
      setChatDraft("");
      setSelectedMediaIds(new Set());
      setSessionKey((current) => current + 1);
    } catch (error) {
      toast("会话读取失败：" + errorMessage(error));
    }
  }

  async function deleteSession(sessionId: string) {
    try {
      await client.deleteSession(sessionId);
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      if (sessionId === currentSessionId) newSession();
      toast("会话已删除");
    } catch (error) {
      toast("会话删除失败：" + errorMessage(error));
    }
  }

  async function saveSession(messages: ChatSessionMessage[]) {
    try {
      if (currentSessionId === null) {
        const created = await client.createSession();
        setCurrentSessionId(created.session.id);
        await client.saveSession(created.session.id, { messages });
      } else {
        await client.saveSession(currentSessionId, { messages });
      }
      void refreshSessions();
    } catch (error) {
      toast("会话保存失败：" + errorMessage(error));
    }
  }

  async function login(password: string) {
    setLoginBusy(true);
    setLoginError("");
    try {
      // 登录请求不携带旧通行证，避免把失效凭证与密码验证混在一起。
      const result = await new ApiClient(settings.baseUrl, "").login(password);
      setSettings((current) => ({ ...current, token: result.passport }));
      setLoginOpen(false);
      toast("验证通过，通行证已保存在浏览器");
    } catch (error) {
      setLoginError(errorMessage(error));
    } finally {
      setLoginBusy(false);
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
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewSession={newSession}
          onSelectSession={selectSession}
          onDeleteSession={deleteSession}
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
              sessionKey={sessionKey}
              initialMessages={sessionMessages}
              onSaveSession={saveSession}
              onNewSession={newSession}
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
          const baseUrlChanged = next.baseUrl !== settings.baseUrl;
          setSettings({ ...next, token: baseUrlChanged ? "" : settings.token });
          setSettingsOpen(false);
          if (baseUrlChanged) setLoginOpen(true);
          toast("连接设置已保存");
        }}
        onClear={() => {
          setSettings({ baseUrl: DEFAULT_BASE_URL, token: "" });
          setSettingsOpen(false);
          setLoginOpen(true);
          toast("本地设置已清除");
        }}
        onLogin={() => {
          setSettingsOpen(false);
          setLoginError("");
          setLoginOpen(true);
        }}
        onLogout={() => {
          setSettings((current) => ({ ...current, token: "" }));
          setSettingsOpen(false);
          setLoginOpen(true);
          toast("浏览器通行证已清除");
        }}
      />

      <LoginModal
        open={loginOpen}
        baseUrl={settings.baseUrl}
        busy={loginBusy}
        error={loginError}
        onClose={() => setLoginOpen(false)}
        onLogin={(password) => void login(password)}
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
  onLogin,
  onLogout,
}: {
  open: boolean;
  settings: ConsoleSettings;
  onClose: () => void;
  onSave: (settings: ConsoleSettings) => void;
  onClear: () => void;
  onLogin: () => void;
  onLogout: () => void;
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
              token: settings.token,
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
        <div className="auth-status">
          <span>登录状态</span>
          <strong>{settings.token ? "浏览器已保存通行证" : "尚未验证"}</strong>
          <button type="button" onClick={onLogin}>
            {settings.token ? "重新验证" : "输入密码"}
          </button>
          {settings.token && <button type="button" onClick={onLogout}>退出登录</button>}
        </div>
      </form>
    </Modal>
  );
}

function LoginModal({
  open,
  baseUrl,
  busy,
  error,
  onClose,
  onLogin,
}: {
  open: boolean;
  baseUrl: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onLogin: (password: string) => void;
}) {
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (open) setPassword("");
  }, [open]);

  return (
    <Modal
      open={open}
      title="验证访问密码"
      onClose={onClose}
      footer={(
        <button
          className="primary"
          type="button"
          disabled={busy || password.length === 0}
          onClick={() => onLogin(password)}
        >
          {busy ? "验证中…" : "验证并登录"}
        </button>
      )}
    >
      <form
        className="settings-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && password) onLogin(password);
        }}
      >
        <p className="auth-note">验证成功后，签名通行证将保存在当前浏览器中。</p>
        {isInsecureRemoteUrl(baseUrl) && (
          <p className="auth-warning">当前连接使用 HTTP，密码和通行证在网络传输中不会加密。</p>
        )}
        <label className="field">
          <span>访问密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入控制台访问密码"
            autoComplete="current-password"
          />
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
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

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isInsecureRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && url.hostname !== "localhost"
      && url.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}
