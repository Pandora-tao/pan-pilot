import { RefreshCw } from "lucide-react";
import { StatusBadge } from "../../components/StatusBadge";
import { ViewHeader } from "../../components/ViewHeader";
import type { CapabilitiesResponse, Capability } from "../../types";

const descriptions: Record<string, string> = {
  chat: "对话与 SSE 流式输出",
  tools: "白名单工具循环",
  files: "Word 文档上传、读取与编辑",
  media: "图片与音频上传、多模态分析",
  search: "联网搜索",
  plugins: "声明式插件与审批控制",
  memory: "长期记忆",
  planning: "任务规划",
};

interface CapabilitiesViewProps {
  data: CapabilitiesResponse | null;
  refresh: () => Promise<void>;
}

export function CapabilitiesView({ data, refresh }: CapabilitiesViewProps) {
  const capabilities = Object.entries(data?.capabilities ?? {});
  return (
    <section className="view active">
      <ViewHeader
        number="05"
        title="能力状态"
        description="读取服务端真实能力声明，区分可用、阻塞和预留状态。"
        actions={(
          <button type="button" onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" size={16} />刷新
          </button>
        )}
      />
      <div className="section-stack">
        {capabilities.length ? (
          <div className="cap-grid">
            {capabilities.map(([name, capability]) => (
              <CapabilityCard key={name} name={name} capability={capability} />
            ))}
          </div>
        ) : (
          <div className="surface empty-tip">正在获取能力状态。</div>
        )}
      </div>
    </section>
  );
}

function CapabilityCard({ name, capability }: { name: string; capability: Capability }) {
  const nested = Object.entries(capability).filter(([, value]) => (
    value && typeof value === "object" && "status" in value
  )) as Array<[string, { status: string }]>;
  return (
    <article className="cap-card">
      <div className="cap-title">
        <strong>{name}</strong>
        <StatusBadge status={capability.status} />
      </div>
      <p>
        {descriptions[name] ?? ""}
        {name === "chat" && capability.streaming ? "，已启用流式输出" : ""}
      </p>
      {nested.length > 0 && (
        <div className="cap-details">
          {nested.map(([nestedName, nestedCapability]) => (
            <StatusBadge
              key={nestedName}
              status={nestedCapability.status}
              label={`${nestedName} · ${statusLabel(nestedCapability.status)}`}
            />
          ))}
        </div>
      )}
    </article>
  );
}

function statusLabel(status: string): string {
  return status === "available" ? "可用" : status === "blocked" ? "阻塞" : "预留";
}
