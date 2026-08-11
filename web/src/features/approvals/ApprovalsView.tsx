import { Check, Play, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { ApiClient } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { ViewHeader } from "../../components/ViewHeader";
import type { Approval } from "../../types";

interface ApprovalsViewProps {
  client: ApiClient;
  approvals: Approval[];
  refresh: () => Promise<void>;
  requestApproval: (approval: Approval, title: string) => void;
  toast: (message: string) => void;
}

export function ApprovalsView({
  client,
  approvals,
  refresh,
  requestApproval,
  toast,
}: ApprovalsViewProps) {
  const [manifestText, setManifestText] = useState("");
  const [creating, setCreating] = useState(false);

  async function createDraft() {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      toast("manifest 不是合法 JSON");
      return;
    }
    setCreating(true);
    try {
      const approval = await client.createPluginDraft(manifest);
      setManifestText("");
      await refresh();
      requestApproval(approval, "创建插件");
    } catch (error) {
      toast("创建草案失败：" + errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function reject(approval: Approval) {
    try {
      await client.reject(approval);
      await refresh();
      toast("审批已拒绝");
    } catch (error) {
      toast("拒绝失败：" + errorMessage(error));
    }
  }

  async function approve(approval: Approval) {
    try {
      await client.approve(approval);
      await refresh();
      toast("审批已批准，等待执行");
    } catch (error) {
      toast("批准失败：" + errorMessage(error));
    }
  }

  async function execute(approval: Approval) {
    try {
      await client.execute(approval);
      await refresh();
      toast("审批动作已执行");
    } catch (error) {
      toast("执行失败：" + errorMessage(error));
    }
  }

  return (
    <section className="view active">
      <ViewHeader
        number="04"
        title="插件审批"
        description="检查动作摘要、影响和风险后，再批准、拒绝或执行。未配置 API Token 时执行接口不可用。"
        actions={(
          <button type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={16} />刷新
          </button>
        )}
      />

      <div className="approval-layout">
        <section className="surface">
          <div className="section-head"><h3>创建插件草案</h3></div>
          <div className="section-body approval-create">
            <textarea
              value={manifestText}
              onChange={(event) => setManifestText(event.target.value)}
              aria-label="插件 manifest JSON"
              placeholder="粘贴声明式 manifest JSON"
            />
            <button
              className="primary"
              type="button"
              disabled={creating || !manifestText.trim()}
              onClick={() => void createDraft()}
            >
              {creating ? "创建中" : "创建草案"}
            </button>
          </div>
        </section>

        <section className="surface">
          {approvals.length ? (
            <div className="record-list">
              {approvals.map((approval) => (
                <div className="approval-item" key={approval.id}>
                  <div className="record-name">
                    {approval.preview.summary}
                    <StatusBadge status={approval.status} />
                  </div>
                  <div className="record-meta">
                    到期 {new Date(approval.expiresAt).toLocaleString()} · 哈希{" "}
                    {approval.hash.slice(0, 10)}…
                  </div>
                  <div className="approval-detail">
                    <strong>影响</strong>
                    <span>{approval.preview.changes.join("；") || "无变更项"}</span>
                    <strong>风险</strong>
                    <span>{approval.preview.riskSummary}</span>
                  </div>
                  <div className="item-actions">
                    {approval.status === "pending" && (
                      <>
                        <button className="small primary" type="button" onClick={() => void approve(approval)}>
                          <Check aria-hidden="true" size={14} />批准
                        </button>
                        <button className="small" type="button" onClick={() => void reject(approval)}>
                          <X aria-hidden="true" size={14} />拒绝
                        </button>
                      </>
                    )}
                    {approval.status === "approved" && (
                      <button className="small primary" type="button" onClick={() => void execute(approval)}>
                        <Play aria-hidden="true" size={14} />执行
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-tip">暂无审批记录。</div>
          )}
        </section>
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
