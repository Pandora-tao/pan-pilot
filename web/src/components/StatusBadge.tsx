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
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  executed: "已执行",
  expired: "已过期",
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`badge ${status}`}>
      {label ?? labels[status] ?? status}
    </span>
  );
}
