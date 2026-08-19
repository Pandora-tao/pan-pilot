import { promises as fsp } from "node:fs";
import path from "node:path";

/**
 * 路径精确的主机文件工具与权限判定共用的解析原语。
 */

/** 判断 child 是否在 parent 内部（含相等），基于规范化路径字符串。 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 找到给定路径的「最深已存在祖先」的真实路径（解析整条符号链接链）。
 * 用于对尚不存在部分也做包含验证，拦截「通过指向外部目录的符号链接写入」。
 */
export async function realpathOfExistingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await fsp.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`无法解析路径 ${target} 的真实位置`);
      }
      current = parent;
    }
  }
}

export interface HostPathResolutionOptions {
  /** 相对路径基准目录（PAN_PILOT_HOST_CWD 解析值）。 */
  baseDir: string;
  /** 相对路径不允许越过 baseDir；绝对路径始终放行（整机可访问）。 */
  allowOutsideBase: boolean;
}

export class HostPathError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "HostPathError";
  }
}

/**
 * 把模型传入的原始路径解析为绝对路径：
 * - 相对路径基于 baseDir（允许 `../` 越过时不做包含约束）；
 * - 绝对路径直接规范化（整台主机可访问）；
 * - 空路径与超长路径拒绝。
 */
export function resolveHostPath(
  raw: string,
  baseDir: string,
  operation: string,
): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new HostPathError(operation, "路径不能为空");
  }
  if (trimmed.length > 4096) {
    throw new HostPathError(operation, "路径过长");
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(baseDir, trimmed);
}
