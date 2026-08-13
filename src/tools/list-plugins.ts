import { z } from "zod";
import type { PluginManager } from "../plugins/plugin-manager.js";
import type { AnyAgentTool } from "./tool.js";

/**
 * 只读工具：返回脱敏的插件状态列表，不触发任何副作用。
 *
 * 通过闭包延迟引用 PluginManager，避免「管理工具依赖管理器、管理器又依赖
 * 内置工具」的构造环；工具只在实际执行时才解析引用。
 */
export function createListPluginsTool(
  managerRef: () => PluginManager,
): AnyAgentTool {
  return {
    name: "list_plugins",
    description: "列出当前已加载、已禁用或加载失败的插件状态（只读，不修改任何状态）",
    inputSchema: z.object({}).strict(),
    async execute() {
      return { plugins: managerRef().listStatuses() };
    },
  };
}
