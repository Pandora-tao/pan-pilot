import { z } from "zod";

/**
 * 受限沙箱插件包（.ppkg / plugin.json v2）的核心数据契约。
 *
 * 一个包只允许 sandbox-js 运行时：构建为单文件 IIFE（esbuild platform:browser），
 * 在 QuickJS/WASM 沙箱内执行；模型侧工具名统一为 `plugin__<pkg>__<tool>`。
 */

export const PACKAGE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface HostPermission {
  /** 允许访问的文件路径 glob（相对包声明的根，hostCwd 解析）。 */
  files?: readonly string[] | undefined;
  /** 允许访问的 HTTPS host（不含 scheme，可带端口）；可各自声明允许方法。 */
  hosts?: readonly (string | { host: string; methods?: readonly string[] | undefined })[] | undefined;
  /** 允许执行的终端命令模式（简单前缀匹配）。空=禁止终端。 */
  commands?: readonly string[] | undefined;
  /** 是否开放持久 KV 存储（默认 false）。 */
  storage?: boolean | undefined;
  /** 允许注入到 http 请求的凭据槽名（须在服务端配置）。 */
  credentials?: readonly string[] | undefined;
}

export const hostEntrySchema = z.union([
  z.string().min(1).max(512),
  z.object({
    host: z.string().min(1).max(512),
    methods: z.array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])).optional(),
  }).strict(),
]);

export const hostPermissionSchema = z.object({
  files: z.array(z.string().min(1).max(4096)).optional(),
  hosts: z.array(hostEntrySchema).optional(),
  commands: z.array(z.string().min(1).max(2048)).optional(),
  storage: z.boolean().optional(),
  credentials: z.array(z.string().min(1).max(128)).optional(),
}).strict();

/** 解析后的 http 条目标记。 */
export interface ResolvedHostEntry {
  host: string;
  methods: readonly string[];
}

export const pluginToolSchema = z.object({
  name: z.string().regex(TOOL_NAME_PATTERN, "工具名必须匹配 ^[a-z][a-z0-9_]{1,63}$"),
  description: z.string().trim().min(1).max(2000),
  /** 标准 JSON Schema（对象类型）；由宿主编译成 zod。 */
  parameters: z.record(z.string(), z.unknown()).optional(),
  permissions: hostPermissionSchema.optional(),
}).strict();

export type PluginToolDeclaration = z.infer<typeof pluginToolSchema>;

export const pluginManifestV2Schema = z.object({
  apiVersion: z.literal("pan-pilot.plugin/v2"),
  name: z.string().regex(PACKAGE_NAME_PATTERN, "包名必须匹配 ^[a-z][a-z0-9_]{1,63}$"),
  version: z.string().regex(SEMVER_PATTERN, "version 必须是语义化版本"),
  description: z.string().trim().min(1).max(2000),
  runtime: z.object({
    type: z.literal("sandbox-js"),
    entry: z.string().regex(/^bundle\/[A-Za-z0-9_.-]+$/, "entry 必须位于 bundle/ 下"),
  }).strict(),
  tools: z.array(pluginToolSchema).min(1).max(20),
  /** 直接依赖：name -> 精确版本（sample `^`/`~` 之外严格精确）。 */
  dependencies: z.record(z.string(), z.string().regex(SEMVER_PATTERN, "依赖必须使用精确版本")).optional(),
  tests: z.object({
    entry: z.string().regex(/^tests\/[A-Za-z0-9_.-]+$/, "测试入口必须位于 tests/ 下"),
  }).strict().optional(),
}).strict();

export type PluginManifestV2 = z.infer<typeof pluginManifestV2Schema>;

/** 工具权限的解析后形态（合并包级与工具级）。 */
export interface ResolvedPermissions {
  files: readonly string[];
  hosts: readonly ResolvedHostEntry[];
  commands: readonly string[];
  storage: boolean;
  credentials: readonly string[];
}

export function emptyPermissions(): ResolvedPermissions {
  return { files: [], hosts: [], commands: [], storage: false, credentials: [] };
}

