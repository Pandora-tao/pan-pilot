import { Download, Power, RefreshCw, RotateCcw, Undo2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiClient } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import type { PluginCandidate, PluginStatus, PluginSuggestion } from "../../types";

interface PluginsViewProps {
  client: ApiClient;
  plugins: PluginStatus[];
  suggestions: PluginSuggestion[];
  refresh: () => Promise<void>;
  toast: (message: string) => void;
}

/** 设置 → 插件：已安装插件启停、沙箱扩展版本管理、Agent 建议安装、待审核扩展、manifest 安装。 */
export function PluginsView({
  client,
  plugins,
  suggestions,
  refresh,
  toast,
}: PluginsViewProps) {
  const [manifestText, setManifestText] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [candidates, setCandidates] = useState<PluginCandidate[]>([]);

  const refreshCandidates = async () => {
    try {
      setCandidates(await client.pluginCandidates());
    } catch {
      // 自我扩展未启用或不可用：保持空列表。
    }
  };

  useEffect(() => {
    void refreshCandidates();
  }, [client]);

  async function run(key: string, action: () => Promise<unknown>, success: string) {
    setBusyKey(key);
    try {
      await action();
      await refresh();
      await refreshCandidates();
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
  const packages = plugins.filter((plugin) => plugin.kind === "sandbox-js");

  return (
    <div className="plugins-body">
      <div className="tab-toolbar">
        <p>已安装插件可直接启用、禁用；沙箱扩展支持版本管理与回滚。Agent 的建议由你选择安装或忽略。</p>
        <div className="view-actions">
          <button type="button" onClick={() => void run("refresh", async () => {}, "已刷新")}>
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
                      {plugin.kind === "sandbox-js" && <StatusBadge status="sandbox-js" label="沙箱" />}
                      {plugin.executorType && <StatusBadge status={plugin.executorType} />}
                      <StatusBadge status={plugin.state} />
                      {plugin.activeVersion && <span className="record-meta">v{plugin.activeVersion}</span>}
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
                        : plugin.version ? `版本 ${plugin.version}` : "尚未加载"}
                    </div>
                    {plugin.error && <div className="record-error">{plugin.error}</div>}
                  </div>
                  <div className="item-actions">
                    {plugin.kind === "sandbox-js" ? (
                      <>
                        <button
                          className="small"
                          type="button"
                          disabled={busyKey !== ""}
                          onClick={() => void run(
                            `rollback-${plugin.name}`,
                            () => client.rollbackPackage(plugin.name),
                            `扩展 ${plugin.name} 已回滚`,
                          )}
                        >
                          <Undo2 aria-hidden="true" size={14} />回滚
                        </button>
                        <button
                          className="small primary"
                          type="button"
                          disabled={busyKey !== ""}
                          onClick={() => void run(
                            `toggle-${plugin.name}`,
                            () => client.setPluginEnabled(plugin.name, !plugin.enabled),
                            `扩展 ${plugin.name} 已${plugin.enabled ? "禁用" : "启用"}`,
                          )}
                        >
                          <Power aria-hidden="true" size={14} />
                          {plugin.enabled ? "禁用" : "启用"}
                        </button>
                        <button
                          className="small danger"
                          type="button"
                          disabled={busyKey !== ""}
                          onClick={() => void run(
                            `uninstall-${plugin.name}`,
                            () => client.uninstallPackage(plugin.name),
                            `扩展 ${plugin.name} 已卸载`,
                          )}
                        >
                          <Trash2 aria-hidden="true" size={14} />卸载
                        </button>
                      </>
                    ) : (
                      plugin.state === "error" ? (
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
                      )
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
              <h3>待审核扩展</h3>
              <p>Agent 提交的沙箱扩展候选包；安装必须由你确认（携带不可变摘要）。</p>
            </div>
            <span className="section-count">{candidates.length}</span>
          </div>
          {candidates.length ? (
            <div className="record-list">
              {candidates.map((candidate) => (
                <div className="record-item" key={candidate.id}>
                  <div>
                    <div className="record-name">
                      {candidate.name}
                      <StatusBadge status="sandbox-js" label="沙箱" />
                      <span className="record-meta">v{candidate.version}</span>
                    </div>
                    <p className="record-desc">摘要：{candidate.digest}</p>
                    <div className="record-meta">创建于 {new Date(candidate.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="item-actions">
                    <button
                      className="small"
                      type="button"
                      disabled={busyKey !== ""}
                      onClick={() => void run(
                        `reject-${candidate.id}`,
                        () => client.discardPluginCandidate(candidate.id),
                        "已拒绝该候选包",
                      )}
                    >
                      <X aria-hidden="true" size={14} />拒绝
                    </button>
                    <button
                      className="small primary"
                      type="button"
                      disabled={busyKey !== ""}
                      onClick={() => void run(
                        `install-${candidate.id}`,
                        () => client.installPluginCandidate(candidate.id, candidate.digest),
                        `扩展 ${candidate.name} 已安装并启用`,
                      )}
                    >
                      <Download aria-hidden="true" size={14} />安装并启用
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-tip">没有待审核的扩展。</div>
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
