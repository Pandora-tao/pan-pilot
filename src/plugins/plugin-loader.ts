import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import {
  PLUGIN_NAME_PATTERN,
  pluginManifestSchema,
  type PluginManifest,
} from "./manifest-schema.js";

export interface PluginRecord {
  /** manifest 所在目录名。 */
  dirName: string;
  manifestPath: string;
  manifest: PluginManifest;
}

export interface PluginLoadError {
  dirName: string;
  message: string;
}

export interface PluginLoadResult {
  plugins: PluginRecord[];
  errors: PluginLoadError[];
}

/**
 * 插件目录的确定性快照哈希：目录名 + 规范化 manifest + 加载错误。
 * 用于对插件目录生成稳定快照，
 * 批准后任何目录变化都会在执行前被拒绝。
 */
export function hashPluginDirectorySnapshot(pluginsDir: string): string {
  const { plugins, errors } = loadPluginManifests(pluginsDir);
  const snapshot = {
    plugins: plugins
      .map((plugin) => ({
        dirName: plugin.dirName,
        manifest: plugin.manifest,
      }))
      .sort((a, b) => a.dirName.localeCompare(b.dirName)),
    errors: [...errors].sort((a, b) => a.dirName.localeCompare(b.dirName)),
  };
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/**
 * 同步扫描 pluginsDir 下每个子目录的 manifest.json。
 * 单个插件解析失败只进入 errors，不影响其他插件；目录不存在视为空插件集。
 */
export function loadPluginManifests(pluginsDir: string): PluginLoadResult {
  let entries;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return { plugins: [], errors: [] };
  }

  const plugins: PluginRecord[] = [];
  const errors: PluginLoadError[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    // 隐藏目录（如 .hidden）是编辑器/系统备份惯例，不属于插件。
    if (dirName.startsWith(".")) continue;
    if (!PLUGIN_NAME_PATTERN.test(dirName)) {
      errors.push({
        dirName,
        message: "目录名必须匹配 ^[a-z][a-z0-9_]*$",
      });
      continue;
    }

    const manifestPath = path.join(pluginsDir, dirName, "manifest.json");
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      errors.push({ dirName, message: "缺少 manifest.json" });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({
        dirName,
        message: `manifest.json 不是合法 JSON: ${messageOf(error)}`,
      });
      continue;
    }

    const result = pluginManifestSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({ dirName, message: formatZodIssues(result.error.issues) });
      continue;
    }

    // 目录名与 manifest.name 必须一致，避免同义目录造成重复与混乱。
    if (result.data.name !== dirName) {
      errors.push({
        dirName,
        message: `manifest.name 必须是 ${dirName}`,
      });
      continue;
    }

    plugins.push({ dirName, manifestPath, manifest: result.data });
  }

  return { plugins, errors };
}

function formatZodIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) => {
      const where = issue.path.length === 0
        ? ""
        : `${issue.path.map((segment) => String(segment)).join(".")}: `;
      return where + issue.message;
    })
    .join("; ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
