import { z } from "zod";

/** 插件名只允许小写字母开头的小写字母、数字、下划线，避免特殊字符进入路由与 URL 模板。 */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const builtinExecutorSchema = z.object({
  type: z.literal("builtin"),
  ref: z.string().trim().min(1, "ref 不能为空").max(200),
}).strict();

const httpExecutorSchema = z.object({
  type: z.literal("http"),
  method: z.enum(["GET", "POST"]).optional(),
  url: z.string().trim().min(1, "url 不能为空").max(2000),
  headers: z.record(
    z.string().min(1).max(100),
    z.string().max(2000),
  ).optional(),
  timeoutMs: z.number().int().min(1).max(60_000).optional(),
  responsePath: z.string().trim().min(1).max(500).optional(),
}).strict();

/** 声明式工具插件 manifest v1 的完整校验。 */
export const pluginManifestSchema = z.object({
  apiVersion: z.literal("v1"),
  name: z.string().regex(
    PLUGIN_NAME_PATTERN,
    "插件名必须匹配 ^[a-z][a-z0-9_]*$",
  ).refine((name) => !name.startsWith("mcp__"), "mcp__ 前缀保留给 MCP 工具"),
  description: z.string().trim().min(1, "description 不能为空").max(2000),
  parameters: z.unknown().refine(
    isObjectSchema,
    "parameters 必须是 type 为 object 的 JSON Schema",
  ),
  executor: z.discriminatedUnion("type", [
    builtinExecutorSchema,
    httpExecutorSchema,
  ]),
  enabled: z.boolean().optional(),
}).strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type HttpExecutor = z.infer<typeof httpExecutorSchema>;

/** 只做最轻量的结构检查；真正的可转换性在 fromJSONSchema 时验证。 */
function isObjectSchema(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type !== "object") return false;
  if (
    obj.properties !== undefined
    && (typeof obj.properties !== "object" || obj.properties === null)
  ) {
    return false;
  }
  return true;
}
