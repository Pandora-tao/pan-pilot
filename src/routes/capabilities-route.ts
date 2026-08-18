import type { FastifyInstance } from "fastify";
import { agentCapabilities } from "../agent/capabilities.js";

export interface CapabilitiesRouteOptions {
  /** Agent 自主安装开关（PAN_PILOT_PLUGIN_AUTO_INSTALL）。 */
  pluginAutoInstall: boolean;
  /** 文件系统工具是否注册（PAN_PILOT_FS_ENABLED 且已配置允许根目录）。 */
  filesystemEnabled: boolean;
  /** 允许 Agent 访问的根目录白名单。 */
  filesystemRoots: string[];
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
    },
  }));
}
