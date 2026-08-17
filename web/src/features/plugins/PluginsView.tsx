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

  return (
    <div className="plugins-body">
      <div className="tab-toolbar">
        <p>选择安装 Agent 推荐的插件，或粘贴 manifest 安装；已安装插件可直接启用和禁用。</p>
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
      <div className="plugin-grid">
        <section className="surface section-stack">
          <div className="section-head">
            <div>
              <h3>待安装</h3>
              <p>Agent 的建议不会自动安装，由你决定。</p>
            </div>
            <span className="section-count">{suggestions.length}</span>
          </div>
          {suggestions.length ? (
            <div className="record-list">
              {suggestions.map((suggestion) => (
                <div className="suggestion-item" key={suggestion.id}>
                  <div className="record-name">
                    {suggestion.preview.pluginName}
                    <StatusBadge status={suggestion.preview.executorType} />
                  </div>
                  <div className="record-meta">{suggestion.preview.summary}</div>
                  <p className="suggestion-risk">{suggestion.preview.riskSummary}</p>
                  <div className="item-actions suggestion-actions">
                    <button
                      className="small primary"
                      type="button"
                      disabled={busyKey !== ""}
                      onClick={() => void run(
                        `install-${suggestion.id}`,
                        () => client.installPluginSuggestion(suggestion.id),
                        `插件 ${suggestion.preview.pluginName} 已安装`,
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
              ))}
            </div>
          ) : (
            <div className="empty-tip">没有待安装建议。</div>
          )}

          <div className="manifest-install">
            <label htmlFor="plugin-manifest">从 manifest 安装</label>
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
          </div>
        </section>

        <section className="surface section-stack">
          <div className="section-head">
            <div>
              <h3>已安装</h3>
              <p>启停立即影响 Agent 可使用的工具。</p>
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
                      <StatusBadge status={plugin.state} />
                    </div>
                    <div className="record-meta">
                      {plugin.toolNames.length
                        ? `工具：${plugin.toolNames.join(", ")}`
                        : "当前未向 Agent 注册工具"}
                      {plugin.loadedAt
                        ? ` · 加载于 ${new Date(plugin.loadedAt).toLocaleString()}`
                        : ""}
                    </div>
                    {plugin.error && <div className="record-error">{plugin.error}</div>}
                  </div>
                  <div className="item-actions">
                    <button
                      className="small"
                      type="button"
                      disabled={busyKey !== "" || plugin.state === "error"}
                      onClick={() => void run(
                        `toggle-${plugin.name}`,
                        () => client.setPluginEnabled(plugin.name, !plugin.enabled),
                        `插件 ${plugin.name} 已${plugin.enabled ? "禁用" : "启用"}`,
                      )}
                    >
                      <Power aria-hidden="true" size={14} />
                      {plugin.enabled ? "禁用" : "启用"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-tip">没有安装任何插件。</div>
          )}
        </section>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
