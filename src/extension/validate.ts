import path from "node:path";
import {
  pluginManifestV2Schema,
  SEMVER_PATTERN,
  type PluginManifestV2,
} from "./types.js";

/** 扩展层稳定错误。 */
export class ExtensionError extends Error {
  constructor(
    readonly code:
      | "INVALID_PACKAGE"
      | "DIGEST_MISMATCH"
      | "DUPLICATE_DECISION"
      | "CANDIDATE_EXPIRED"
      | "CANDIDATE_NOT_FOUND"
      | "VERSION_REGRESSION"
      | "ALREADY_INSTALLED"
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "PATH_UNSAFE"
      | "FILE_TOO_LARGE"
      | "NOT_ENABLED",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExtensionError";
    if (details !== undefined) this.details = details;
  }
}

/** 草稿允许写入的顶层相对路径集合。 */
export const DRAFT_ALLOWED_TOP_LEVEL = new Set([
  "plugin.json",
  "source",
  "tests",
]);

/** 草稿源码文件允许扩展名。 */
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]);

/**
 * 校验草稿文件相对路径：拒绝 `..`、绝对路径、反斜杠、`\0`、非 UTF-8 形态、
 * 顶层未知入口、源码目录外的非法扩展名。
 */
export function assertSafeDraftPath(relPath: string, topLevelAllowed = DRAFT_ALLOWED_TOP_LEVEL): void {
  if (relPath === "") throw new ExtensionError("PATH_UNSAFE", "路径不能为空");
  if (relPath.includes("\0")) throw new ExtensionError("PATH_UNSAFE", "路径包含 NUL");
  if (relPath.includes("\\")) throw new ExtensionError("PATH_UNSAFE", "路径不能包含反斜杠");
  if (path.isAbsolute(relPath)) throw new ExtensionError("PATH_UNSAFE", "路径不能是绝对路径");
  const segments = relPath.split("/");
  if (segments.some((segment) => segment === "" || segment === ".." || segment === ".")) {
    throw new ExtensionError("PATH_UNSAFE", `路径包含非法段: ${relPath}`);
  }
  const topLevel = segments[0];
  if (topLevel === undefined || !topLevelAllowed.has(topLevel)) {
    throw new ExtensionError("PATH_UNSAFE", `顶层入口不允许: ${relPath}`);
  }
  const ext = path.extname(relPath).toLowerCase();
  if (topLevel === "source" && segments.length > 1 && !SOURCE_EXTENSIONS.has(ext)) {
    throw new ExtensionError("PATH_UNSAFE", `源码扩展名不允许: ${relPath}`);
  }
  if (topLevel === "tests" && segments.length > 1 && !SOURCE_EXTENSIONS.has(ext)) {
    throw new ExtensionError("PATH_UNSAFE", `测试文件扩展名不允许: ${relPath}`);
  }
}

/** 解析并校验 manifest（v2，仅 sandbox-js）。 */
export function parseManifest(raw: unknown): PluginManifestV2 {
  const parsed = pluginManifestV2Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ExtensionError("INVALID_PACKAGE", "plugin.json 不合法", parsed.error.issues);
  }
  const manifest = parsed.data;
  const seen = new Set<string>();
  for (const tool of manifest.tools) {
    if (seen.has(tool.name)) {
      throw new ExtensionError("INVALID_PACKAGE", `工具名重复: ${tool.name}`);
    }
    seen.add(tool.name);
  }
  return manifest;
}

/** 语义化版本比较：a > b → 1；a < b → -1；相等 → 0。 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === undefined || pb === undefined) return a.localeCompare(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

interface ParsedSemver {
  nums: [number, number, number];
  pre?: string;
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch, pre] = match;
  return {
    nums: [Number(major), Number(minor), Number(patch)],
    ...(pre === undefined ? {} : { pre }),
  };
}
