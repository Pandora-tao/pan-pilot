import { gsap } from "gsap";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError } from "./api";
import { withMotion } from "./animations";
import { Modal } from "./components/Modal";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./features/chat/ChatView";
import { SettingsView } from "./features/settings/SettingsView";
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
  SettingsTab,
  ViewName,
} from "./types";

const STORAGE_KEY = "panpilot.console";
const DEFAULT_BASE_URL = location.origin && location.origin !== "null"
  ? location.origin
  : "http://127.0.0.1:3000";

interface StoredConsoleState extends ConsoleSettings {
  activeView?: ViewName;
  settingsTab?: SettingsTab;
  selectedModelId?: string;
}

export function App() {
  const initial = useMemo(loadStoredState, []);
  const [settings, setSettings] = useState<ConsoleSettings>({
    baseUrl: initial.baseUrl,
    token: initial.token,
  });
  const [activeView, setActiveView] = useState<ViewName>(initial.activeView ?? "chat");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initial.settingsTab ?? "connection");
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
  // 服务端是否要求控制台密码登录；null=未知（拿不到状态时按需鉴权兜底）。
  const [loginRequired, setLoginRequired] = useState<boolean | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [directUpload, setDirectUpload] = useState(false);
  const mediaInput = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const requireLogin = useCallback(() => {
    // 只在服务端明确未启用访问密码时抑制登录框；未知或需要登录时照常拉起。
    setLoginOpen((open) => open || loginRequired !== false);
  }, [loginRequired]);
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
        settingsTab,
        selectedModelId,
      } satisfies StoredConsoleState));
    } catch {
      // 浏览器隐私模式下保持内存态。
    }
  }, [activeView, selectedModelId, settings, settingsTab]);

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

  // 进入设置页时刷新插件/建议/能力，保证页签计数与内容新鲜。
  useEffect(() => {
    if (activeView !== "settings") return;
    void refreshCapabilities();
    void refreshPlugins();
    void refreshPluginSuggestions();
  }, [activeView, refreshCapabilities, refreshPluginSuggestions, refreshPlugins]);

  // 由服务端鉴权状态决定是否要求登录：本地未配置访问密码时完全不弹框，
  // 生产（token + 密码都配置）在没有有效通行证时弹出且不可关闭。
  // 拿不到状态时保持“未知”，由 401 路径兜底拉起登录框。
  useEffect(() => {
    setLoginRequired(null);
    setLoginOpen(false);
    void (async () => {
      try {
        const { loginRequired } = await new ApiClient(settings.baseUrl, "").authStatus();
        setLoginRequired(loginRequired);
        if (!loginRequired) {
          // 开放访问的服务没有可验证凭证，清掉浏览器可能残留的旧通行证。
          setSettings((current) => (current.token ? { ...current, token: "" } : current));
        } else if (!settings.token) {
          setLoginOpen(true);
        }
      } catch {
        // 状态未知：需要鉴权的环境仍会通过 401 拉起重试。
      }
    })();
    // 仅随 baseUrl 切换重新判定；settings.token 在切换地址时已被清空。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.baseUrl]);

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

  const handleSaveSettings = useCallback((next: ConsoleSettings) => {
    const baseUrlChanged = next.baseUrl !== settings.baseUrl;
    setSettings({ ...next, token: baseUrlChanged ? "" : settings.token });
    // 换地址后由基于新 baseUrl 的鉴权状态检查决定是否弹登录框。
    if (baseUrlChanged) setLoginOpen(false);
    toast("连接设置已保存");
  }, [settings.baseUrl, settings.token, toast]);

  const handleClearLocal = useCallback(() => {
    setSettings({ baseUrl: DEFAULT_BASE_URL, token: "" });
    setLoginOpen(loginRequired !== false);
    toast("本地设置已清除");
  }, [loginRequired, toast]);

  const handleOpenLogin = useCallback(() => {
    if (loginRequired === false) return;
    setLoginError("");
    setLoginOpen(true);
  }, [loginRequired]);

  const handleLogout = useCallback(() => {
    setSettings((current) => ({ ...current, token: "" }));
    setLoginOpen(loginRequired !== false);
    toast("浏览器通行证已清除");
  }, [loginRequired, toast]);

  const counts = {
    plugins: plugins.length,
    tasks: taskCount,
    capabilities: Object.keys(capabilities?.capabilities ?? {}).length,
  };

  return (
    <>
      <div className={`app-shell${activeView === "settings" ? " app-shell--settings" : ""}`}>
        <Sidebar
          health={health}
          baseUrl={settings.baseUrl}
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewSession={newSession}
          onSelectSession={selectSession}
          onDeleteSession={deleteSession}
          onOpenSettings={() => setActiveView("settings")}
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
            {activeView === "settings" && (
              <SettingsView
                activeTab={settingsTab}
                onTabChange={setSettingsTab}
                onBack={() => setActiveView("chat")}
                counts={counts}
                settings={settings}
                health={health}
                loginRequired={loginRequired}
                onSaveSettings={handleSaveSettings}
                onClearLocal={handleClearLocal}
                onOpenLogin={handleOpenLogin}
                onLogout={handleLogout}
                client={client}
                plugins={plugins}
                suggestions={pluginSuggestions}
                refreshPlugins={() => Promise.all([
                  refreshPlugins(),
                  refreshPluginSuggestions(),
                ]).then(() => undefined)}
                modelCatalog={modelCatalog}
                onTaskCountChange={setTaskCount}
                capabilities={capabilities}
                refreshCapabilities={refreshCapabilities}
                toast={toast}
              />
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

      <LoginModal
        open={loginOpen}
        baseUrl={settings.baseUrl}
        busy={loginBusy}
        error={loginError}
        // 服务端要求登录（生产）时弹框不可关闭；开放访问（本地）不显示弹框。
        closable={loginRequired === false}
        onClose={() => setLoginOpen(false)}
        onLogin={(password) => void login(password)}
      />

      <div className={`toast ${toastMessage ? "show" : ""}`} role="status" aria-live="polite">
        {toastMessage}
      </div>
    </>
  );
}

function LoginModal({
  open,
  baseUrl,
  busy,
  error,
  closable,
  onClose,
  onLogin,
}: {
  open: boolean;
  baseUrl: string;
  busy: boolean;
  error: string;
  closable: boolean;
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
      closable={closable}
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
      // 旧版 activeView（plugins/tasks/capabilities）映射为设置页 + 对应页签。
      ...parseStoredView(parsed.activeView),
      ...(isSettingsTab(parsed.settingsTab) ? { settingsTab: parsed.settingsTab } : {}),
      ...(typeof parsed.selectedModelId === "string"
        ? { selectedModelId: parsed.selectedModelId }
        : {}),
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, token: "" };
  }
}

/** 解析存储的 activeView：旧版非对话视图映射为设置页及其页签。 */
function parseStoredView(value: unknown): Partial<StoredConsoleState> {
  if (value === "chat") return { activeView: "chat" };
  if (value === "plugins" || value === "tasks" || value === "capabilities") {
    return { activeView: "settings", settingsTab: value };
  }
  return {};
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return value === "connection"
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
