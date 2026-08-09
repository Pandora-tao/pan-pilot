import { z } from "zod";
import type { PluginApprovalService } from "../plugins/plugin-approval-service.js";
import type { AnyAgentTool } from "./tool.js";

/**
 * 自服务插件闭环的第一步：提交声明式插件草案（builtin 引用或 HTTP JSON
 * executor），只生成规范化动作、风险摘要与审批请求，绝不落盘/启用。
 *
 * 批准与执行只走受鉴权 HTTP API（/v1/plugins/approvals/:id/approve|execute），
 * 模型没有批准自己的工具，无法绕过审批门。
 */
export function createCreatePluginTool(
  serviceRef: () => PluginApprovalService,
): AnyAgentTool {
  return {
    name: "create_plugin",
    description:
      "提交一个声明式插件草案（manifest 只允许 builtin 引用或 HTTP JSON executor），"
      + "生成待人工审批的一次性动作；不会写入磁盘，需要调用方通过 HTTP 批准后执行",
    inputSchema: z.object({ manifest: z.unknown() }).strict(),
    async execute(input) {
      const approval = serviceRef().createDraft({
        type: "create_plugin",
        manifest: (input as { manifest: unknown }).manifest,
      });
      return { approval };
    },
  };
}
