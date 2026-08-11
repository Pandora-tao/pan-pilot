import { Power, RefreshCw, RotateCcw } from "lucide-react";
import { ApiClient } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { ViewHeader } from "../../components/ViewHeader";
import type { Approval, PluginStatus } from "../../types";

interface PluginsViewProps {
  client: ApiClient;
  plugins: PluginStatus[];
  refresh: () => Promise<void>;
  requestApproval: (approval: Approval, title: string) => void;
  toast: (message: string) => void;
}

export function PluginsView({
  client,
  plugins,
  refresh,
  requestApproval,
  toast,
}: PluginsViewProps) {
  async function reload() {
    try {
      const result = await client.reloadPlugins();
      if (result.approval) {
        requestApproval(result.approval, "重新加载全部插件");
        return;
      }
      await refresh();
      toast(result.applied ? "插件已重新加载" : "重载未应用，旧注册表保持不变");
    } catch (error) {
      toast("重载失败：" + errorMessage(error));
    }
  }

  async function setEnabled(plugin: PluginStatus) {
    try {
      const result = await client.setPluginEnabled(plugin.name, !plugin.enabled);
      if (result.approval) {
        requestApproval(
          result.approval,
          `${plugin.enabled ? "禁用" : "启用"}插件 ${plugin.name}`,
        );
        return;
      }
      await refresh();
    } catch (error) {
      toast("操作失败：" + errorMessage(error));
    }
  }

  return (
    <section className="view active">
      <ViewHeader
        number="03"
        title="工具插件"
        description="查看 manifest 白名单加载结果。重载、启用和禁用都需要审批。"
        actions={(
          <>
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" size={16} />刷新
            </button>
            <button className="primary" type="button" onClick={() => void reload()}>
              <RotateCcw aria-hidden="true" size={16} />重新加载
            </button>
          </>
        )}
      />

      <section className="surface section-stack">
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
                      : "未注册工具"}
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
                    disabled={plugin.state === "error"}
                    onClick={() => void setEnabled(plugin)}
                  >
                    <Power aria-hidden="true" size={14} />
                    {plugin.enabled ? "禁用" : "启用"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-tip">没有加载任何插件。</div>
        )}
      </section>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
