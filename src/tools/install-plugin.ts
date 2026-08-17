import { z } from "zod";
import type { PluginManifest } from "../plugins/manifest-schema.js";
import { PluginOperationError } from "../plugins/plugin-operation-error.js";
import type { PluginService } from "../plugins/plugin-service.js";
import type { AnyAgentTool } from "./tool.js";

/**
 * Agent 自主安装工具：把合法 manifest 落盘并原子重载工具注册表，让新工具在
 * 同一轮对话内即可被后续工具循环调用。
 *
 * 默认关闭（fail-closed）：`PAN_PILOT_PLUGIN_AUTO_INSTALL=true` 且 buildApp
 * 传入 pluginAutoInstall 后才允许执行；关闭时工具仍会暴露给模型（自引用插件
 * 需要 builtin ref 始终可解析），但调用会得到明确错误。
 *
 * 安全边界与用户路径一致：manifest 校验、create-only 写入、原子重载、失败回滚，
 * HTTP 插件仍受 host / env 白名单约束（默认拒绝全部外部主机）。
 */
export function createInstallPluginTool(
  serviceRef: () => PluginService,
  autoInstall: boolean,
): AnyAgentTool {
  return {
    name: "install_plugin",
    description:
      "安装一个声明式插件并立即启用其工具。副作用：把 manifest 写入 plugins 目录并原子重载工具注册表；"
      + "HTTP 型插件会向 manifest 声明的 host 发起请求（受 PAN_PILOT_PLUGIN_ALLOWED_HOSTS 白名单约束，默认拒绝全部外部主机）。"
      + "仅当用户明确要求安装或启用新工具时调用。"
      + (autoInstall
        ? ""
        : "（当前未启用：需要管理员设置 PAN_PILOT_PLUGIN_AUTO_INSTALL=true 后重启服务）"),
    inputSchema: z.object({
      manifest: z.unknown(),
    }).strict(),
    async execute(input) {
      if (!autoInstall) {
        throw new PluginOperationError(
          "PLUGIN_AUTO_INSTALL_DISABLED",
          "Agent 自主安装未启用：请管理员配置 PAN_PILOT_PLUGIN_AUTO_INSTALL=true 后重启服务",
        );
      }
      const manifest = (input as { manifest: PluginManifest }).manifest;
      const result = serviceRef().install(manifest);
      return {
        installed: result.plugins.find((status) => status.name === manifest.name),
        plugins: result.plugins.map(({ name, state, enabled, toolNames }) => ({
          name,
          state,
          enabled,
          toolNames,
        })),
      };
    },
  };
}
