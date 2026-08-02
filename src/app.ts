import Fastify, { type FastifyBaseLogger } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { ChatAgent } from "./agent/chat-agent.js";
import { DeepSeekClient } from "./model/deepseek-client.js";
import type { ModelClient } from "./model/model-client.js";
import { registerCapabilitiesRoute } from "./routes/capabilities-route.js";
import { registerChatRoute } from "./routes/chat-route.js";
import { registerHealthRoute } from "./routes/health-route.js";

/**
 * 允许启动入口使用默认生产依赖，也允许测试注入模型和日志替身。
 * 这使路由测试无需真实 API Key、外部网络或监听端口。
 */
export interface BuildAppOptions {
  modelClient?: ModelClient;
  apiToken?: string;
  logChatContent?: boolean;
  loggerInstance?: FastifyBaseLogger;
}

/** 组装应用依赖并注册所有横切能力与路由，但不在这里监听端口。 */
export function buildApp(options: BuildAppOptions = {}) {
  const app = options.loggerInstance
    ? Fastify({ loggerInstance: options.loggerInstance })
    : Fastify({ logger: true });
  const modelClient = options.modelClient ?? new DeepSeekClient();
  const apiToken = options.apiToken ?? process.env.PAN_PILOT_API_TOKEN ?? "";
  const logChatContent = options.logChatContent
    ?? isEnabled(process.env.PAN_PILOT_LOG_CHAT_CONTENT);
  const chatAgent = new ChatAgent(modelClient);

  if (logChatContent) {
    // 启动时留下醒目标记，避免操作者无意间长期记录敏感对话。
    app.log.warn(
      { event: "pan_pilot.chat.content_logging_enabled" },
      "PanPilot chat content logging is enabled; prompts and replies may contain private data",
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    // 健康检查保持公开；只有版本化业务 API 在配置 token 后启用 Bearer 鉴权。
    if (!request.url.startsWith("/v1/") || !apiToken) return;
    const provided = request.headers.authorization ?? "";
    const expected = `Bearer ${apiToken}`;
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    // 先校验长度，因为 timingSafeEqual 只接受等长 Buffer；等长时再做恒定时间比较。
    if (providedBuffer.length !== expectedBuffer.length
        || !timingSafeEqual(providedBuffer, expectedBuffer)) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "PanPilot API token 不正确",
      });
    }
  });

  registerHealthRoute(app);
  registerCapabilitiesRoute(app);
  registerChatRoute(app, chatAgent, { logChatContent });

  return app;
}

/** 将常见的环境变量布尔写法统一解释为开关值。 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined
    && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
