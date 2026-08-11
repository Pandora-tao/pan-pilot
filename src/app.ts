import Fastify, { type FastifyBaseLogger } from "fastify";
import multipart from "@fastify/multipart";
import { timingSafeEqual } from "node:crypto";
import { DocStore } from "./docs/doc-store.js";
import {
  DEFAULT_MEDIA_MAX_BYTES,
  MediaStore,
} from "./media/media-store.js";
import type { ModelClient } from "./model/model-client.js";
import {
  ChatModelRegistry,
  createChatModelRegistry,
  createInjectedChatModelRegistry,
} from "./model/model-registry.js";
import type { MultimodalClient } from "./model/multimodal-client.js";
import { VolcengineMultimodalClient } from "./model/volcengine-multimodal-client.js";
import { registerCapabilitiesRoute } from "./routes/capabilities-route.js";
import { registerChatRoute } from "./routes/chat-route.js";
import { registerConsoleRoute } from "./routes/console-route.js";
import { registerFilesRoute } from "./routes/files-route.js";
import { registerHealthRoute } from "./routes/health-route.js";
import { registerMediaRoute } from "./routes/media-route.js";
import { registerModelsRoute } from "./routes/models-route.js";
import { BingSearchClient } from "./search/bing-search.js";
import { InMemoryApprovalStore } from "./plugins/approval-store.js";
import { PluginManager } from "./plugins/plugin-manager.js";
import {
  DEFAULT_APPROVAL_TTL_MS,
  PluginApprovalService,
} from "./plugins/plugin-approval-service.js";
import { registerPluginRoutes } from "./plugins/plugin-routes.js";
import { createAnalyzeAudioTool } from "./tools/analyze-audio.js";
import { createAnalyzeImageTool } from "./tools/analyze-image.js";
import { calculatorTool } from "./tools/calculator.js";
import { createCreatePluginTool } from "./tools/create-plugin.js";
import { createCreateWordDocumentTool } from "./tools/create-word-document.js";
import { createEditWordDocumentTool } from "./tools/edit-word-document.js";
import { getCurrentTimeTool } from "./tools/get-current-time.js";
import { createListPluginsTool } from "./tools/list-plugins.js";
import type { MultimodalClientProvider } from "./tools/media-common.js";
import { createReadWordDocumentTool } from "./tools/read-word-document.js";
import { createReloadPluginsTool } from "./tools/reload-plugins.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { createTranscribeAudioTool } from "./tools/transcribe-audio.js";
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
  modelRegistry?: ChatModelRegistry;
  apiToken?: string;
  logChatContent?: boolean;
  loggerInstance?: FastifyBaseLogger;
  /** 插件目录，默认取 PAN_PILOT_PLUGINS_DIR 或 ./plugins。 */
  pluginsDir?: string;
  /** 逗号分隔的 http 插件 host 白名单，默认取 PAN_PILOT_PLUGIN_ALLOWED_HOSTS。 */
  pluginAllowedHosts?: string;
  /** 逗号分隔的允许 ${env:NAME} 引用的环境变量名白名单。 */
  pluginAllowedEnvVars?: string;
  /** 审批有效期（毫秒），默认取 PAN_PILOT_PLUGIN_APPROVAL_TTL_MINUTES 或 15 分钟。 */
  pluginApprovalTtlMs?: number;
  /** http 插件执行用的 fetch 实现，测试注入替身。 */
  pluginFetchImpl?: typeof fetch;
  /** 媒体存储目录，默认取 PAN_PILOT_MEDIA_DIR 或 ./media。 */
  mediaDir?: string;
  /** 媒体大小上限（字节），默认 10MB；供测试注入小上限。 */
  mediaMaxBytes?: number;
  /** 媒体存储实例；测试注入可控替身（如删除失败替身），默认新建。 */
  mediaStore?: MediaStore;
  /** 多模态客户端（图片/音频理解），测试注入假实现；默认懒加载火山方舟实现。 */
  multimodalClient?: MultimodalClient;
}

