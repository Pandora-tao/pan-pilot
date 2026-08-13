import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
  type Tool,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AnyAgentTool } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  type McpConfig,
  type McpServerConfig,
  resolveConfigValue,
} from "./mcp-config.js";
import { createMcpTool } from "./mcp-tool.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_DEFINITION_BYTES = 256 * 1024;
const MAX_SERVER_DEFINITIONS_BYTES = 1024 * 1024;

export type McpServerState = "connected" | "disabled" | "error";

export interface McpServerStatus {
  name: string;
  transport: McpServerConfig["transport"];
  state: McpServerState;
  toolNames: string[];
  server?: { name: string; version: string };
  connectedAt?: string;
  error?: string;
}

interface McpConnection {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: AnyAgentTool[];
  status: McpServerStatus;
}

export interface McpManagerOptions {
  config: McpConfig;
  registry: ToolRegistry;
  /** 每次 MCP 工具变化后提供当前插件工具，避免覆盖动态插件注册表。 */
  localTools: () => readonly AnyAgentTool[];
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  /** 未配置 PanPilot API Token 时为 false，完全不连接外部 MCP。 */
  authConfigured?: boolean;
  /** 协议集成测试注入 InMemoryTransport；生产使用 stdio/Streamable HTTP。 */
  transportFactory?: (name: string, config: McpServerConfig) => Transport;
}

/**
 * MCP Client 生命周期管理器：连接运维配置中的 Server，把远端工具加命名空间后
 * 原子合并进现有 ToolRegistry。单个连接失败只记录状态，不阻断其他 Server。
 */
export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly statuses = new Map<string, McpServerStatus>();
  private started = false;
  private closed = false;
  private refreshQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: McpManagerOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.options.authConfigured === false) return;
    const entries = Object.entries(this.options.config.servers)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [name, config] of entries) {
      if (config.enabled === false) {
        this.statuses.set(name, {
          name,
          transport: config.transport,
          state: "disabled",
          toolNames: [],
        });
        continue;
      }
      try {
        await this.connect(name, config);
      } catch (error) {
        this.statuses.set(name, {
          name,
          transport: config.transport,
          state: "error",
          toolNames: [],
          error: "MCP Server 连接或工具发现失败",
        });
      }
    }
    this.rebuildRegistry();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.client.close()),
    );
    await this.refreshQueue.catch(() => {});
    this.connections.clear();
  }

  listStatuses(): McpServerStatus[] {
    return [...this.statuses.values()]
      .map((status) => structuredClone(status))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listTools(): AnyAgentTool[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  private async connect(name: string, config: McpServerConfig): Promise<void> {
    const client = new Client(
      { name: "pan-pilot", version: "0.1.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => void this.queueRefresh(name),
          },
        },
      },
    );
    const transport = this.options.transportFactory?.(name, config)
      ?? (config.transport === "stdio"
      ? new StdioClientTransport({
          command: resolveConfigValue(config.command, this.options.env),
          ...(config.args === undefined ? {} : {
            args: config.args.map((value) => resolveConfigValue(value, this.options.env)),
          }),
          ...(config.cwd === undefined
            ? {} : { cwd: resolveConfigValue(config.cwd, this.options.env) }),
          ...(config.env === undefined
            ? {} : {
                env: {
                  ...getDefaultEnvironment(),
                  ...resolveRecord(config.env, this.options.env),
                },
              }),
          stderr: "ignore",
        })
      : new StreamableHTTPClientTransport(
          new URL(resolveConfigValue(config.url, this.options.env)),
          {
            ...(config.headers === undefined
              ? {}
              : { requestInit: { headers: resolveRecord(config.headers, this.options.env) } }),
            ...(this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl }),
          },
        ));
    try {
      await client.connect(transport, {
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const tools = await this.discoverTools(name, client, config.timeoutMs);
      this.assertCanRegister(name, tools);
      const serverVersion = client.getServerVersion();
      const status: McpServerStatus = {
        name,
        transport: config.transport,
        state: "connected",
        toolNames: tools.map((tool) => tool.name),
        connectedAt: new Date().toISOString(),
        ...(serverVersion === undefined ? {} : {
          server: { name: serverVersion.name, version: serverVersion.version },
        }),
      };
      this.connections.set(name, { name, config, client, tools, status });
      this.statuses.set(name, status);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private queueRefresh(name: string): Promise<void> {
    const operation = this.refreshQueue.then(async () => {
      if (this.closed) return;
      const connection = this.connections.get(name);
      if (connection === undefined) return;
      try {
        const tools = await this.discoverTools(
          name,
          connection.client,
          connection.config.timeoutMs,
        );
        this.assertCanRegister(name, tools);
        connection.tools = tools;
        const { error: _previousError, ...previous } = connection.status;
        connection.status = {
          ...previous,
          state: "connected",
          toolNames: connection.tools.map((tool) => tool.name),
        };
        this.statuses.set(name, connection.status);
        this.rebuildRegistry();
      } catch (error) {
        connection.status = {
          ...connection.status,
          state: "error",
          error: "MCP Server 工具刷新失败",
        };
        this.statuses.set(name, connection.status);
      }
    });
    this.refreshQueue = operation.catch(() => {});
    return operation;
  }

  private async discoverTools(
    serverName: string,
    client: Client,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<AnyAgentTool[]> {
    const { tools } = await client.listTools(undefined, {
      signal: AbortSignal.timeout(timeoutMs),
      cacheMode: "refresh",
    });
    assertToolDefinitionLimits(serverName, tools);
    assertUniqueRemoteNames(serverName, tools);
    return tools.map((tool) => createMcpTool(serverName, tool, client, timeoutMs));
  }

  private rebuildRegistry(): void {
    this.options.registry.replaceAll([
      ...this.options.localTools(),
      ...this.listTools(),
    ]);
  }

  private assertCanRegister(serverName: string, tools: readonly AnyAgentTool[]): void {
    const candidates = [
      ...this.options.localTools(),
      ...[...this.connections.values()]
        .filter((connection) => connection.name !== serverName)
        .flatMap((connection) => connection.tools),
      ...tools,
    ];
    const seen = new Set<string>();
    for (const tool of candidates) {
      if (seen.has(tool.name)) {
        throw new Error(`MCP 工具名 ${tool.name} 与现有工具冲突`);
      }
      seen.add(tool.name);
    }
  }
}

function resolveRecord(
  values: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolveConfigValue(value, env)]),
  );
}

function assertUniqueRemoteNames(serverName: string, tools: readonly Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`MCP Server ${serverName} 返回了重复工具 ${tool.name}`);
    }
    seen.add(tool.name);
  }
}

function assertToolDefinitionLimits(serverName: string, tools: readonly Tool[]): void {
  if (tools.length > MAX_TOOLS_PER_SERVER) {
    throw new Error(`MCP Server ${serverName} 工具数量超过 ${MAX_TOOLS_PER_SERVER}`);
  }
  let totalBytes = 0;
  for (const tool of tools) {
    const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
    if (bytes > MAX_TOOL_DEFINITION_BYTES) {
      throw new Error(`MCP Server ${serverName} 的工具 ${tool.name} 定义过大`);
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_SERVER_DEFINITIONS_BYTES) {
    throw new Error(`MCP Server ${serverName} 工具定义总量过大`);
  }
}
