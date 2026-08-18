import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentTool, AnyAgentTool } from "./tool.js";

/**
 * 内建 fs_* 工具：让 Agent 在宿主机上操作文件，但严格限制在允许的根目录白名单内。
 *
 * 安全模型（必须在把工具暴露给模型时保持）：
 * - 只有 PAN_PILOT_FS_ENABLED=true 且配置了 PAN_PILOT_FS_ROOTS 的根目录才会注册；
 * - 所有路径先 path.resolve 规范化，再做「语法层」包含校验；
 * - 再对「最深已存在祖先」做 realpath 真实验证，拦截符号链接逃逸（含 macOS
 *   /tmp -> /private/tmp 这类根目录本身是链接的情况）；
 * - 读/写分离、大小上限，默认 fail-closed。
 */

export interface FilesystemToolOptions {
  /** 允许 Agent 访问的根目录白名单（相对路径会按工作目录解析为绝对路径）。 */
  roots: readonly string[];
  /** 单个文件读操作的最大字节数，默认 1MB。 */
  maxReadBytes?: number;
  /** 单次写/追加操作允许的最大字节数，默认 4MB。 */
  maxWriteBytes?: number;
}

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const MAX_PATH_LENGTH = 4096;

/** 文件系统工具边界的稳定错误类型，便于测试断言与后续按码反馈模型。 */
export class FilesystemToolError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "FilesystemToolError";
  }
}

const pathInput = z.string().trim().min(1, "路径不能为空").max(MAX_PATH_LENGTH);

const listSchema = z.object({ path: pathInput }).strict();
const infoSchema = z.object({ path: pathInput }).strict();
const readSchema = z.object({ path: pathInput }).strict();
const writeSchema = z.object({
  path: pathInput,
  content: z.string(),
  /** append: 追加到文件末尾（不存在则创建）；write: 覆盖或新建。 */
  mode: z.enum(["write", "append"]).default("write"),
  /** 为 true 时自动创建目标目录的父目录链。 */
  createParents: z.boolean().default(false),
}).strict();
const deleteSchema = z.object({
  path: pathInput,
  /** 为 true 时允许递归删除目录；默认只允许单文件或空目录。 */
  recursive: z.boolean().default(false),
}).strict();

/** 判断 child 是否在 parent 内部（含相等），基于规范化路径字符串。 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertInsideRoots(
  roots: readonly string[],
  candidate: string,
  operation: string,
): void {
  for (const root of roots) {
    if (isInside(root, candidate)) return;
  }
  throw new FilesystemToolError(
    operation,
    `路径 ${candidate} 超出允许访问的根目录范围`,
  );
}

/**
 * 找到给定路径的「最深已存在祖先」的真实路径（解析整条符号链接链）。
 * 用于对尚不存在部分也做包含验证，拦截「通过指向外部目录的符号链接写入」。
 */
async function realpathOfExistingAncestor(target: string): Promise<string> {
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

function assertValidByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
}

/** 构造路径沙箱：所有函数返回已在允许根目录内的绝对路径，否则抛 FilesystemToolError。 */
function createSandbox(roots: readonly string[]) {
  const normalizedRoots = [...new Set(
    roots.map((root) => root.trim()).filter((root) => root.length > 0)
      .map((root) => path.resolve(root)),
  )];
  if (normalizedRoots.length === 0) {
    throw new Error("filesystem 工具必须配置至少一个允许的根目录");
  }
  // 根目录本身可能是符号链接（如 macOS /tmp -> /private/tmp），
  // 因此先对每个根目录做 realpath，包含判断统一基于真实路径。
  let realRootsPromise: Promise<string[]> | undefined;
  const realRoots = (): Promise<string[]> => {
    realRootsPromise ??= Promise.all(normalizedRoots.map((root) =>
      fsp.realpath(root).catch(() => {
        throw new FilesystemToolError(
          "sandbox",
          `允许的根目录不存在或不可访问: ${root}`,
        );
      }),
    ));
    return realRootsPromise;
  };

  function resolveRawToAbsolute(raw: string, operation: string): string {
    const trimmed = raw.trim();
    if (trimmed === "") {
      throw new FilesystemToolError(operation, "路径不能为空");
    }
    const abs = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.resolve(normalizedRoots[0] ?? ".", trimmed);
    // 语法层防御：未存在的部分也必须落在某个规范化根内。
    assertInsideRoots(normalizedRoots, abs, operation);
    return abs;
  }

  async function assertRealInside(abs: string, operation: string): Promise<void> {
    const rootsReal = await realRoots();
    const realAncestor = await realpathOfExistingAncestor(abs);
    assertInsideRoots(rootsReal, realAncestor, operation);
  }

  return {
    normalizedRoots,
    resolveReadPath: async (raw: string, operation: string): Promise<string> => {
      const abs = resolveRawToAbsolute(raw, operation);
      await assertRealInside(abs, operation);
      return abs;
    },
    resolveWritePath: async (raw: string, operation: string): Promise<string> => {
      const abs = resolveRawToAbsolute(raw, operation);
      // 写操作的逃逸只能经由「已存在的符号链接祖先」，realpath 最深已存在
      // 祖先即可覆盖整条链，无需再对新建部分做 realpath（新建的就是普通目录）。
      await assertRealInside(abs, operation);
      return abs;
    },
  };
}

function makeFsTool<T>(
  name: string,
  description: string,
  inputSchema: z.ZodType<T>,
  handler: (input: T, signal: AbortSignal | undefined) => Promise<unknown>,
): AgentTool<T, unknown> {
  return { name, description, inputSchema, execute: handler };
}

