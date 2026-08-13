interface StatusBadgeProps {
  status: string;
  label?: string;
}

const labels: Record<string, string> = {
  available: "可用",
  blocked: "阻塞",
  reserved: "预留",
  loaded: "已加载",
  disabled: "已禁用",
  error: "错误",
  builtin: "内置",
  http: "HTTP",
  queued: "排队中",
  running: "运行中",
  pausing: "暂停中",
  paused: "已暂停",
  needs_confirmation: "需确认",
  succeeded: "成功",
  failed: "失败",
  timed_out: "已超时",
  skipped_overlap: "重叠跳过",
  skipped_misfire: "漏跑跳过",
  interrupted: "已中断",
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`badge ${status}`}>
      {label ?? labels[status] ?? status}
    </span>
  );
}
