import type { FastifyInstance } from "fastify";
import { agentCapabilities } from "../agent/capabilities.js";

/** 提供稳定的能力发现入口，让调用方在请求前判断功能是否可用。 */
export function registerCapabilitiesRoute(app: FastifyInstance): void {
  app.get("/v1/capabilities", async () => agentCapabilities);
}
