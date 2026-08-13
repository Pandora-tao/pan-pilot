import type { FastifyInstance } from "fastify";
import type { McpManager } from "./mcp-manager.js";

/** 只返回连接与公开工具名，不回传命令、URL、请求头或环境变量。 */
export function registerMcpRoutes(
  app: FastifyInstance,
  manager: McpManager,
  authConfigured: boolean,
  configError?: string,
): void {
  app.get("/v1/mcp/servers", async (_request, reply) => {
    if (!authConfigured) {
      return reply.code(503).send({
        error: "AUTH_NOT_CONFIGURED",
        message: "未配置 PAN_PILOT_API_TOKEN，MCP 状态接口拒绝服务",
      });
    }
    if (configError !== undefined) {
      return reply.code(503).send({
        error: "MCP_CONFIG_UNAVAILABLE",
        message: configError,
      });
    }
    return {
    servers: manager.listStatuses(),
    };
  });
}
