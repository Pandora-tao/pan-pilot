import Fastify, { type FastifyBaseLogger } from "fastify";
import multipart from "@fastify/multipart";
import { timingSafeEqual } from "node:crypto";
import { ChatAgent } from "./agent/chat-agent.js";
import { DocStore } from "./docs/doc-store.js";
import { DeepSeekClient } from "./model/deepseek-client.js";
import type { ModelClient } from "./model/model-client.js";
import { registerCapabilitiesRoute } from "./routes/capabilities-route.js";
import { registerChatRoute } from "./routes/chat-route.js";
import { registerConsoleRoute } from "./routes/console-route.js";
import { registerFilesRoute } from "./routes/files-route.js";
import { registerHealthRoute } from "./routes/health-route.js";
import { BingSearchClient } from "./search/bing-search.js";
import { calculatorTool } from "./tools/calculator.js";
import { createCreateWordDocumentTool } from "./tools/create-word-document.js";
import { createEditWordDocumentTool } from "./tools/edit-word-document.js";
import { getCurrentTimeTool } from "./tools/get-current-time.js";
import { createReadWordDocumentTool } from "./tools/read-word-document.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { createWebSearchTool } from "./tools/web-search.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 本地控制台允许跨源调用 /v1/*：仅放行 file:// 页面（Origin: null）
 * 与 localhost/127.0.0.1 静态服务器，其他站点不返回 CORS 头，避免被任意网页借用。
 */
const LOCAL_ORIGIN_PATTERN = /^(?:null|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/;

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
  const docStore = new DocStore(process.env.PAN_PILOT_DOCS_DIR ?? "./docs");
  // 只注册显式白名单内的工具；工具循环由 ChatAgent 统一驱动。
  const toolRegistry = new ToolRegistry([
    calculatorTool,
    getCurrentTimeTool,
    createCreateWordDocumentTool(docStore),
    createReadWordDocumentTool(docStore),
    createEditWordDocumentTool(docStore),
    createWebSearchTool(new BingSearchClient()),
  ]);
  const chatAgent = new ChatAgent(modelClient, toolRegistry);

  if (logChatContent) {
    // 启动时留下醒目标记，避免操作者无意间长期记录敏感对话。
    app.log.warn(
      { event: "pan_pilot.chat.content_logging_enabled" },
      "PanPilot chat content logging is enabled; prompts and replies may contain private data",
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && LOCAL_ORIGIN_PATTERN.test(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
      reply.header("access-control-allow-headers", "authorization, content-type, accept");
      reply.header("vary", "origin");
    }
    // 预检请求在鉴权钩子之前结束，浏览器只会在放行来源拿到 CORS 头。
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

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
  registerConsoleRoute(app);
  registerCapabilitiesRoute(app);
  registerChatRoute(app, chatAgent, { logChatContent });
  // multipart 的 request.file() 是插件作用域装饰器，文件路由必须在插件子作用域内注册。
  app.register(async (scopedApp) => {
    await scopedApp.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    });
    registerFilesRoute(scopedApp, docStore);
  });

  return app;
}

/** 将常见的环境变量布尔写法统一解释为开关值。 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined
    && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
