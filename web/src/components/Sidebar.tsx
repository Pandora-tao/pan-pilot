import { Plus, Settings, Trash2 } from "lucide-react";
import type { SessionSummary } from "../types";

interface SidebarProps {
  health: "checking" | "ok" | "error";
  baseUrl: string;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSettings: () => void;
}

/** 左侧边栏：品牌、健康状态、历史会话与底部「设置」入口。设置页开启时整栏隐藏。 */
export function Sidebar({
  health,
  baseUrl,
  sessions,
  currentSessionId,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onOpenSettings,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">P.</span>
        <div>
          <h1>PanPilot 控制台</h1>
          <p>Agent 运行与插件控制</p>
        </div>
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

      <div className="sidebar-footer">
        <button className="sidebar-action" type="button" onClick={onOpenSettings}>
          <Settings aria-hidden="true" size={17} strokeWidth={1.7} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
