import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { PLUGIN_NAME_PATTERN, type PluginManifest } from "./manifest-schema.js";

export type PluginWriteErrorCode = "PLUGIN_EXISTS" | "WRITE_FAILED";

export class PluginWriteError extends Error {
  readonly code: PluginWriteErrorCode;

  constructor(code: PluginWriteErrorCode, message: string) {
    super(message);
    this.name = "PluginWriteError";
    this.code = code;
  }
}

export interface WrittenPlugin {
  name: string;
  dirPath: string;
  manifestPath: string;
}

/**
 * 磁盘上是否已存在同名插件目录（用于草案阶段快速冲突检查）。
 * 名字已经过 manifest schema 校验（^[a-z][a-z0-9_]*$），不存在路径穿越面。
 */
export function pluginExistsOnDisk(
  pluginsDir: string,
  name: string,
): boolean {
  return existsDirectory(path.join(pluginsDir, name));
}

/**
 * 创建新插件：目标目录 + manifest.json，create-only，绝不覆盖已有内容。
 *
 * 原子性保障：
 * 1. 临时文件用 `wx` 独占创建，避免与并发写入者互相覆盖；
 * 2. 同目录临时文件通过 link 原子建链，目标已存在时内核直接返回 EEXIST，
 *    不存在「检查后改名」的 TOCTOU 窗口；
 * 3. 任一步失败都会清理临时文件，磁盘不留半成品。
 */
export function writeNewPluginManifest(
  pluginsDir: string,
  manifest: PluginManifest,
): WrittenPlugin {
  if (!PLUGIN_NAME_PATTERN.test(manifest.name)) {
    throw new PluginWriteError(
      "WRITE_FAILED",
      `插件名非法（必须匹配 ^[a-z][a-z0-9_]*$）: ${manifest.name}`,
    );
  }

  const dirPath = path.join(pluginsDir, manifest.name);
  try {
    // 目录已存在时 mkdir 直接失败，天然 create-only。
    mkdirSync(dirPath);
  } catch (error) {
    if (isEexist(error)) {
      throw new PluginWriteError("PLUGIN_EXISTS", `插件 ${manifest.name} 已存在`);
    }
    throw new PluginWriteError(
      "WRITE_FAILED",
      `创建插件目录失败: ${messageOf(error)}`,
    );
  }

  const manifestPath = path.join(dirPath, "manifest.json");
  const tempPath = path.join(dirPath, `.manifest-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    // link 在目标已存在时原子失败，防止 TOCTOU 期间的同名覆盖。
    linkSync(tempPath, manifestPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    if (isEexist(error)) {
      throw new PluginWriteError("PLUGIN_EXISTS", `插件 ${manifest.name} 已存在`);
    }
    throw new PluginWriteError(
      "WRITE_FAILED",
      `写入插件 manifest 失败: ${messageOf(error)}`,
    );
  } finally {
    rmSync(tempPath, { force: true });
  }

  return { name: manifest.name, dirPath, manifestPath };
}

/**
 * 回滚本次执行写入的文件：只删除目标 manifest 与（若空）目录，
 * 不影响目录内任何既有内容；reload 失败时调用，恢复旧有效文件状态。
 */
export function rollbackNewPlugin(pluginsDir: string, name: string): void {
  const dirPath = path.join(pluginsDir, name);
  rmSync(path.join(dirPath, "manifest.json"), { force: true });
  try {
    rmdirSync(dirPath);
  } catch {
    // 目录非空（例如被并发写入）时保留目录本身。
  }
}

/** 读取落盘 manifest 原文，供执行阶段与批准动作做哈希一致性校验。 */
export function readPluginManifestRaw(manifestPath: string): string {
  return readFileSync(manifestPath, "utf8");
}

/**
 * 插件 manifest 的内容指纹（规范化哈希）。
 * set_plugin_enabled 审批用它绑定「审批时该插件的具体版本」，
 * 执行前若同名插件内容已被替换则拒绝执行。
 */
export function readPluginManifestFingerprint(
  pluginsDir: string,
  name: string,
): string {
  const raw = readFileSync(path.join(pluginsDir, name, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as PluginManifest;
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

function existsDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
