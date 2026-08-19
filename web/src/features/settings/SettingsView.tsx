import { Activity, ArrowLeft, Clock3, Link2, Plug, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClient } from "../../api";
import { ViewHeader } from "../../components/ViewHeader";
import { CapabilitiesView } from "../capabilities/CapabilitiesView";
import { PluginsView } from "../plugins/PluginsView";
import { TasksView } from "../tasks/TasksView";
import { PermissionsView } from "./PermissionsView";
import type {
  CapabilitiesResponse,
  ConsoleSettings,
  ModelsResponse,
  PluginSuggestion,
  PluginStatus,
  SettingsTab,
} from "../../types";

const tabs: Array<{
  id: SettingsTab;
  label: string;
  icon: typeof Link2;
}> = [
  { id: "connection", label: "连接", icon: Link2 },
  { id: "plugins", label: "插件", icon: Plug },
  { id: "tasks", label: "任务", icon: Clock3 },
  { id: "permissions", label: "权限", icon: Shield },
  { id: "capabilities", label: "能力", icon: Activity },
];

interface SettingsViewProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onBack: () => void;
  counts: Partial<Record<SettingsTab, number>>;
  /** 连接页签 */
  settings: ConsoleSettings;
  health: "checking" | "ok" | "error";
  /** 服务端是否要求控制台密码登录；null=未知。 */
  loginRequired: boolean | null;
  onSaveSettings: (settings: ConsoleSettings) => void;
  onClearLocal: () => void;
  onOpenLogin: () => void;
  onLogout: () => void;
  /** 插件页签 */
  client: ApiClient;
  plugins: PluginStatus[];
  suggestions: PluginSuggestion[];
  refreshPlugins: () => Promise<void>;
  /** 任务页签 */
  modelCatalog: ModelsResponse | null;
  onTaskCountChange: (count: number) => void;
  /** 权限页签 */
  onPermissionCountChange?: (count: number) => void;
  /** 能力页签 */
  capabilities: CapabilitiesResponse | null;
  refreshCapabilities: () => Promise<void>;
  toast: (message: string) => void;
}

/** 设置页：以页签组织连接、插件、任务与能力。 */
export function SettingsView({
  activeTab,
  onTabChange,
  onBack,
  counts,
  settings,
  health,
  loginRequired,
  onSaveSettings,
  onClearLocal,
  onOpenLogin,
  onLogout,
  client,
  plugins,
  suggestions,
  refreshPlugins,
  modelCatalog,
  onTaskCountChange,
  onPermissionCountChange,
  capabilities,
  refreshCapabilities,
  toast,
}: SettingsViewProps) {
  return (
    <section className="view active settings-view">
      <ViewHeader
        title="设置"
        description="管理服务连接、插件、计划任务与能力状态。"
        actions={(
          <button type="button" onClick={onBack}>
            <ArrowLeft aria-hidden="true" size={16} />返回对话
          </button>
        )}
      />

      <div className="settings-tabs" role="tablist" aria-label="设置页签">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            className={`settings-tab${activeTab === id ? " active" : ""}`}
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => onTabChange(id)}
          >
            <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
            <span>{label}</span>
            {id !== "connection" && (
              <span className="nav-count">{counts[id] ?? 0}</span>
            )}
          </button>
        ))}
      </div>

      <div className="settings-tab-content" role="tabpanel">
        {activeTab === "connection" && (
          <ConnectionSection
            settings={settings}
            health={health}
            loginRequired={loginRequired}
            onSave={onSaveSettings}
            onClear={onClearLocal}
            onLogin={onOpenLogin}
            onLogout={onLogout}
          />
        )}
        {activeTab === "plugins" && (
          <PluginsView
            client={client}
            plugins={plugins}
            suggestions={suggestions}
            refresh={refreshPlugins}
            toast={toast}
          />
        )}
        {activeTab === "tasks" && (
          <TasksView
            client={client}
            modelCatalog={modelCatalog}
            toast={toast}
            onCountChange={onTaskCountChange}
          />
        )}
        {activeTab === "permissions" && (
          <PermissionsView
            client={client}
            toast={toast}
            onCountChange={onPermissionCountChange}
          />
        )}
        {activeTab === "capabilities" && (
          <CapabilitiesView data={capabilities} refresh={refreshCapabilities} />
        )}
      </div>
    </section>
  );
}

function ConnectionSection({
  settings,
  health,
  loginRequired,
  onSave,
  onClear,
  onLogin,
  onLogout,
}: {
  settings: ConsoleSettings;
  health: "checking" | "ok" | "error";
  loginRequired: boolean | null;
  onSave: (settings: ConsoleSettings) => void;
  onClear: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings]);

  return (
    <div className="surface section-stack connection-section">
      <div className="section-head">
        <div>
          <h3>服务连接</h3>
          <p>PanPilot 服务地址与登录状态。</p>
        </div>
        <span className="health" title="GET /health">
          <span className={`dot ${health}`} />
          <span>
            <strong>
              {health === "ok" ? "服务正常" : health === "error" ? "无法连接" : "检查中"}
            </strong>
            <span>{settings.baseUrl}</span>
          </span>
        </span>
      </div>
      <form
        className="settings-grid connection-form"
        onSubmit={(event) => event.preventDefault()}
      >
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
          {loginRequired === false ? (
            <strong>本服务未启用访问密码</strong>
          ) : (
            <>
              <strong>{settings.token ? "浏览器已保存通行证" : "尚未验证"}</strong>
              <button type="button" onClick={onLogin}>
                {settings.token ? "重新验证" : "输入密码"}
              </button>
              {settings.token && <button type="button" onClick={onLogout}>退出登录</button>}
            </>
          )}
        </div>
        <div className="connection-actions">
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
        </div>
      </form>
    </div>
  );
}
