import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../plugins/canonical-json.js";
import type { IntegrityManifest } from "./types.js";

/** 计算字节内容 SHA-256。 */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const META_RECORDS = new Set(["draft.json", "candidate.json", "integrity.json"]);

/**
 * 扫描目录下全部常规文件（跳过符号链接、隐藏临时文件与元记录），
 * 返回相对路径 -> SHA-256。只扫描常规文件；目标必须是目录。
 */
export async function hashDirectory(
  root: string,
  prefix = "",
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (META_RECORDS.has(entry.name)) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const abs = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      Object.assign(out, await hashDirectory(abs, rel));
    } else if (entry.isFile()) {
      const buffer = await fsp.readFile(abs);
      out[rel] = sha256(buffer);
    }
  }
  return out;
}

/**
 * 生成包完整性清单：扫描候选目录下所有文件，然后对「清单中声明的关键条目」求整体摘要。
 * digest = sha256(规范化 JSON(plugin.json) + 排序后的文件清单)。
 */
export async function buildIntegrity(
  packageRoot: string,
  manifestJson: Record<string, unknown>,
): Promise<IntegrityManifest> {
  const files = await hashDirectory(packageRoot);
  const digest = sha256(
    `${canonicalJson(manifestJson)}\n${canonicalJson(files)}`,
  );
  return { format: "pan-pilot.integrity/v1", files, digest };
}

/** 便捷：读取 JSON 文件。 */
export async function readJsonFile<T>(
  absPath: string,
): Promise<T | undefined> {
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * 校验目录完整性：重算 digest 与逐文件清单，与提交时记录的 integrity 比较。
 * digest = sha256(规范化 plugin.json + 规范化文件清单)。
 */
export async function verifyIntegrity(
  packageRoot: string,
  recorded: IntegrityManifest,
): Promise<{ ok: boolean; errors: string[] }> {
  const manifest = await readJsonFile<Record<string, unknown>>(
    path.join(packageRoot, "plugin.json"),
  );
  if (manifest === undefined) {
    return { ok: false, errors: ["缺少 plugin.json"] };
  }
  const rebuilt = await buildIntegrity(packageRoot, manifest);
  const errors: string[] = [];
  if (rebuilt.digest !== recorded.digest) {
    errors.push("包整体摘要不一致（内容可能被篡改），需要重新审核");
  }
  for (const [name, checksum] of Object.entries(rebuilt.files)) {
    if (recorded.files[name] !== undefined && recorded.files[name] !== checksum) {
      errors.push(`文件校验和变化: ${name}`);
    }
  }
  for (const name of Object.keys(recorded.files)) {
    if (rebuilt.files[name] === undefined) {
      errors.push(`缺失文件: ${name}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function writeJsonFile(
  absPath: string,
  value: unknown,
): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, `${JSON.stringify(value, null, 2)}\n`);
}
