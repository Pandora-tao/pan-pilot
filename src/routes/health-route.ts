import type { FastifyInstance } from "fastify";

/** 供容器或负载均衡器探活；该路径不调用模型，也不受 /v1 鉴权钩子保护。 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => ({
    name: "PanPilot",
    status: "ok",
  }));
}
