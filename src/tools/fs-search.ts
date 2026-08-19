import { promises as fsp } from "node:fs";
import path from "node:path";
import { globToRegExp } from "../utils/glob.js";

/**
 * 纯 Node 的递归文件搜索（fs_glob / fs_grep 共用）：
 * - 跨平台、不依赖运行时下载二进制；
 * - 跳过 .git 与符号链接目录（避免环路与越界遍历）；
 * - 可注入「敏感路径」过滤器，遍历时不进入 / 不返回敏感项；
 * - 结果有界：limit 限制返回条数，maxWalked 限制扫描文件数，超出即截断。
 */

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

export interface SearchWalkOptions {
  /** 返回结果上限，默认 100。 */
  limit?: number;
  /** 扫描文件数上限（防止大型目录树拖死进程），默认 10000。 */
  maxWalked?: number;
  /** 遍历到某路径（文件或目录）时是否跳过（如敏感路径）。 */
  shouldSkip?: (absPath: string) => boolean | Promise<boolean>;
  /** 需要文本内容（grep）：二进制文件跳过。 */
  wantText?: boolean;
  /** 只处理 basename 匹配 include glob 的文件（grep include 过滤）。 */
  include?: string;
}

export interface GlobMatch {
  path: string;
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface WalkResult<T> {
  items: T[];
  /** 是否因达到 limit / maxWalked 而截断。 */
  truncated: boolean;
  /** 实际扫描了多少个文件。 */
  filesChecked: number;
}

/** fs_glob：递归匹配路径，返回匹配项与截断标记。 */
export async function findMatchingPaths(
  baseDir: string,
  pattern: string,
  options: SearchWalkOptions = {},
): Promise<WalkResult<GlobMatch>> {
  const absolutePattern = path.isAbsolute(pattern);
  const matcher = globToRegExp(pattern);
  const result = await walkFiles(baseDir, {
    ...options,
    matchFile: (absPath) => {
      const candidate = absolutePattern
        ? normalizePath(absPath)
        : normalizePath(path.relative(baseDir, absPath));
      return matcher.test(candidate);
    },
    collect: (absPath) => ({ path: absPath }),
  });
  return {
    items: result.items as GlobMatch[],
    truncated: result.truncated,
    filesChecked: result.filesChecked,
  };
}

/** fs_grep：递归按正则匹配文本行。 */
export async function findMatchingLines(
  baseDir: string,
  regex: RegExp,
  options: SearchWalkOptions = {},
): Promise<WalkResult<GrepMatch>> {
  const includeRe = options.include === undefined
    ? undefined
    : globToRegExp(options.include);
  const result = await walkFiles(baseDir, {
    ...options,
    wantText: true,
    ...(includeRe === undefined ? {} : {
      matchFile: (absPath) => includeRe.test(path.basename(absPath)),
    }),
    collectLine: (absPath, lineNumber, line) => ({
      path: absPath,
      lineNumber,
      line: line.length > 500 ? `${line.slice(0, 500)}…` : line,
    }),
    testLine: (line) => regex.test(line),
  });
  return {
    items: result.items as GrepMatch[],
    truncated: result.truncated,
    filesChecked: result.filesChecked,
  };
}

type CollectOutput = GlobMatch | GrepMatch;

interface WalkFileOptions extends SearchWalkOptions {
  matchFile?: (absPath: string) => boolean;
  collect?: (absPath: string) => CollectOutput;
  collectLine?: (absPath: string, lineNumber: number, line: string) => CollectOutput;
  testLine?: (line: string) => boolean;
}

async function walkFiles(
  root: string,
  options: WalkFileOptions,
): Promise<WalkResult<CollectOutput>> {
  const limit = options.limit ?? 100;
  const maxWalked = options.maxWalked ?? 10_000;
  const wantText = options.wantText ?? false;
  const shouldSkip = options.shouldSkip ?? (() => false);

  const items: CollectOutput[] = [];
  let filesChecked = 0;
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      if (filesChecked >= maxWalked) {
        truncated = true;
        break;
      }
      const entryPath = path.join(current, entry.name);
      if (await shouldSkip(entryPath)) continue;
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (options.wantText && looksLikeGenerated(entry.name)) continue;
      filesChecked += 1;

      if (wantText) {
        if (options.matchFile !== undefined && !options.matchFile(entryPath)) continue;
        const matches = await scanFileLines(
          entryPath,
          options.testLine!,
          options.collectLine!,
          limit - items.length,
        );
        items.push(...matches);
        // 单个文件内达到结果上限同样视为截断。
        if (items.length >= limit) truncated = true;
      } else {
        if (options.matchFile !== undefined && !options.matchFile(entryPath)) continue;
        if (options.collect !== undefined) items.push(options.collect(entryPath));
      }
    }
    if (truncated) break;
  }

  return { items, truncated, filesChecked };
}

/** 读取文本文件并收集满足条件的行（二进制 / 超大文件跳过）。 */
async function scanFileLines<T>(
  absPath: string,
  testLine: (line: string) => boolean,
  collect: (absPath: string, lineNumber: number, line: string) => T,
  maxMatches: number,
): Promise<T[]> {
  if (maxMatches <= 0) return [];
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(absPath);
  } catch {
    return [];
  }
  if (buffer.byteLength > MAX_FILE_READ_BYTES) return [];
  if (buffer.includes(0)) return [];
  const content = buffer.toString("utf8");
  const result: T[] = [];
  const lines = content.split(/\r\n|\r|\n/);
  let consumed = 0;
  for (let i = 0; i < lines.length && consumed < maxMatches; i += 1) {
    const line = lines[i]!;
    if (!testLine(line)) continue;
    result.push(collect(absPath, i + 1, line));
    consumed += 1;
  }
  return result;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

/** 明显非源文本的生成物目录跳过，减小噪音。 */
function looksLikeGenerated(name: string): boolean {
  return name === "package-lock.json"
    || name === "pnpm-lock.yaml"
    || name === "yarn.lock"
    || name.endsWith(".min.js")
    || name.endsWith(".min.css")
    || name.endsWith(".map");
}
