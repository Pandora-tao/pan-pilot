import type { FastifyInstance } from "fastify";
import type { ChatModelRegistry } from "../model/model-registry.js";

/** 返回脱敏模型目录；/v1 鉴权由应用级 hook 统一处理。 */
export function registerModelsRoute(
  app: FastifyInstance,
  registry: ChatModelRegistry,
): void {
  app.get("/v1/models", async () => ({
    defaultModelId: registry.defaultModelId,
    models: registry.list(),
  }));
}
