import type { FastifyInstance } from "fastify";
import { agentCapabilities } from "../agent/capabilities.js";

export interface CapabilitiesRouteOptions {
  /** Agent 自主安装开关（PAN_PILOT_PLUGIN_AUTO_INSTALL）。 */
  pluginAutoInstall: boolean;
  /** 文件系统工具是否注册（PAN_PILOT_FS_ENABLED）。 */
  filesystemEnabled: boolean;
  /** 管理员级文件系统限制根目录（PAN_PILOT_FS_ROOTS；空数组=整机可访问）。 */
  filesystemRoots: string[];
  /** 终端工具是否注册（PAN_PILOT_TERMINAL_ENABLED，默认开启）。 */
  terminalEnabled: boolean;
  /** 相对路径解析基准（PAN_PILOT_HOST_CWD 解析值）。 */
  hostCwd: string;
}

/** 提供稳定的能力发现入口，让调用方在请求前判断功能是否可用。 */
export function registerCapabilitiesRoute(
  app: FastifyInstance,
  options: CapabilitiesRouteOptions,
): void {
  app.get("/v1/capabilities", async () => ({
    ...agentCapabilities,
    capabilities: {
      ...agentCapabilities.capabilities,
      plugins: {
        ...agentCapabilities.capabilities.plugins,
        agentInstall: {
          status: options.pluginAutoInstall ? "available" : "reserved",
        },
      },
      filesystem: {
        status: options.filesystemEnabled ? "available" : "reserved",
        roots: options.filesystemRoots,
      },
      terminal: {
        status: options.terminalEnabled ? "available" : "reserved",
      },
      hostRuntime: {
        status: options.filesystemEnabled || options.terminalEnabled
          ? "available"
          : "disabled",
        filesystem: { enabled: options.filesystemEnabled },
        terminal: { enabled: options.terminalEnabled },
        // 写入 / 编辑 / 补丁 / 删除 / 终端命令一律经授权闭环。
        permission: { mode: "permissioned" },
        // 不暴露任何敏感环境变量值。
        defaultCwd: options.hostCwd,
        adminRoots: options.filesystemRoots,
      },
    },
  }));
}
