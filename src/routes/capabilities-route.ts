import type { FastifyInstance } from "fastify";
import { agentCapabilities } from "../agent/capabilities.js";

export interface CapabilitiesRouteOptions {
  /** Agent 自主安装开关（PAN_PILOT_PLUGIN_AUTO_INSTALL）。 */
  pluginAutoInstall: boolean;
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
    },
  }));
}