export function mergePermissions(...all: readonly (HostPermission | undefined)[]): ResolvedPermissions {
  const files: string[] = [];
  const hosts: ResolvedHostEntry[] = [];
  const commands: string[] = [];
  const credentials: string[] = [];
  let storage = false;
  for (const permission of all) {
    if (permission === undefined) continue;
    if (permission.files) files.push(...permission.files.map((p) => p.trim()).filter((p) => p.length > 0));
    if (permission.hosts) {
      for (const entry of permission.hosts) {
        if (typeof entry === "string") {
          if (entry.trim() !== "") hosts.push({ host: entry.trim(), methods: ["GET", "HEAD"] });
        } else {
          const methods = entry.methods ?? ["GET", "HEAD"];
          hosts.push({ host: entry.host.trim(), methods });
        }
      }
    }
    if (permission.commands) commands.push(...permission.commands.map((c) => c.trim()).filter((c) => c.length > 0));
    if (permission.storage) storage = true;
    if (permission.credentials) credentials.push(...permission.credentials.map((c) => c.trim()).filter((c) => c.length > 0));
  }
  return { files, hosts, commands, storage, credentials: [...new Set(credentials)] };
}

export const lockEntrySchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  /** npm registry 提供的 integrity（SRI）。 */
  integrity: z.string().min(1).max(200),
  license: z.string().min(1).max(200).optional(),
}).strict();

export type LockEntry = z.infer<typeof lockEntrySchema>;

export const dependencyLockSchema = z.object({
  format: z.literal("pan-pilot.dependencies/v1"),
  registry: z.string().min(1).max(2048),
  direct: z.array(lockEntrySchema),
  transitive: z.array(lockEntrySchema),
}).strict();

export type DependencyLock = z.infer<typeof dependencyLockSchema>;

export const testReportSchema = z.object({
  format: z.literal("pan-pilot.tests/v1"),
  typecheck: z.object({
    ok: z.boolean(),
    diagnostics: z.array(z.string()).optional(),
  }).strict(),
  build: z.object({
    ok: z.boolean(),
    outputBytes: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  }).strict(),
  tests: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    error: z.string().optional(),
  }).strict()).optional(),
}).strict();

export type TestReport = z.infer<typeof testReportSchema>;

/** integrity.json：包内文件 SHA-256 + 整体摘要。 */
export const integritySchema = z.object({
  format: z.literal("pan-pilot.integrity/v1"),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type IntegrityManifest = z.infer<typeof integritySchema>;

export const draftStateSchema = z.enum(["editing", "validated", "frozen"]);

export const draftRecordSchema = z.object({
  id: z.string().min(1).max(200),
  state: draftStateSchema,
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type DraftRecord = z.infer<typeof draftRecordSchema>;

export const candidateRecordSchema = z.object({
  id: z.string().min(1).max(200),
  draftId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  expiresAt: z.string(),
}).strict();

export type CandidateRecord = z.infer<typeof candidateRecordSchema>;

export type CandidateRiskSummary =
  | "none"
  | "file_write"
  | "sensitive_read"
  | "terminal"
  | "network"
  | "storage";

export const installedRecordSchema = z.object({
  name: z.string().min(1).max(200),
  versions: z.array(z.string().min(1).max(100)),
  activeVersion: z.string().min(1).max(100),
  previousVersion: z.string().min(1).max(100).optional(),
  enabled: z.boolean(),
  installedAt: z.string(),
}).strict();

export type InstalledRecord = z.infer<typeof installedRecordSchema>;

/** 沙箱上限配置。 */
export interface SandboxLimits {
  memoryLimitBytes: number;
  stackLimitBytes: number;
  cpuLimitMs: number;
  wallLimitMs: number;
  maxHostCalls: number;
  maxIoBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryLimitBytes: 64 * 1024 * 1024,
  stackLimitBytes: 1024 * 1024,
  cpuLimitMs: 5000,
  wallLimitMs: 30_000,
  maxHostCalls: 100,
  maxIoBytes: 1024 * 1024,
};
