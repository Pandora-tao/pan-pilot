import { Check, RefreshCw, ShieldQuestion, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import type {
  PermissionDecisionAction,
  PermissionRequest,
  PermissionRule,
} from "../../types";

/**
 * 设置 → 权限：待决授权请求（聊天 / 定时任务工具授权）与永久规则。
 * 决定后聊天在原调用处恢复、定时任务从同一待执行工具续跑。
 */
export function PermissionsView({
  client,
  toast,
  onCountChange,
}: {
  client: ApiClient;
  toast: (message: string) => void;
  onCountChange?: (count: number) => void;
}) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [nextRequests, nextRules] = await Promise.all([
        client.permissionRequests(),
        client.permissionRules(),
      ]);
      setRequests(nextRequests);
      setRules(nextRules);
      onCountChange?.(nextRequests.length);
    } catch (error) {
      if (!quiet) toast("授权状态获取失败：" + errorMessage(error));
    }
  }, [client, onCountChange, toast]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function decide(requestId: string, action: PermissionDecisionAction) {
    setBusy(`decide-${requestId}-${action}`);
    try {
      await client.decidePermissionRequest(requestId, action);
      toast(action === "reject" ? "已拒绝该操作" : "已授权，请求正在恢复执行");
      await refresh(true);
    } catch (error) {
      toast("授权提交失败：" + errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function revoke(ruleId: string) {
    setBusy(`revoke-${ruleId}`);
    try {
      await client.revokePermissionRule(ruleId);
      toast("永久授权规则已撤销");
      await refresh(true);
    } catch (error) {
      toast("撤销失败：" + errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="permissions-body">
      <div className="tab-toolbar">
        <p>模型请求访问宿主文件或执行命令时，会在此等待授权。敏感路径与破坏性操作不提供「始终允许」。</p>
        <div className="view-actions">
          <button type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={16} />刷新
          </button>
        </div>
      </div>

      <section className="surface section-stack">
        <div className="section-head">
          <div>
            <h3>待授权请求</h3>
            <p>聊天中的请求会直接弹出授权框；定时任务请求在这里处理。</p>
          </div>
          <span className="section-count">{requests.length}</span>
        </div>
        {requests.length ? (
          <div className="record-list">
            {requests.map((request) => (
              <div className="record-item permission-item" key={request.id}>
                <div>
                  <div className="record-name">
                    <ShieldQuestion aria-hidden="true" size={14} />
                    {request.toolName}
                    <StatusBadge
                      status={request.origin}
                      label={request.origin === "scheduled_task" ? "定时任务" : "聊天"}
                    />
                    <span className="record-meta">等待授权</span>
                  </div>
                  <p className="record-desc" title={request.target}>{request.summary}</p>
                  {request.diff !== undefined && request.diff !== "" ? (
                    <details className="permission-diff-details">
                      <summary>查看变更 diff</summary>
                      <pre className="permission-diff">{request.diff}</pre>
                    </details>
                  ) : null}
                  {request.runId !== undefined && (
                    <div className="record-meta">定时任务运行：{request.runId}</div>
                  )}
                </div>
                <div className="item-actions">
                  <button className="small" type="button" disabled={busy !== ""} onClick={() => void decide(request.id, "reject")}>
                    <X aria-hidden="true" size={14} />拒绝
                  </button>
                  {request.permanentlyAllowable && (
                    <button className="small" type="button" disabled={busy !== ""} onClick={() => void decide(request.id, "allow_always")}>
                      <Check aria-hidden="true" size={14} />始终允许
                    </button>
                  )}
                  <button className="small primary" type="button" disabled={busy !== ""} onClick={() => void decide(request.id, "allow_once")}>
                    <Check aria-hidden="true" size={14} />允许一次
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-tip">没有待授权的请求。</div>
        )}
      </section>

      <section className="surface section-stack">
        <div className="section-head">
          <div>
            <h3>永久授权规则</h3>
            <p>「始终允许」会落成按路径精确匹配的规则，这里可一键撤销。</p>
          </div>
          <span className="section-count">{rules.length}</span>
        </div>
        {rules.length ? (
          <div className="record-list">
            {rules.map((rule) => (
              <div className="record-item" key={rule.id}>
                <div>
                  <div className="record-name">
                    {rule.pattern}
                    <StatusBadge status={rule.kind} label={rule.kind === "file" ? "文件" : "命令"} />
                  </div>
                  <p className="record-desc">
                    允许操作：{rule.operations.join("、")} · 创建于 {new Date(rule.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="item-actions">
                  <button className="small danger" type="button" disabled={busy !== ""} onClick={() => void revoke(rule.id)}>
                    <Trash2 aria-hidden="true" size={14} />撤销
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-tip">没有永久授权规则。</div>
        )}
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