/** 组装应用依赖并注册所有横切能力与路由，但不在这里监听端口。 */
export function buildApp(options: BuildAppOptions = {}) {
  const app = options.loggerInstance
    ? Fastify({ loggerInstance: options.loggerInstance })
    : Fastify({ logger: true });
  if (options.modelClient !== undefined && options.modelRegistry !== undefined) {
    throw new Error("modelClient and modelRegistry cannot both be provided");
  }
  const modelRegistry = options.modelRegistry
    ?? (options.modelClient === undefined
      ? createChatModelRegistry()
      : createInjectedChatModelRegistry(options.modelClient));
  const apiToken = options.apiToken ?? process.env.PAN_PILOT_API_TOKEN ?? "";
  const logChatContent = options.logChatContent
    ?? isEnabled(process.env.PAN_PILOT_LOG_CHAT_CONTENT);
  const docStore = new DocStore(process.env.PAN_PILOT_DOCS_DIR ?? "./docs");
  const mediaMaxBytes = options.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const mediaStore = options.mediaStore
    ?? new MediaStore(
        options.mediaDir ?? process.env.PAN_PILOT_MEDIA_DIR ?? "./media",
        { maxBytes: mediaMaxBytes },
      );
  // 测试注入的客户端直接复用；否则懒加载厂商实现，未配置密钥时服务仍可启动。
  const injectedMultimodal = options.multimodalClient;
  const multimodalProvider: MultimodalClientProvider = injectedMultimodal
    === undefined
    ? () => new VolcengineMultimodalClient()
    : () => injectedMultimodal;
  // 内置实现是插件框架的引用来源；白名单由 plugins/ 下的 manifest 声明。
  const builtinTools = [
    calculatorTool,
    getCurrentTimeTool,
    createCreateWordDocumentTool(docStore),
    createReadWordDocumentTool(docStore),
    createEditWordDocumentTool(docStore),
    createWebSearchTool(new BingSearchClient()),
    createAnalyzeImageTool(mediaStore, multimodalProvider),
    createAnalyzeAudioTool(mediaStore, multimodalProvider),
    createTranscribeAudioTool(mediaStore, multimodalProvider),
  ];
  const toolRegistry = new ToolRegistry();
  const pluginsDir = options.pluginsDir
    ?? process.env.PAN_PILOT_PLUGINS_DIR
    ?? "./plugins";
  const allowedHosts = parseHostList(
    options.pluginAllowedHosts
      ?? process.env.PAN_PILOT_PLUGIN_ALLOWED_HOSTS,
  );
  const allowedEnvVars = parseNameList(
    options.pluginAllowedEnvVars
      ?? process.env.PAN_PILOT_PLUGIN_ALLOWED_ENV_VARS,
  );
  // 管理工具通过闭包延迟引用管理器/审批服务，打破构造环；
  // 工具执行发生在 buildApp 组装完成之后，引用必然已就位。
  const managerRef: { current: PluginManager | undefined } = { current: undefined };
  const serviceRef: { current: PluginApprovalService | undefined } = {
    current: undefined,
  };
  // 内容内置工具 + 三个管理工具构成同一份完整 builtin 集合，
  // PluginManager（装载/冲突检查）与 PluginApprovalService（草案构造检查）
  // 使用完全一致的集合，避免 builtinNames/refs 在两个边界上漂移。
  const allBuiltinTools = [
    ...builtinTools,
    createListPluginsTool(() => {
      if (managerRef.current === undefined) {
        throw new Error("插件管理器尚未就绪");
      }
      return managerRef.current;
    }),
    createCreatePluginTool(() => {
      if (serviceRef.current === undefined) {
        throw new Error("审批服务尚未就绪");
      }
      return serviceRef.current;
    }),
    createReloadPluginsTool(() => {
      if (serviceRef.current === undefined) {
        throw new Error("审批服务尚未就绪");
      }
      return serviceRef.current;
    }),
  ];
  const pluginManager = new PluginManager({
    pluginsDir,
    builtinTools: allBuiltinTools,
    registry: toolRegistry,
    allowedHosts,
    allowedEnvVars,
    ...(options.pluginFetchImpl === undefined
      ? {}
      : { fetchImpl: options.pluginFetchImpl }),
  });
  const approvalService = new PluginApprovalService({
    store: new InMemoryApprovalStore(),
    manager: pluginManager,
    builtinTools: allBuiltinTools,
    allowedHosts,
    allowedEnvVars,
    ttlMs: options.pluginApprovalTtlMs
      ?? parseApprovalTtlMinutes(process.env.PAN_PILOT_PLUGIN_APPROVAL_TTL_MINUTES),
  });
  managerRef.current = pluginManager;
  serviceRef.current = approvalService;
  for (const status of pluginManager.loadInitial()) {
    if (status.state === "error") {
      app.log.warn(
        { event: "pan_pilot.plugins.load_error", plugin: status.name },
        status.error,
      );
    }
  }
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
      reply.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
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
  registerModelsRoute(app, modelRegistry);
  registerChatRoute(app, modelRegistry, toolRegistry, { logChatContent, mediaStore });
  registerPluginRoutes(app, pluginManager, approvalService, {
    // 未配置 API token 时，审批执行类接口 fail-closed，不能匿名批准/执行。
    approvalAuthConfigured: apiToken !== "",
  });
  // multipart 的 request.file() 是插件作用域装饰器，文件路由必须在插件子作用域内注册。
  app.register(async (scopedApp) => {
    await scopedApp.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    });
    registerFilesRoute(scopedApp, docStore);
    registerMediaRoute(scopedApp, mediaStore, mediaMaxBytes);
  });

  return app;
}

/** 将常见的环境变量布尔写法统一解释为开关值。 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined
    && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

function parseNameList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function parseApprovalTtlMinutes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_APPROVAL_TTL_MS;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_APPROVAL_TTL_MS;
  return Math.round(minutes * 60_000);
}
