import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(4000)).max(100).optional(),
  cwd: z.string().trim().min(1).max(2000).optional(),
  env: z.record(
    z.string().regex(ENV_NAME_PATTERN),
    z.string().max(20_000),
  ).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  enabled: z.boolean().optional(),
}).strict();

const httpServerSchema = z.object({
  transport: z.literal("streamableHttp"),
  url: z.string().url().max(2000).refine(
    (value) => {
      const url = new URL(value);
      return (url.protocol === "https:" || isLoopbackHttp(url))
        && url.username === ""
        && url.password === ""
        && url.hash === "";
    },
    "远程 MCP 必须使用 https（仅回环地址允许 http），且 URL 不能含凭据或 fragment",
  ),
  headers: z.record(
    z.string().trim().min(1).max(200),
    z.string().max(20_000),
  ).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  enabled: z.boolean().optional(),
}).strict().superRefine((server, context) => {
  for (const key of Object.keys(server.headers ?? {})) {
    if (RESERVED_HTTP_HEADERS.has(key.toLowerCase())) {
      context.addIssue({
        code: "custom",
        path: ["headers", key],
        message: `请求头 ${key} 由 MCP 传输管理，不能覆盖`,
      });
    }
  }
});

const RESERVED_HTTP_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "origin",
  "mcp-protocol-version",
  "mcp-session-id",
  "mcp-method",
  "mcp-name",
]);

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  stdioServerSchema,
  httpServerSchema,
]);

export const mcpConfigSchema = z.object({
  version: z.literal(1),
  servers: z.record(
    z.string().regex(SERVER_NAME_PATTERN),
    mcpServerConfigSchema,
  ),
}).strict();

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

export class McpConfigError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "McpConfigError";
  }
}

export function loadMcpConfig(configPath: string | undefined): McpConfig {
  if (configPath === undefined || configPath.trim() === "") {
    return { version: 1, servers: {} };
  }
  const resolvedPath = path.resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new McpConfigError(`无法读取 MCP 配置文件 ${resolvedPath}`, error);
  }
  try {
    return mcpConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new McpConfigError(`MCP 配置文件 ${resolvedPath} 不合法`, error);
  }
}

export function resolveConfigValue(
  raw: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return raw.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) throw new McpConfigError(`MCP 配置引用的环境变量 ${name} 未配置`);
    return value;
  });
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
