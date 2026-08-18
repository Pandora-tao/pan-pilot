import { Download, Power, RefreshCw, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { ApiClient } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import type { PluginStatus, PluginSuggestion } from "../../types";

interface PluginsViewProps {
  client: ApiClient;
  plugins: PluginStatus[];
  suggestions: PluginSuggestion[];
  refresh: () => Promise<void>;
  toast: (message: string) => void;
}

/** 设置 → 插件：已安装插件启停、Agent 建议安装、manifest 手动安装。 */
export function PluginsView({
  client,
  plugins,
  suggestions,
  refresh,
  toast,
}: PluginsViewProps) {
  const [manifestText, setManifestText] = useState("");
  const [busyKey, setBusyKey] = useState("");

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusyKey(key);
    try {
      await action();
      await refresh();
      toast(success);
    } catch (error) {
      toast("操作失败：" + errorMessage(error));
    } finally {
      setBusyKey("");
    }
  }

  async function installManifest() {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      toast("manifest 不是合法 JSON");
      return;
    }
    await run("install-manifest", () => client.installPlugin(manifest), "插件已安装并启用");
    setManifestText("");
  }

  const enabledCount = plugins.filter((plugin) => plugin.enabled).length;

  return (
    <div className="plugins-body">
      <div className="tab-toolbar">
        <p>已安装插件可直接启用、禁用；Agent 的建议由你选择安装或忽略，也可以粘贴 manifest 手动安装。</p>
        <div className="view-actions">
          <button type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={16} />刷新
          </button>
          <button
            className="primary"
            type="button"
            disabled={busyKey !== ""}
            onClick={() => void run("reload", () => client.reloadPlugins(), "插件已重新加载")}
          >
            <RotateCcw aria-hidden="true" size={16} />重新加载
          </button>
        </div>
      </div>

      <div className="plugins-stack">
        <section className="surface section-stack">
          <div className="section-head">
            <div>
              <h3>已安装插件</h3>
              <p>启用 {enabledCount}/{plugins.length} · 启停立即影响 Agent 可使用的工具。</p>
            </div>
            <span className="section-count">{plugins.length}</span>
          </div>
          {plugins.length ? (
            <div className="record-list">
              {plugins.map((plugin) => (
                <div className="record-item" key={plugin.name}>
                  <div>
                    <div className="record-name">
                      {plugin.name}
                      {plugin.executorType && <StatusBadge status={plugin.executorType} />}
                      <StatusBadge status={plugin.state} />
                    </div>
                    <p className="record-desc">
                      {plugin.description || "（此插件未提供描述）"}
                    </p>
                    <div className="record-meta">
                      {plugin.executorType === "http" && plugin.httpUrl ? (
                        <>
                          <span className="plugin-endpoint">{plugin.httpUrl}</span>
                          <span aria-hidden="true"> · </span>
                        </>
                      ) : null}
                      {plugin.loadedAt
                        ? `加载于 ${new Date(plugin.loadedAt).toLocaleString()}`
                        : "尚未加载"}
                    </div>
                    {plugin.error && <div className="record-error">{plugin.error}</div>}
                  </div>
                  <div className="item-actions">
                    {plugin.state === "error" ? (
                      <span className="disabled-note">加载失败，不可启停</span>
                    ) : (
                      <button
                        className="small"
                        type="button"
                        disabled={busyKey !== ""}
                        onClick={() => void run(
                          `toggle-${plugin.name}`,
                          () => client.setPluginEnabled(plugin.name, !plugin.enabled),
                          `插件 ${plugin.name} 已${plugin.enabled ? "禁用" : "启用"}`,
                        )}
                      >
                        <Power aria-hidden="true" size={14} />
                        {plugin.enabled ? "禁用" : "启用"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-tip">没有安装任何插件。</div>
          )}
        </section>

        <section className="surface section-stack">
          <div className="section-head">
            <div>
              <h3>待安装建议</h3>
              <p>Agent 的建议不会自动安装，由你决定。</p>
            </div>
            <span className="section-count">{suggestions.length}</span>
          </div>
          {suggestions.length ? (
            <div className="record-list">
              {suggestions.map((suggestion) => {
                const { preview } = suggestion;
                return (
                  <div className="suggestion-item" key={suggestion.id}>
                    <div className="record-name">
                      {preview.pluginName}
                      <StatusBadge status={preview.executorType} />
                    </div>
                    <p className="suggestion-summary">{preview.summary}</p>
                    {preview.executorType === "http"
                      && (preview.targetHost || preview.envVarNames?.length) && (
                      <div className="record-meta">
                        {preview.httpMethod && preview.targetHost
                          ? `${preview.httpMethod} ${preview.targetHost}`
                          : preview.targetHost}
                        {preview.envVarNames?.length
                          ? ` · 引用环境变量：${preview.envVarNames.join(", ")}`
                          : ""}
                      </div>
                    )}
                    <p className="suggestion-risk">{preview.riskSummary}</p>
                    <div className="item-actions suggestion-actions">
                      <button
                        className="small primary"
                        type="button"
                        disabled={busyKey !== ""}
                        onClick={() => void run(
                          `install-${suggestion.id}`,
                          () => client.installPluginSuggestion(suggestion.id),
                          `插件 ${preview.pluginName} 已安装`,
                        )}
                      >
                        <Download aria-hidden="true" size={14} />安装
                      </button>
                      <button
                        className="small"
                        type="button"
                        disabled={busyKey !== ""}
                        onClick={() => void run(
                          `dismiss-${suggestion.id}`,
                          () => client.dismissPluginSuggestion(suggestion.id),
                          "已忽略插件建议",
                        )}
                      >
                        <X aria-hidden="true" size={14} />忽略
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-tip">没有待安装建议。</div>
          )}
        </section>

        <details className="manifest-install">
          <summary>从 manifest 安装</summary>
          <textarea
            id="plugin-manifest"
            value={manifestText}
            onChange={(event) => setManifestText(event.target.value)}
            placeholder="粘贴声明式插件 manifest JSON"
          />
          <button
            className="primary"
            type="button"
            disabled={busyKey !== "" || !manifestText.trim()}
            onClick={() => void installManifest()}
          >
            <Download aria-hidden="true" size={15} />安装插件
          </button>
        </details>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
