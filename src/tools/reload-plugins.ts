import { z } from "zod";
import type { PluginApprovalService } from "../plugins/plugin-approval-service.js";
import type { AnyAgentTool } from "./tool.js";

/**
 * Agent 可见的重载入口：只创建 reload 审批草案（绑定当前插件目录快照），
 * 绝不直接重载。批准与执行只走受鉴权 HTTP API，且执行前会重新校验
 * 目录快照，批准后换入的内容无法被意外应用。
 */
export function createReloadPluginsTool(
  serviceRef: () => PluginApprovalService,
): AnyAgentTool {
  return {
    name: "reload_plugins",
    description:
      "提交全量重载插件的审批草案（绑定当前插件目录快照，不会直接重载）；"
      + "需要调用方通过 HTTP 批准后执行",
    inputSchema: z.object({}).strict(),
    async execute() {
      const approval = serviceRef().createDraft({ type: "reload_plugins" });
      return { approval };
    },
  };
}