/**
 * 创建一套内建文件系统工具（fs_list/fs_info/fs_read/fs_read_base64/fs_write/fs_delete）。
 * roots 为空时直接抛错，接线方应在未启用时不要调用本函数。
 */
export function createFilesystemTools(
  options: FilesystemToolOptions,
): AnyAgentTool[] {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  assertValidByteLimit(maxReadBytes, "maxReadBytes");
  assertValidByteLimit(maxWriteBytes, "maxWriteBytes");
  const sandbox = createSandbox(options.roots);

  return [
    makeFsTool(
      "fs_list",
      "列出目录下的子项（名称与类型），最多返回 1000 项。path 必须是绝对路径或相对允许根目录的相对路径。",
      listSchema,
      async (input, signal) => {
        signal?.throwIfAborted();
        const abs = await sandbox.resolveReadPath(input.path, "fs_list");
        signal?.throwIfAborted();
        const dirEntries = await fsp.readdir(abs, { withFileTypes: true });
        signal?.throwIfAborted();
        const truncated = dirEntries.length > MAX_LIST_ENTRIES;
        const entries = dirEntries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        }));
        return { path: abs, entries, truncated };
      },
    ),

    makeFsTool(
      "fs_info",
      "查询单个文件或目录的信息（类型、大小、修改时间）；路径不存在时返回 exists:false。",
      infoSchema,
      async (input, signal) => {
        signal?.throwIfAborted();
        const abs = await sandbox.resolveReadPath(input.path, "fs_info");
        signal?.throwIfAborted();
        let stats;
        try {
          stats = await fsp.stat(abs);
        } catch (error) {
          if (isMissing(error)) return { path: abs, exists: false };
          throw error;
        }
        signal?.throwIfAborted();
        const type = stats.isDirectory()
          ? "dir"
          : stats.isFile()
          ? "file"
          : "other";
        const mtimeValid = !Number.isNaN(stats.mtime.getTime());
        return {
          path: abs,
          exists: true,
          type,
          size: stats.size,
          ...(mtimeValid ? { modifiedAt: stats.mtime.toISOString() } : {}),
        };
      },
    ),

    makeFsTool(
      "fs_read",
      `读取文本文件内容。文件超过 ${maxReadBytes} 字节会失败；二进制文件请用 fs_read_base64。`,
      readSchema,
      async (input, signal) => {
        signal?.throwIfAborted();
        const abs = await sandbox.resolveReadPath(input.path, "fs_read");
        signal?.throwIfAborted();
        const stats = await fsp.stat(abs);
        if (stats.size > maxReadBytes) {
          throw new FilesystemToolError(
            "fs_read",
            `文件 ${stats.size} 字节超过读取上限 ${maxReadBytes}`,
          );
        }
        const content = await fsp.readFile(abs, "utf8");
        signal?.throwIfAborted();
        return {
          path: abs,
          content,
          bytes: Buffer.byteLength(content, "utf8"),
        };
      },
    ),

    makeFsTool(
      "fs_read_base64",
      `读取二进制文件并返回 base64 编码。文件超过 ${maxReadBytes} 字节会失败。`,
      readSchema,
      async (input, signal) => {
        signal?.throwIfAborted();
        const abs = await sandbox.resolveReadPath(input.path, "fs_read_base64");
        signal?.throwIfAborted();
        const stats = await fsp.stat(abs);
        if (stats.size > maxReadBytes) {
          throw new FilesystemToolError(
            "fs_read_base64",
            `文件 ${stats.size} 字节超过读取上限 ${maxReadBytes}`,
          );
        }
        const buffer = await fsp.readFile(abs);
        signal?.throwIfAborted();
        return {
          path: abs,
          base64: buffer.toString("base64"),
          bytes: buffer.byteLength,
        };
      },
    ),

    makeFsTool(
      "fs_write",
      `写入或追加文本文件（默认覆盖新建）。单次最多 ${maxWriteBytes} 字节；` +
        "createParents=true 时自动创建父目录。会真实改动宿主机文件，务必确认目标路径。",
      writeSchema,
      async (input, signal) => {
        signal?.throwIfAborted();
        const abs = await sandbox.resolveWritePath(input.path, "fs_write");
        const mode = input.mode ?? "write";
        const bytes = Buffer.byteLength(input.content, "utf8");
        if (bytes > maxWriteBytes) {
          throw new FilesystemToolError(
            "fs_write",
            `写入内容 ${bytes} 字节超过单次上限 ${maxWriteBytes}`,
          );
        }
        if (input.createParents ?? false) {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
        }
        signal?.throwIfAborted();
        await fsp.writeFile(abs, input.content, {
          flag: mode === "append" ? "a" : "w",
        });
        return { path: abs, bytes, mode };
      },
    ),

    makeFsTool(
      "fs_delete",
      "删除单个文件或空目录；recursive=true 时递归删除目录。不可恢复，务必确认目标。",
      deleteSchema,
      async (input, signal) => {
        signal?.throwIfAborted();
        const abs = await sandbox.resolveWritePath(input.path, "fs_delete");
        const stats = await fsp.lstat(abs);
        signal?.throwIfAborted();
        const recursive = input.recursive ?? false;
        if (stats.isDirectory() && !recursive) {
          throw new FilesystemToolError(
            "fs_delete",
            `目录 ${abs} 需要使用 recursive=true 才能删除`,
          );
        }
        await fsp.rm(abs, { recursive, force: false });
        return { path: abs, deleted: true };
      },
    ),
  ];
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code: unknown }).code === "ENOENT";
}
