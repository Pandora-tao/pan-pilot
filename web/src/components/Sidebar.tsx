import {
  Activity,
  MessageSquare,
  Plus,
  Plug,
  Clock3,
  Settings,
  Trash2,
} from "lucide-react";
import type { SessionSummary, ViewName } from "../types";

interface SidebarProps {
  activeView: ViewName;
  onChangeView: (view: ViewName) => void;
  onOpenSettings: () => void;
  health: "checking" | "ok" | "error";
  baseUrl: string;
  counts: Partial<Record<ViewName, number>>;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
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
  sessions,
  currentSessionId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
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

      {activeView === "chat" && (
        <div className="sidebar-sessions">
          <div className="sessions-head">
            <span className="sessions-label">历史会话</span>
            <button
              className="sessions-new"
              type="button"
              onClick={onNewSession}
              title="新建会话"
            >
              <Plus aria-hidden="true" size={13} />
              新建
            </button>
          </div>
          <div className="session-list">
            {sessions.length === 0 ? (
              <span className="session-empty">暂无历史会话</span>
            ) : sessions.map((session) => (
              <div
                className={`session-item${session.id === currentSessionId ? " active" : ""}`}
                key={session.id}
                role="button"
                tabIndex={0}
                title={session.title}
                onClick={() => onSelectSession(session.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectSession(session.id);
                  }
                }}
              >
                <span className="session-title">{session.title}</span>
                <button
                  className="session-delete"
                  type="button"
                  aria-label={`删除会话 ${session.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                >
                  <Trash2 aria-hidden="true" size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="sidebar-action" type="button" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={17} strokeWidth={1.7} />
          <span>连接设置</span>
        </button>
      </div>
    </aside>
  );
}
