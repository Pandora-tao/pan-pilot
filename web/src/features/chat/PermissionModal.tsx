import { Check, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { ApiClient } from "../../api";
import { Modal } from "../../components/Modal";
import type { PermissionRequest } from "../../types";

/**
 * 工具授权弹窗：展示待授权操作的路径 / 命令与统一 diff 预览，
 * 用户选择「允许一次」「始终允许（仅当该操作可永久放行）」「拒绝」。
 * 决定提交后服务端在同一工具调用处恢复执行，本弹窗随之关闭。
 */
export function PermissionModal({
  request,
  client,
  onDecided,
  toast,
}: {
  request: PermissionRequest;
  client: ApiClient;
  onDecided: () => void;
  toast: (message: string) => void;
}) {
  const [busy, setBusy] = useState("");

  async function decide(action: "allow_once" | "allow_always" | "reject") {
    if (busy) return;
    setBusy(action);
    try {
      await client.decidePermissionRequest(request.id, action);
      onDecided();
    } catch (error) {
      toast("授权提交失败：" + errorMessage(error));
      onDecided();
    } finally {
      setBusy("");
    }
  }

  return (
    <Modal
      open
      title="工具授权"
      // 授权请求必须显式决定；不可通过 X / Esc / 点遮罩跳过（避免请求悬挂等待）。
      closable={false}
      onClose={() => onDecided()}
      footer={(
        <>
          <button
            type="button"
            disabled={busy !== ""}
            onClick={() => void decide("reject")}
          >
            <X aria-hidden="true" size={14} />拒绝
          </button>
          {request.permanentlyAllowable && (
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => void decide("allow_always")}
            >
              <Check aria-hidden="true" size={14} />始终允许
            </button>
          )}
          <button
            className="primary"
            type="button"
            disabled={busy !== ""}
            onClick={() => void decide("allow_once")}
          >
            <Check aria-hidden="true" size={14} />允许一次
          </button>
        </>
      )}
    >
      <form
        className="permission-form"
        onSubmit={(event) => {
          event.preventDefault();
          void decide("allow_once");
        }}
      >
        <p className="permission-head">
          <ShieldQuestion aria-hidden="true" size={16} />
          模型请求<b> {request.toolName}</b>，需要你的授权。
        </p>
        <p className="permission-target" title={request.target}>{request.summary}</p>
        {request.diff !== undefined && request.diff !== "" ? (
          <pre className="permission-diff">{request.diff}</pre>
        ) : null}
        {request.origin === "scheduled_task" && (
          <p className="permission-note">来源：定时任务（runId: {request.runId ?? "—"}）</p>
        )}
      </form>
    </Modal>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
