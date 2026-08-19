import Fastify, { type FastifyBaseLogger } from "fastify";
import multipart from "@fastify/multipart";
import type { Transport } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConsoleAuth } from "./auth/console-auth.js";
import { ArtifactStore } from "./artifacts/artifact-store.js";
import {
  DEFAULT_MEDIA_MAX_BYTES,
  MediaStore,
} from "./media/media-store.js";
import type { ModelClient } from "./model/model-client.js";
import type { ContextManagerOptions } from "./agent/context-manager.js";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
} from "./agent/chat-agent.js";
import {
  ChatModelRegistry,
  createChatModelRegistry,
  createInjectedChatModelRegistry,
} from "./model/model-registry.js";
import type { MultimodalClient } from "./model/multimodal-client.js";
import { VolcengineMultimodalClient } from "./model/volcengine-multimodal-client.js";
import { registerArtifactRoute } from "./routes/artifact-route.js";
import { registerCapabilitiesRoute } from "./routes/capabilities-route.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SLOW_WARNING_MS,
  registerChatRoute,
} from "./routes/chat-route.js";
import { registerConsoleRoute } from "./routes/console-route.js";
import { registerConsoleAuthRoute } from "./routes/console-auth-route.js";
import { registerHealthRoute } from "./routes/health-route.js";
import { registerMediaRoute } from "./routes/media-route.js";
import { registerModelsRoute } from "./routes/models-route.js";
import { registerPermissionRoute } from "./routes/permission-route.js";
import { PermissionService } from "./permissions/permission-service.js";
import { PermissionStore } from "./permissions/permission-store.js";
import { BingSearchClient } from "./search/bing-search.js";
import { loadMcpConfig, type McpConfig } from "./mcp/mcp-config.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { registerMcpRoutes } from "./mcp/mcp-routes.js";
import { registerScheduledTaskRoutes } from "./scheduled-tasks/scheduled-task-routes.js";
import { ScheduledTaskScheduler } from "./scheduled-tasks/scheduled-task-scheduler.js";
import { ScheduledTaskStore } from "./scheduled-tasks/scheduled-task-store.js";
import { registerSessionRoute } from "./routes/session-route.js";
import { SessionStore } from "./sessions/session-store.js";
import { RuntimeStore } from "./extension/runtime-store.js";
import { SandboxPackageManager } from "./extension/package-manager.js";
import { registerPluginCandidatesRoute } from "./routes/plugin-candidates-route.js";
import { createPluginDraftTools } from "./tools/plugin-draft.js";
import type { AnyAgentTool } from "./tools/tool.js";
import { PluginManager } from "./plugins/plugin-manager.js";
import { PluginService } from "./plugins/plugin-service.js";
import { registerPluginRoutes } from "./plugins/plugin-routes.js";
import { createAnalyzeAudioTool } from "./tools/analyze-audio.js";
import { createAnalyzeImageTool } from "./tools/analyze-image.js";
import { calculatorTool } from "./tools/calculator.js";
import { createCodeArtifactTool } from "./tools/create-code-artifact.js";
import { dateCalculatorTool } from "./tools/date-calculator.js";
import { createFilesystemTools } from "./tools/filesystem.js";
import { getCurrentTimeTool } from "./tools/get-current-time.js";
import { createListPluginsTool } from "./tools/list-plugins.js";
import type { MultimodalClientProvider } from "./tools/media-common.js";
import { createReadAttachmentTool } from "./tools/read-attachment.js";
import { createSuggestPluginTool } from "./tools/suggest-plugin.js";
import { textStatsTool } from "./tools/text-stats.js";
import { createTerminalTool } from "./tools/terminal.js";
import { ToolRegistry } from "./tools/tool-registry.js";
import { createTranscribeAudioTool } from "./tools/transcribe-audio.js";
import { unitConverterTool } from "./tools/unit-converter.js";
import { createWebSearchTool } from "./tools/web-search.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 相对路径的解析基准（PAN_PILOT_HOST_CWD，默认进程启动目录）。 */
const DEFAULT_HOST_CWD = process.cwd();

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
  /** 控制台登录密码；只用于签发浏览器通行证，不会返回给客户端。 */
  consolePassword?: string;
  /** 浏览器通行证有效期；生产默认 30 天，测试可缩短。 */
  consolePassportTtlMs?: number;
  logChatContent?: boolean;
  loggerInstance?: FastifyBaseLogger;
  /** 插件目录，默认取 PAN_PILOT_PLUGINS_DIR 或 ./plugins。 */
  pluginsDir?: string;
  /** 逗号分隔的 http 插件 host 白名单，默认取 PAN_PILOT_PLUGIN_ALLOWED_HOSTS。 */
  pluginAllowedHosts?: string;
  /** 逗号分隔的允许 ${env:NAME} 引用的环境变量名白名单。 */
  pluginAllowedEnvVars?: string;
  /** http 插件执行用的 fetch 实现，测试注入替身。 */
  pluginFetchImpl?: typeof fetch;
  /** 媒体存储目录，默认取 PAN_PILOT_MEDIA_DIR 或 ./media。 */
  mediaDir?: string;
  /** 单文件代码产物目录，默认取 PAN_PILOT_ARTIFACTS_DIR 或 ./artifacts。 */
  artifactsDir?: string;
  /** 媒体大小上限（字节），默认 10MB；供测试注入小上限。 */
  mediaMaxBytes?: number;
  /** 媒体存储实例；测试注入可控替身（如删除失败替身），默认新建。 */
  mediaStore?: MediaStore;
  /** 多模态客户端（图片/音频理解），测试注入假实现；默认懒加载火山方舟实现。 */
  multimodalClient?: MultimodalClient;
  /** 定时任务持久目录，默认取 PAN_PILOT_SCHEDULED_TASKS_DIR。 */
  scheduledTasksDir?: string;
  /** 会话历史持久目录，默认取 PAN_PILOT_SESSIONS_DIR。 */
  sessionsDir?: string;
  /** 内建 fs_* 工具允许的根目录白名单（管理员级限制）；默认取 PAN_PILOT_FS_ROOTS，未配置时不限制（整机可访问）。 */
  filesystemRoots?: string[];
  /** 相对路径解析基准；默认取 PAN_PILOT_HOST_CWD，未配置时用进程启动目录。 */
  hostCwd?: string;
  /** 是否注册内建 fs_* 工具；默认开启，传入 false 可显式关闭。 */
  filesystemEnabled?: boolean;
  /** 是否注册内建 terminal 工具；默认开启，传入 false 可显式关闭。 */
  terminalEnabled?: boolean;
  /** 授权数据目录；默认取 PAN_PILOT_PERMISSIONS_DIR。 */
  permissionsDir?: string;
  /** 待决授权请求过期时间（毫秒）；默认取 PAN_PILOT_PERMISSION_REQUEST_TIMEOUT_MS。 */
  permissionRequestTimeoutMs?: number;
  /** 追加的敏感路径 glob 规则；默认取 PAN_PILOT_SENSITIVE_PATHS/PAN_PILOT_SENSITIVE_PATHS_FILE。 */
  extraSensitivePaths?: readonly string[];
  /** 终端额外允许继承的环境变量名白名单；默认取 PAN_PILOT_TERMINAL_ENV_ALLOWLIST。 */
  terminalEnvAllowlist?: string[];
  /** 自我扩展开关（另需已配置 API 鉴权）；默认取 PAN_PILOT_SELF_EXTENSION_ENABLED。 */
  selfExtensionEnabled?: boolean;
  /** 沙箱插件运行目录；默认取 PAN_PILOT_PLUGIN_RUNTIME_DIR。 */
  pluginRuntimeDir?: string;
  /** 依赖 npm registry；默认取 PAN_PILOT_PLUGIN_NPM_REGISTRY。 */
  pluginNpmRegistry?: string;
  /** pnpm 可执行文件；默认取 PAN_PILOT_PNPM_BIN。 */
  pluginPnpmBin?: string;
  /** 默认 agent 系统提示词正文；undefined=内置默认，空字符串=不注入，其余=完全覆盖。 */
  systemPrompt?: string;
  /** 定时任务执行上限，生产默认 10 分钟；测试可缩短。 */
  scheduledTaskRunTimeoutMs?: number;
  /** 测试注入可控时钟。 */
  scheduledTaskNow?: () => Date;
  /** 普通聊天和后台任务共用的上下文预算；默认读取环境变量。 */
  contextOptions?: ContextManagerOptions;
  /** 等待一次模型响应的超时（毫秒）；默认读取 PAN_PILOT_MODEL_TIMEOUT_MS。 */
  modelTimeoutMs?: number;
  /** 单次工具执行的超时（毫秒）；默认读取 PAN_PILOT_TOOL_TIMEOUT_MS。 */
  toolTimeoutMs?: number;
  /** 单个聊天请求的总超时（毫秒）；默认读取 PAN_PILOT_CHAT_TIMEOUT_MS。 */
  chatTimeoutMs?: number;
  /** /v1/chat SSE 心跳间隔（毫秒）；默认读取 PAN_PILOT_HEARTBEAT_INTERVAL_MS。 */
  heartbeatIntervalMs?: number;
  /** SSE 无进展超过该时长后发送 warning（毫秒）；默认读取 PAN_PILOT_SLOW_WARNING_MS。 */
  slowWarningMs?: number;
  /** MCP 配置文件路径；默认取 PAN_PILOT_MCP_CONFIG。 */
  mcpConfigPath?: string;
  /** 测试注入已解析配置，不能与 mcpConfigPath 同时提供。 */
  mcpConfig?: McpConfig;
  /** Streamable HTTP 测试 fetch 替身。 */
  mcpFetchImpl?: typeof fetch;
  /** 测试或嵌入调用方注入 MCP 配置环境变量视图。 */
  mcpEnv?: Readonly<Record<string, string | undefined>>;
  /** 测试注入 MCP 传输。 */
  mcpTransportFactory?: (name: string, config: McpConfig["servers"][string]) => Transport;
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
  const consoleAuth = new ConsoleAuth({
    apiToken,
    password: options.consolePassword ?? process.env.PAN_PILOT_CONSOLE_PASSWORD ?? "",
    ...(options.consolePassportTtlMs === undefined
      ? {}
      : { passportTtlMs: options.consolePassportTtlMs }),
  });
  const logChatContent = options.logChatContent
    ?? isEnabled(process.env.PAN_PILOT_LOG_CHAT_CONTENT);
  const contextOptions = options.contextOptions ?? contextOptionsFromEnv(process.env);
  const modelTimeoutMs = options.modelTimeoutMs
    ?? positiveIntFromEnv(process.env, "PAN_PILOT_MODEL_TIMEOUT_MS", DEFAULT_MODEL_TIMEOUT_MS);
  const toolTimeoutMs = options.toolTimeoutMs
    ?? positiveIntFromEnv(process.env, "PAN_PILOT_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS);
  const chatTimeoutMs = options.chatTimeoutMs
    ?? positiveIntFromEnv(process.env, "PAN_PILOT_CHAT_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? positiveIntFromEnv(
      process.env, "PAN_PILOT_HEARTBEAT_INTERVAL_MS", DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
  const slowWarningMs = options.slowWarningMs
    ?? positiveIntFromEnv(process.env, "PAN_PILOT_SLOW_WARNING_MS", DEFAULT_SLOW_WARNING_MS);
  // 默认 agent 系统提示词：未配置时用内置默认，配成空字符串则完全不注入。
  const systemPrompt = options.systemPrompt
    ?? process.env.PAN_PILOT_SYSTEM_PROMPT;
  const artifactStore = new ArtifactStore(
    options.artifactsDir
      ?? process.env.PAN_PILOT_ARTIFACTS_DIR
      ?? "./artifacts",
  );
  const mediaMaxBytes = options.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const mediaStore = options.mediaStore
    ?? new MediaStore(
        options.mediaDir ?? process.env.PAN_PILOT_MEDIA_DIR ?? "./media",
        { maxBytes: mediaMaxBytes },
      );
  // ---- HostRuntime 核心能力：文件系统 + 终端（不可被插件卸载/遮蔽）。 ----
  const hostCwd = path.resolve(
    options.hostCwd ?? process.env.PAN_PILOT_HOST_CWD ?? DEFAULT_HOST_CWD,
  );
  const fsEnabledConfig = options.filesystemEnabled
    ?? (process.env.PAN_PILOT_FS_ENABLED === undefined
      || isEnabled(process.env.PAN_PILOT_FS_ENABLED));
  const terminalEnabledConfig = options.terminalEnabled
    ?? (process.env.PAN_PILOT_TERMINAL_ENABLED === undefined
      || isEnabled(process.env.PAN_PILOT_TERMINAL_ENABLED));
  // 旧 PAN_PILOT_FS_ROOTS 保留为管理员级限制；未配置时不限制（整机可访问，
  // 受服务账号 OS 权限约束）。
  const adminRoots = options.filesystemRoots
    ?? parseFsRoots(process.env.PAN_PILOT_FS_ROOTS);
  const fsEnabled = fsEnabledConfig;
  const terminalEnvAllowlist = options.terminalEnvAllowlist
    ?? parseNameList(process.env.PAN_PILOT_TERMINAL_ENV_ALLOWLIST);

  // ---- 授权服务（全局单例，聊天与定时任务共享）。 ----
  const permissionStore = new PermissionStore(
    options.permissionsDir
      ?? process.env.PAN_PILOT_PERMISSIONS_DIR
      ?? "./permissions",
  );
  const schedulerRef: { current: ScheduledTaskScheduler | undefined } = {
    current: undefined,
  };
  const permissionService = new PermissionService({
    store: permissionStore,
    requestTimeoutMs: options.permissionRequestTimeoutMs
      ?? positiveIntFromEnv(
        process.env, "PAN_PILOT_PERMISSION_REQUEST_TIMEOUT_MS", 120_000,
      ),
    extraSensitivePatterns: loadExtraSensitivePaths(process.env),
    onRequestDecided: (request) => {
      // 定时任务授权的运行在决定后自动续跑（从同一待执行工具继续）。
      if (request.runId === undefined || schedulerRef.current === undefined) return;
      void schedulerRef.current.continueAfterPermission(request.runId).catch(() => {});
    },
  });

  // 测试注入的客户端直接复用；否则懒加载厂商实现，未配置密钥时服务仍可启动。
  const injectedMultimodal = options.multimodalClient;
  const multimodalProvider: MultimodalClientProvider = injectedMultimodal
    === undefined
    ? () => new VolcengineMultimodalClient()
    : () => injectedMultimodal;
  // 内置实现是插件框架的引用来源；白名单由 plugins/ 下的 manifest 声明。
  // 文件系统与终端归入核心注册表（见下方 registerCore），不在此引用。
  const builtinTools = [
    calculatorTool,
    getCurrentTimeTool,
    dateCalculatorTool,
    unitConverterTool,
    textStatsTool,
    createCodeArtifactTool(artifactStore),
    createWebSearchTool(new BingSearchClient()),
    createAnalyzeImageTool(mediaStore, multimodalProvider),
    createAnalyzeAudioTool(mediaStore, multimodalProvider),
    createTranscribeAudioTool(mediaStore, multimodalProvider),
    createReadAttachmentTool(mediaStore),
  ];
  const toolRegistry = new ToolRegistry();
  // 核心 HostRuntime 工具直接注册到核心注册表（starts 不经过插件/声明式 manifest）。
  const coreHostRuntimeTools = [
    ...(fsEnabled
      ? createFilesystemTools({
          hostCwd,
          adminRoots,
          skipSensitive: (absPath) => permissionService.isSensitivePath(absPath),
        })
      : []),
    ...(terminalEnabledConfig
      ? [createTerminalTool({ defaultCwd: hostCwd, extraEnv: terminalEnvAllowlist })]
      : []),
  ];
  for (const tool of coreHostRuntimeTools) toolRegistry.registerCore(tool);
  // 核心 HostRuntime 工具名：插件加载/安装必须拒绝遮蔽。
  const reservedNames = toolRegistry.coreNames();
  if (options.mcpConfig !== undefined && options.mcpConfigPath !== undefined) {
    throw new Error("mcpConfig and mcpConfigPath cannot both be provided");
  }
  let mcpConfig: McpConfig;
  let mcpConfigError: string | undefined;
  try {
    mcpConfig = options.mcpConfig
      ?? loadMcpConfig(options.mcpConfigPath ?? process.env.PAN_PILOT_MCP_CONFIG);
  } catch {
    // MCP 是独立工具源：配置损坏只关闭 MCP，不阻止聊天、文件和本地插件启动。
    mcpConfig = { version: 1, servers: {} };
    mcpConfigError = "MCP 配置不可用";
  }
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
  // 管理工具通过闭包延迟引用管理器/插件服务，打破构造环；
  // 工具执行发生在 buildApp 组装完成之后，引用必然已就位。
  const managerRef: { current: PluginManager | undefined } = { current: undefined };
  const serviceRef: { current: PluginService | undefined } = {
    current: undefined,
  };
  const mcpRef: { current: McpManager | undefined } = { current: undefined };
  // 内容内置工具 + 只读/建议管理工具构成完整 builtin 集合（install_plugin 已退役：
  // Agent 只能通过 plugin_draft_submit 提交候选包，安装由已鉴权用户接口完成）。
  const allBuiltinTools = [
    ...builtinTools,
    createListPluginsTool(() => {
      if (managerRef.current === undefined) {
        throw new Error("插件管理器尚未就绪");
      }
      return managerRef.current;
    }),
    createSuggestPluginTool(() => {
      if (serviceRef.current === undefined) {
        throw new Error("插件服务尚未就绪");
      }
      return serviceRef.current;
    }),
  ];
  // 自我扩展（沙箱插件）管理器 + 开发工具：仅当 PAN_PILOT_SELF_EXTENSION_ENABLED 且
  // 已配置 API 鉴权时启用。sandboxRef/devToolsRef/pluginManagerRef 先声明供闭包引用。
  const sandboxRef: { current: SandboxPackageManager | undefined } = { current: undefined };
  const devToolsRef: { current: AnyAgentTool[] } = { current: [] };
  const pluginManagerRef: { current: PluginManager | undefined } = { current: undefined };
  const selfExtensionEnabled = (options.selfExtensionEnabled
    ?? isEnabled(process.env.PAN_PILOT_SELF_EXTENSION_ENABLED))
    && apiToken !== "";
  const pluginRuntimeDir = options.pluginRuntimeDir
    ?? process.env.PAN_PILOT_PLUGIN_RUNTIME_DIR
    ?? "./.pan-pilot/plugin-runtime";
  const pluginManager = new PluginManager({
    pluginsDir,
    builtinTools: allBuiltinTools,
    registry: toolRegistry,
    allowedHosts,
    allowedEnvVars,
    ...(options.pluginFetchImpl === undefined
      ? {}
      : { fetchImpl: options.pluginFetchImpl }),
    additionalTools: () => [
      ...mcpRef.current?.listTools() ?? [],
      ...devToolsRef.current,
      ...(sandboxRef.current?.syncTools() ?? []),
    ],
    // 核心 HostRuntime 工具名不可被插件遮蔽/卸载。
    reservedNames,
  });
  pluginManagerRef.current = pluginManager;
  const pluginService = new PluginService({
    manager: pluginManager,
    builtinTools: allBuiltinTools,
    allowedHosts,
    allowedEnvVars,
    reservedNames,
  });
  managerRef.current = pluginManager;
  serviceRef.current = pluginService;
  const mcpManager = new McpManager({
    config: mcpConfig,
    registry: toolRegistry,
    localTools: () => pluginManager.listTools(),
    authConfigured: apiToken !== "",
    ...(options.mcpEnv === undefined ? {} : { env: options.mcpEnv }),
    ...(options.mcpFetchImpl === undefined ? {} : { fetchImpl: options.mcpFetchImpl }),
    ...(options.mcpTransportFactory === undefined
      ? {} : { transportFactory: options.mcpTransportFactory }),
  });
  mcpRef.current = mcpManager;
  const scheduledTaskStore = new ScheduledTaskStore(
    options.scheduledTasksDir
      ?? process.env.PAN_PILOT_SCHEDULED_TASKS_DIR
      ?? "./scheduled-tasks",
  );
  const sessionStore = new SessionStore(
    options.sessionsDir
      ?? process.env.PAN_PILOT_SESSIONS_DIR
      ?? "./sessions",
  );
  const scheduledTaskScheduler = new ScheduledTaskScheduler({
    store: scheduledTaskStore,
    modelRegistry,
    toolRegistry,
    authConfigured: apiToken !== "",
    contextOptions,
    ...(options.scheduledTaskRunTimeoutMs === undefined
      ? {} : { runTimeoutMs: options.scheduledTaskRunTimeoutMs }),
    ...(options.scheduledTaskNow === undefined
      ? {} : { now: options.scheduledTaskNow }),
    permissionService,
  });
  schedulerRef.current = scheduledTaskScheduler;

  // 自我扩展（沙箱插件）启用时：初始化运行存储 + 管理器，注册开发工具，刷新注册表。
  if (selfExtensionEnabled) {
    const extensionStore = new RuntimeStore(pluginRuntimeDir);
    const extensionManager = new SandboxPackageManager({
      store: extensionStore,
      hostCwd,
      adminRoots,
      registry: options.pluginNpmRegistry
        ?? process.env.PAN_PILOT_PLUGIN_NPM_REGISTRY
        ?? "https://registry.npmjs.org",
      ...(options.pluginPnpmBin === undefined
        ? (process.env.PAN_PILOT_PNPM_BIN === undefined
          ? {} : { pnpmBin: process.env.PAN_PILOT_PNPM_BIN })
        : { pnpmBin: options.pluginPnpmBin }),
      onRegistryChanged: async () => {
        await extensionManager.refreshTools();
        pluginManagerRef.current?.refreshDynamicTools();
      },
    });
    sandboxRef.current = extensionManager;
    devToolsRef.current = createPluginDraftTools(() => {
      if (sandboxRef.current === undefined) {
        throw new Error("自我扩展管理器尚未就绪");
      }
      return sandboxRef.current;
    });
    // 启动时空包无工具；安装后由 onRegistryChanged 刷新。这里直接预热缓存。
    void extensionManager.refreshTools();
  }

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
      reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "authorization, content-type, accept");
      reply.header("access-control-expose-headers", "content-disposition");
      reply.header("vary", "origin");
    }
    // 预检请求在鉴权钩子之前结束，浏览器只会在放行来源拿到 CORS 头。
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    // 密码登录与鉴权状态公开；其他版本化业务 API 在配置 token 后要求原始 token 或签名通行证。
    if (!request.url.startsWith("/v1/") || !apiToken) return;
    const pathname = request.url.split("?", 1)[0];
    const isPublicAuthEndpoint = (request.method === "POST" && pathname === "/v1/auth/login")
      || (request.method === "GET" && pathname === "/v1/auth/status");
    if (isPublicAuthEndpoint) return;
    const authorization = request.headers.authorization ?? "";
    const credential = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!consoleAuth.verifyCredential(credential)) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "PanPilot 登录凭证无效或已过期",
      });
    }
  });

  registerHealthRoute(app);
  registerConsoleRoute(app);
  registerConsoleAuthRoute(app, consoleAuth);
  registerCapabilitiesRoute(app, {
    filesystemEnabled: fsEnabled,
    filesystemRoots: adminRoots,
    terminalEnabled: terminalEnabledConfig,
    hostCwd,
    selfExtensionEnabled,
  });
  registerModelsRoute(app, modelRegistry);
  registerChatRoute(app, modelRegistry, toolRegistry, {
    logChatContent,
    mediaStore,
    contextOptions,
    timeouts: {
      modelTimeoutMs,
      toolTimeoutMs,
      timeoutMs: chatTimeoutMs,
    },
    heartbeatIntervalMs,
    slowWarningMs,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    permissionService,
  });
  registerPermissionRoute(app, permissionService);
  registerPluginRoutes(
    app,
    pluginManager,
    pluginService,
    selfExtensionEnabled ? sandboxRef.current : undefined,
  );
  if (selfExtensionEnabled && sandboxRef.current !== undefined) {
    registerPluginCandidatesRoute(app, sandboxRef.current);
  }
  registerArtifactRoute(app, artifactStore);
  registerScheduledTaskRoutes(app, scheduledTaskScheduler);
  registerSessionRoute(app, sessionStore);
  registerMcpRoutes(app, mcpManager, apiToken !== "", mcpConfigError);
  // multipart 的 request.file() 是插件作用域装饰器，媒体路由必须在插件子作用域内注册。
  app.register(async (scopedApp) => {
    await scopedApp.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    });
    registerMediaRoute(scopedApp, mediaStore, mediaMaxBytes);
  });

  app.addHook("onReady", async () => {
    await mcpManager.start();
    await scheduledTaskScheduler.start();
  });
  app.addHook("onClose", async () => {
    await scheduledTaskScheduler.stop();
    await mcpManager.close();
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

/** 文件系统允许根目录白名单；路径可为相对路径（按工作目录解析为绝对路径）。 */
function parseFsRoots(value: string | undefined): string[] {
  return parseNameList(value);
}

/**
 * 追加敏感路径规则：PAN_PILOT_SENSITIVE_PATHS（逗号分隔 glob）
 * + PAN_PILOT_SENSITIVE_PATHS_FILE（JSON 字符串数组）。
 */
function loadExtraSensitivePaths(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const patterns = parseNameList(env.PAN_PILOT_SENSITIVE_PATHS);
  const filePath = env.PAN_PILOT_SENSITIVE_PATHS_FILE;
  if (filePath !== undefined && filePath.trim() !== "") {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string" && item.trim() !== "") {
            patterns.push(item.trim());
          }
        }
      }
    } catch {
      // 敏感路径扩展文件损坏只忽略，不阻止启动。
    }
  }
  return patterns;
}

function contextOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ContextManagerOptions {
  return {
    ...optionalPositiveInt(env.PAN_PILOT_CONTEXT_MAX_TOKENS, "PAN_PILOT_CONTEXT_MAX_TOKENS", "maxInputTokens"),
    ...optionalPositiveInt(env.PAN_PILOT_CONTEXT_TARGET_TOKENS, "PAN_PILOT_CONTEXT_TARGET_TOKENS", "targetInputTokens"),
    ...optionalPositiveInt(env.PAN_PILOT_CONTEXT_RECENT_TOKENS, "PAN_PILOT_CONTEXT_RECENT_TOKENS", "recentInputTokens"),
    ...optionalPositiveInt(env.PAN_PILOT_CONTEXT_SUMMARY_MAX_TOKENS, "PAN_PILOT_CONTEXT_SUMMARY_MAX_TOKENS", "summaryMaxTokens"),
    ...optionalPositiveInt(env.PAN_PILOT_CONTEXT_MAX_MESSAGES, "PAN_PILOT_CONTEXT_MAX_MESSAGES", "maxMessages"),
  };
}

function optionalPositiveInt(
  raw: string | undefined,
  envName: string,
  key: keyof ContextManagerOptions,
): Partial<ContextManagerOptions> {
  if (raw === undefined || raw.trim() === "") return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${envName} 必须是正整数`);
  return { [key]: value };
}

function positiveIntFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}
