import {
  Activity,
  MessageSquare,
  Plug,
  Clock3,
  Settings,
} from "lucide-react";
import type { ViewName } from "../types";

interface SidebarProps {
  activeView: ViewName;
  onChangeView: (view: ViewName) => void;
  onOpenSettings: () => void;
  health: "checking" | "ok" | "error";
  baseUrl: string;
  counts: Partial<Record<ViewName, number>>;
}

const items: Array<{
  view: ViewName;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { view: "chat", label: "对话", icon: MessageSquare },
  { view: "plugins", label: "插件", icon: Plug },
  { view: "tasks", label: "任务", icon: Clock3 },
  { view: "capabilities", label: "能力", icon: Activity },
];

export function Sidebar({
  activeView,
  onChangeView,
  onOpenSettings,
  health,
  baseUrl,
  counts,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">P.</span>
        <h1>PanPilot 控制台</h1>
        <p>Agent 运行与插件控制</p>
      </div>

      <div className="health" title="GET /health">
        <span className={`dot ${health}`} />
        <span>
          <strong>
            {health === "ok" ? "服务正常" : health === "error" ? "无法连接" : "检查中"}
          </strong>
          <span>{baseUrl}</span>
        </span>
      </div>

      <nav className="nav" aria-label="控制台导航">
        {items.map(({ view, label, icon: Icon }) => (
          <button
            className={`nav-button ${activeView === view ? "active" : ""}`}
            key={view}
            type="button"
            aria-current={activeView === view ? "page" : undefined}
            onClick={() => onChangeView(view)}
          >
            <Icon aria-hidden="true" size={17} strokeWidth={1.7} />
            <span className="nav-label">{label}</span>
            {view !== "chat" && (
              <span className="nav-count">{counts[view] ?? 0}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-action" type="button" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={17} strokeWidth={1.7} />
          <span>连接设置</span>
        </button>
      </div>
    </aside>
  );
}
