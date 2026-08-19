import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import type {
  AgentTool,
  AnyAgentTool,
  ToolExecutionContext,
  ToolPermissionAsk,
} from "./tool.js";
import { generateUnifiedDiff } from "./diff.js";
import {
  HostPathError,
  isInside,
  realpathOfExistingAncestor,
} from "./fspath.js";
import {
  appendText,
  atomicWriteText,
  looksBinary,
  readTextWithProfile,
  withPathLock,
  type TextFileProfile,
} from "./fs-ops.js";
import { findMatchingLines, findMatchingPaths } from "./fs-search.js";

/**
 * 内建 fs_* 核心工具：让 Agent 操作宿主机文件。
 *
 * 安全模型（HostRuntime 核心能力，不可被插件启停/重载移除）：
 * - 相对路径统一基于 hostCwd（PAN_PILOT_HOST_CWD，默认进程启动目录）；
 * - 绝对路径允许访问整台主机，受服务账号的 OS 权限限制；
 * - 配置了 PAN_PILOT_FS_ROOTS（管理员级限制）时保留「语法包含 + realpath
 *   最深已存在祖先」双重校验，拦截符号链接逃逸；
 * - 写入/编辑/补丁/删除在动盘前经 ctx.ask() 进入授权闭环并展示 diff 预览；
 *   敏感路径（realpath 判定）上的任何操作都询问、不永久放行；
 * - 写入、编辑、补丁保留 BOM、换行风格与权限，使用路径锁 + 变更前内容校验 +
 *   临时文件原子替换避免并发覆盖。
 */

export interface FilesystemToolOptions {
  /** 相对路径解析基准（PAN_PILOT_HOST_CWD 解析值）。 */
  hostCwd: string;
  /** 管理员级限制根目录（PAN_PILOT_FS_ROOTS 解析值）；空数组=整机可访问。 */
  adminRoots?: readonly string[];
  /** fs_read_base64 等二进制读取的单次上限，默认 1MB。 */
  maxReadBase64Bytes?: number;
  /** fs_read 单页文本上限（字节），默认 50KB。 */
  maxTextReadBytes?: number;
  /** 单次写入内容上限，默认 4MB。 */
  maxWriteBytes?: number;
  /** fs_list 条目上限，默认 1000。 */
  maxListEntries?: number;
  /** fs_glob / fs_grep 搜索结果上限，默认 100。 */
  maxSearchResults?: number;
  /** 递归搜索时不进入 / 不返回的敏感路径过滤器（来自 PermissionService）。 */
  skipSensitive?: (absPath: string) => boolean | Promise<boolean>;
}

const DEFAULT_MAX_READ_BASE64_BYTES = 1024 * 1024;
const DEFAULT_MAX_TEXT_READ_BYTES = 50 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 1000;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_READ_LINES = 2000;
const MAX_PATH_LENGTH = 4096;

/** 文件系统工具边界的稳定错误类型。 */
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
const readSchema = z.object({
  path: pathInput,
  /** 从第几行开始读取（0 起）。 */
  offset: z.number().int().min(0).optional(),
  /** 最多读取多少行；未指定时使用默认上限（2000 行或 50KB）。 */
  limit: z.number().int().min(1).max(100_000).optional(),
}).strict();
const base64ReadSchema = z.object({ path: pathInput }).strict();
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
const editSchema = z.object({
  path: pathInput,
  oldText: z.string().min(1, "oldText 不能为空").max(100_000),
  newText: z.string().max(100_000),
  /** 为 true 时替换所有匹配；默认要求 oldText 恰好出现一次。 */
  replaceAll: z.boolean().default(false),
}).strict();

const patchOperandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    path: pathInput,
    content: z.string().max(100_000),
    createParents: z.boolean().default(false),
  }).strict(),
  z.object({
    op: z.literal("modify"),
    path: pathInput,
    oldText: z.string().min(1, "oldText 不能为空").max(100_000),
    newText: z.string().max(100_000),
    replaceAll: z.boolean().default(false),
  }).strict(),
  z.object({
    op: z.literal("move"),
    from: pathInput,
    to: pathInput,
    overwrite: z.boolean().default(false),
  }).strict(),
  z.object({
    op: z.literal("delete"),
    path: pathInput,
    recursive: z.boolean().default(false),
  }).strict(),
]);
const applyPatchSchema = z.object({
  patch: z.object({
    operations: z.array(patchOperandSchema).min(1).max(50),
  }).strict(),
}).strict();

const globSchema = z.object({
  pattern: z.string().trim().min(1, "pattern 不能为空").max(2000),
  path: pathInput.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict();

const grepSchema = z.object({
  pattern: z.string().trim().min(1, "pattern 不能为空").max(500)
    .refine((value) => tryCompileRegex(value) !== undefined, "pattern 不是合法正则"),
  path: pathInput.optional(),
  include: z.string().trim().min(1).max(2000).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict();

function tryCompileRegex(value: string): RegExp | undefined {
  try {
    return new RegExp(value);
  } catch {
    return undefined;
  }
}

/**
 * 路径解析器：相对路径基于 hostCwd；绝对路径放行整机；
 * 配置 adminRoots 时做读写两侧的包含校验（语法 + realpath 最深已存在祖先）。
 */
function createPathResolver(options: FilesystemToolOptions) {
  const hostCwd = options.hostCwd;
  const normalizedAdminRoots = [...new Set(
    (options.adminRoots ?? [])
      .map((root) => root.trim())
      .filter((root) => root.length > 0)
      .map((root) => path.resolve(root)),
  )];
  let realRootsPromise: Promise<readonly string[]> | undefined;
  const realRoots = (): Promise<readonly string[]> => {
    realRootsPromise ??= Promise.all(normalizedAdminRoots.map((root) =>
      fsp.realpath(root).catch(() => root)));
    return realRootsPromise;
  };

  async function assertAdminAllowed(abs: string, operation: string): Promise<void> {
    if (normalizedAdminRoots.length === 0) return;
    // 语法层：规范化路径必须落在某个根内。
    const insideSyntax = normalizedAdminRoots.some((root) => isInside(root, abs));
    if (!insideSyntax) {
      throw new FilesystemToolError(
        operation,
        `路径 ${abs} 超出允许访问的根目录范围`,
      );
    }
    // 真实层：最深已存在祖先的 realpath 必须落在某个根的真实路径内，
    // 拦截「经由符号链接逃逸到根目录外」（包括对尚不存在部分的写入）。
    let realAncestor: string;
    try {
      realAncestor = await realpathOfExistingAncestor(abs);
    } catch {
      throw new FilesystemToolError(
        operation,
        `路径 ${abs} 的父目录不存在或不可访问`,
      );
    }
    const rootsReal = await realRoots();
    if (!rootsReal.some((root) => isInside(root, realAncestor))) {
      throw new FilesystemToolError(
        operation,
        `路径 ${abs} 超出允许访问的根目录范围`,
      );
    }
  }

  return {
    hostCwd,
    adminRoots: normalizedAdminRoots,
    resolveForRead: async (raw: string, operation: string): Promise<string> => {
      const abs = resolveHostPathRaw(raw, hostCwd, operation);
      await assertAdminAllowed(abs, operation);
      return abs;
    },
    resolveForWrite: async (raw: string, operation: string): Promise<string> => {
      const abs = resolveHostPathRaw(raw, hostCwd, operation);
      await assertAdminAllowed(abs, operation);
      return abs;
    },
  };
}

function resolveHostPathRaw(raw: string, hostCwd: string, operation: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new HostPathError(operation, "路径不能为空");
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new HostPathError(operation, "路径过长");
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(hostCwd, trimmed);
}

/** 权限被拒绝时的结构化工具结果（反馈模型，不是抛错）。 */
function permissionDeniedResult(): { error: "PERMISSION_DENIED"; message: string } {
  return {
    error: "PERMISSION_DENIED",
    message: "用户拒绝了该操作；如需继续请重新发起并获得授权",
  };
}

/** fs_read 的分页读取：按行限制 + 字节上限，二进制拒绝。 */
async function readTextPage(
  absPath: string,
  offsetLines: number,
  limitLines: number,
  maxBytes: number,
  operation: string,
  signal?: AbortSignal,
): Promise<{
  content: string;
  lines: readonly string[];
  bytes: number;
  hasMore: boolean;
  nextOffset?: number;
}> {
  signal?.throwIfAborted();
  const probe = await fsp.open(absPath, "r");
  try {
    const first = Buffer.alloc(8192);
    const { bytesRead } = await probe.read(first, 0, 8192, 0);
    if (first.subarray(0, bytesRead).includes(0)) {
      throw new FilesystemToolError(
        operation,
        "文件为二进制内容，请使用 fs_read_base64 读取",
      );
    }
  } finally {
    await probe.close();
  }
  signal?.throwIfAborted();

  const lines: string[] = [];
  let totalBytes = 0;
  let hasMore = false;
  let consumed = 0;
  const rl = readline.createInterface({
    input: createReadStream(absPath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (consumed < offsetLines) {
        consumed += 1;
        continue;
      }
      if (lines.length >= limitLines) {
        hasMore = true;
        break;
      }
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (totalBytes + lineBytes > maxBytes) {
        hasMore = true;
        break;
      }
      lines.push(line);
      totalBytes += lineBytes;
      consumed += 1;
    }
  } finally {
    rl.close();
  }
  signal?.throwIfAborted();

  const content = lines.join("\n");
  const nextOffset = hasMore ? offsetLines + lines.length : undefined;
  return {
    content,
    lines,
    bytes: Buffer.byteLength(content, "utf8"),
    hasMore,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  };
}

/**
 * 创建一套内建文件系统工具
 * （fs_list/fs_info/fs_read/fs_read_base64/fs_write/fs_delete/fs_edit/
 *  fs_apply_patch/fs_glob/fs_grep）。
 */
export function createFilesystemTools(
  options: FilesystemToolOptions,
): AnyAgentTool[] {
  const maxReadBase64Bytes = options.maxReadBase64Bytes
    ?? DEFAULT_MAX_READ_BASE64_BYTES;
  const maxTextReadBytes = options.maxTextReadBytes ?? DEFAULT_MAX_TEXT_READ_BYTES;
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;
  const maxSearchResults = options.maxSearchResults ?? DEFAULT_MAX_SEARCH_RESULTS;
  const resolver = createPathResolver(options);
  const skipSensitive = options.skipSensitive ?? (() => false);

  return [
    makeFsTool(
      "fs_list",
      `列出目录下的子项（名称与类型），最多返回 ${maxListEntries} 项。path 可以是绝对路径或相对路径（相对 PAN_PILOT_HOST_CWD）。`,
      listSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForRead(input.path, "fs_list");
        ctx.signal?.throwIfAborted();
        const dirEntries = await fsp.readdir(abs, { withFileTypes: true });
        ctx.signal?.throwIfAborted();
        const truncated = dirEntries.length > maxListEntries;
        const entries = dirEntries.slice(0, maxListEntries).map((entry) => ({
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
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForRead(input.path, "fs_info");
        ctx.signal?.throwIfAborted();
        let stats;
        try {
          stats = await fsp.stat(abs);
        } catch (error) {
          if (isMissing(error)) return { path: abs, exists: false };
          throw error;
        }
        ctx.signal?.throwIfAborted();
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
      "读取文本文件的内容。默认最多返回 2000 行或 50KB（二进制内容请用 fs_read_base64）；" +
        "可用 offset/limit 按行分页，hasMore 表示后面还有内容。读取敏感路径前会请求授权。",
      readSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForRead(input.path, "fs_read");
        const offset = input.offset ?? 0;
        const limit = input.limit ?? DEFAULT_MAX_READ_LINES;
        const outcome = await ctx.ask({
          toolName: "fs_read",
          op: "read",
          target: abs,
          summary: `读取文件 ${abs}`,
          permanentlyAllowable: false,
        });
        if (outcome === "denied") return permissionDeniedResult();
        const page = await readTextPage(
          abs,
          offset,
          limit,
          maxTextReadBytes,
          "fs_read",
          ctx.signal,
        );
        return { path: abs, ...page };
      },
    ),

    makeFsTool(
      "fs_read_base64",
      `读取二进制文件并返回 base64 编码，单次最多 ${maxReadBase64Bytes} 字节。读取敏感路径前会请求授权。`,
      base64ReadSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForRead(input.path, "fs_read_base64");
        const outcome = await ctx.ask({
          toolName: "fs_read_base64",
          op: "read",
          target: abs,
          summary: `读取二进制文件 ${abs}`,
          permanentlyAllowable: false,
        });
        if (outcome === "denied") return permissionDeniedResult();
        ctx.signal?.throwIfAborted();
        const stats = await fsp.stat(abs);
        if (stats.size > maxReadBase64Bytes) {
          throw new FilesystemToolError(
            "fs_read_base64",
            `文件 ${stats.size} 字节超过读取上限 ${maxReadBase64Bytes}`,
          );
        }
        const buffer = await fsp.readFile(abs);
        ctx.signal?.throwIfAborted();
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
        "createParents=true 时自动创建父目录。会真实改动宿主机文件，" +
        "写入前需要用户授权并展示统一 diff。",
      writeSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForWrite(input.path, "fs_write");
        const mode = input.mode ?? "write";
        const bytes = Buffer.byteLength(input.content, "utf8");
        if (bytes > maxWriteBytes) {
          throw new FilesystemToolError(
            "fs_write",
            `写入内容 ${bytes} 字节超过单次上限 ${maxWriteBytes}`,
          );
        }
        const existing = mode === "write"
          ? await readTextWithProfile(abs)
          : undefined;
        ctx.signal?.throwIfAborted();
        const oldContent = existing?.content ?? "";
        const diff = mode === "write"
          ? generateUnifiedDiff(displayPath(abs, resolver.hostCwd), oldContent, input.content)
          : undefined;
        const outcome = await ctx.ask({
          toolName: "fs_write",
          op: "write",
          target: abs,
          summary: mode === "append"
            ? `追加写入文件 ${abs}`
            : oldContent === ""
              ? `新建文件 ${abs}`
              : `覆盖文件 ${abs}`,
          ...(diff === undefined ? {} : { diff }),
          permanentlyAllowable: true,
        });
        if (outcome === "denied") return permissionDeniedResult();
        if (input.createParents ?? false) {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
        }
        ctx.signal?.throwIfAborted();
        await withPathLock(abs, async () => {
          if (mode === "append") {
            await appendText(abs, input.content);
          } else {
            await atomicWriteText(abs, input.content, {
              ...(existing?.profile === undefined
                ? {} : { profile: existing.profile }),
            });
          }
        });
        return { path: abs, bytes, mode };
      },
    ),

    makeFsTool(
      "fs_edit",
      "精确编辑文本文件：oldText 必须出现一次（replaceAll=true 时替换全部出现）。" +
        "保留 BOM、换行与权限；写入前需要授权并展示 diff。",
      editSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForWrite(input.path, "fs_edit");
        const read = await readTextWithProfile(abs);
        if (read === undefined) {
          throw new FilesystemToolError("fs_edit", `文件不存在: ${abs}`);
        }
        if (looksBinary(read.buffer ?? Buffer.alloc(0))) {
          throw new FilesystemToolError(
            "fs_edit",
            "文件为二进制内容，无法用 fs_edit 编辑；请用 fs_write 覆盖",
          );
        }
        const occurrences = countOccurrences(read.content, input.oldText);
        const replaceAll = input.replaceAll ?? false;
        if (!replaceAll && occurrences !== 1) {
          throw new FilesystemToolError(
            "fs_edit",
            `oldText 在文件中出现 ${occurrences} 次${occurrences > 1 ? "（可用 replaceAll=true 替换全部）" : ""}`,
          );
        }
        const newContent = replaceAll
          ? read.content.split(input.oldText).join(input.newText)
          : replaceOnce(read.content, input.oldText, input.newText);
        const diff = generateUnifiedDiff(
          displayPath(abs, resolver.hostCwd),
          read.content,
          newContent,
        );
        const outcome = await ctx.ask({
          toolName: "fs_edit",
          op: "edit",
          target: abs,
          summary: `编辑文件 ${abs}`,
          diff,
          permanentlyAllowable: true,
        });
        if (outcome === "denied") return permissionDeniedResult();
        const replaced = await withPathLock(abs, async () => {
          await atomicWriteText(abs, newContent, {
            profile: read.profile,
            expectedExisting: { content: read.content, profile: read.profile },
          });
          return replaceAll ? countOccurrences(read.content, input.oldText) : 1;
        });
        return {
          path: abs,
          replaced,
          bytes: Buffer.byteLength(newContent, "utf8"),
        };
      },
    ),

    makeFsTool(
      "fs_apply_patch",
      "应用结构化多操作补丁：add（新增）/ modify（编辑）/ move（移动）/ delete（删除）。" +
        "先校验全部操作再执行，执行前需要授权并展示统一 diff。",
      applyPatchSchema,
      applyPatchHandler(resolver),
    ),

    makeFsTool(
      "fs_delete",
      "删除单个文件或空目录；recursive=true 时递归删除目录。不可恢复，" +
        "删除操作每次都要求用户授权（不提供永久放行）。",
      deleteSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const abs = await resolver.resolveForWrite(input.path, "fs_delete");
        const outcome = await ctx.ask({
          toolName: "fs_delete",
          op: "delete",
          target: abs,
          summary: `删除 ${abs}`,
          permanentlyAllowable: false,
        });
        if (outcome === "denied") return permissionDeniedResult();
        const stats = await fsp.lstat(abs);
        ctx.signal?.throwIfAborted();
        const recursive = input.recursive ?? false;
        if (stats.isDirectory() && !recursive) {
          throw new FilesystemToolError(
            "fs_delete",
            `目录 ${abs} 需要使用 recursive=true 才能删除`,
          );
        }
        await withPathLock(abs, async () => {
          await fsp.rm(abs, { recursive, force: false });
        });
        return { path: abs, deleted: true };
      },
    ),

    makeFsTool(
      "fs_glob",
      `递归搜索匹配 glob 的文件路径（支持 * / ** / ? / {a,b} / [abc]）。` +
        `最多返回 ${maxSearchResults} 项，超出会标记 truncated。搜索会跳过敏感路径。`,
      globSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const baseRaw = input.path ?? ".";
        const base = await resolver.resolveForRead(baseRaw, "fs_glob");
        const limit = input.limit ?? maxSearchResults;
        const outcome = await ctx.ask({
          toolName: "fs_glob",
          op: "read",
          target: base,
          summary: `glob 搜索 ${input.pattern}（起始目录 ${base}）`,
          permanentlyAllowable: false,
        });
        if (outcome === "denied") return permissionDeniedResult();
        const result = await findMatchingPaths(base, input.pattern, {
          limit,
          shouldSkip: skipSensitive,
        });
        return {
          pattern: input.pattern,
          base,
          matches: result.items.map((item) => item.path),
          ...(result.truncated ? { truncated: true } : {}),
          filesChecked: result.filesChecked,
        };
      },
    ),

    makeFsTool(
      "fs_grep",
      `递归在文本文件中搜索匹配的行（pattern 为正则表达式）。` +
        `最多返回 ${maxSearchResults} 项并标记截断；include 用 glob 过滤文件名。搜索会跳过敏感路径与二进制文件。`,
      grepSchema,
      async (input, ctx) => {
        ctx.signal?.throwIfAborted();
        const baseRaw = input.path ?? ".";
        const base = await resolver.resolveForRead(baseRaw, "fs_grep");
        const limit = input.limit ?? maxSearchResults;
        const outcome = await ctx.ask({
          toolName: "fs_grep",
          op: "read",
          target: base,
          summary: `grep 搜索 /${input.pattern}/（起始目录 ${base}）`,
          permanentlyAllowable: false,
        });
        if (outcome === "denied") return permissionDeniedResult();
        const regex = tryCompileRegex(input.pattern);
        if (regex === undefined) {
          throw new FilesystemToolError("fs_grep", "pattern 不是合法正则");
        }
        const result = await findMatchingLines(base, regex, {
          limit,
          ...(input.include === undefined ? {} : { include: input.include }),
          shouldSkip: skipSensitive,
        });
        return {
          pattern: input.pattern,
          base,
          matches: result.items,
          ...(result.truncated ? { truncated: true } : {}),
          filesChecked: result.filesChecked,
        };
      },
    ),
  ];
}

type PatchOperand = z.infer<typeof patchOperandSchema>;
type PathResolver = ReturnType<typeof createPathResolver>;

interface PatchPlan {
  kind: PatchOperand["op"];
  operand: PatchOperand;
  /** 该操作的主路径（展示与结果）。 */
  primaryPath: string;
  /** modify 的旧内容（diff 与并发校验用）。 */
  oldContent?: string;
  expectedContent?: string;
  profile?: TextFileProfile;
  nextContent?: string;
  moveTo?: string;
}

/** fs_apply_patch 的实现：先全量校验，再授权，最后逐项原子应用。 */
function applyPatchHandler(
  resolver: PathResolver,
): (
  input: z.infer<typeof applyPatchSchema>,
  ctx: ToolExecutionContext,
) => Promise<unknown> {
  return async (input, ctx) => {
    ctx.signal?.throwIfAborted();
    const ops = input.patch.operations;
    const first = ops[0];
    if (first === undefined) {
      throw new FilesystemToolError("fs_apply_patch", "补丁没有操作");
    }
    const firstTarget = await resolver.resolveForWrite(
      first.op === "move" ? first.from : first.path,
      "fs_apply_patch",
    );
    const baseDir = path.dirname(firstTarget);

    // 1. 解析全部目标路径 + 只读校验（不落盘）。
    const plans: PatchPlan[] = [];
    for (const op of ops) {
      ctx.signal?.throwIfAborted();
      if (op.op === "add") {
        const abs = await resolver.resolveForWrite(op.path, "fs_apply_patch");
        assertNotExists(abs, op);
        plans.push({ kind: "add", operand: op, primaryPath: abs, nextContent: op.content });
        continue;
      }
      if (op.op === "modify") {
        const abs = await resolver.resolveForWrite(op.path, "fs_apply_patch");
        const read = await readTextWithProfile(abs);
        if (read === undefined) {
          throw new FilesystemToolError("fs_apply_patch", `modify 目标不存在: ${abs}`);
        }
        if (looksBinary(read.buffer ?? Buffer.alloc(0))) {
          throw new FilesystemToolError("fs_apply_patch", `modify 目标是二进制: ${abs}`);
        }
        const occurrences = countOccurrences(read.content, op.oldText);
        const replaceAll = op.replaceAll ?? false;
        if (!replaceAll && occurrences !== 1) {
          throw new FilesystemToolError(
            "fs_apply_patch",
            `modify ${abs} 的 oldText 出现 ${occurrences} 次${occurrences > 1 ? "（可用 replaceAll=true）" : ""}`,
          );
        }
        const nextContent = replaceAll
          ? read.content.split(op.oldText).join(op.newText)
          : replaceOnce(read.content, op.oldText, op.newText);
        plans.push({
          kind: "modify",
          operand: op,
          primaryPath: abs,
          oldContent: read.content,
          expectedContent: read.content,
          profile: read.profile,
          nextContent,
        });
        continue;
      }
      if (op.op === "move") {
        const from = await resolver.resolveForWrite(op.from, "fs_apply_patch");
        const to = await resolver.resolveForWrite(op.to, "fs_apply_patch");
        try {
          await fsp.stat(from);
        } catch {
          throw new FilesystemToolError("fs_apply_patch", `move 源不存在: ${from}`);
        }
        let toExists = false;
        try {
          await fsp.stat(to);
          toExists = true;
        } catch {
          // 不存在符合预期。
        }
        if (toExists && !(op.overwrite ?? false)) {
          throw new FilesystemToolError("fs_apply_patch", `move 目标已存在: ${to}`);
        }
        plans.push({ kind: "move", operand: op, primaryPath: from, moveTo: to });
        continue;
      }
      // delete
      const abs = await resolver.resolveForWrite(op.path, "fs_apply_patch");
      try {
        const stats = await fsp.lstat(abs);
        if (stats.isDirectory() && !(op.recursive ?? false)) {
          throw new FilesystemToolError(
            "fs_apply_patch",
            `delete 目录 ${abs} 需要使用 recursive=true`,
          );
        }
      } catch (error) {
        if (error instanceof FilesystemToolError) throw error;
        throw new FilesystemToolError("fs_apply_patch", `delete 目标不存在: ${abs}`);
      }
      plans.push({ kind: "delete", operand: op, primaryPath: abs });
    }

    // 2. 生成统一 diff 预览并请求授权。
    const blocks: string[] = [];
    for (const plan of plans) {
      if (plan.kind === "add") {
        blocks.push(generateUnifiedDiff(
          displayPath(plan.primaryPath, resolver.hostCwd), "", plan.nextContent ?? "",
        ));
      } else if (plan.kind === "modify") {
        blocks.push(generateUnifiedDiff(
          displayPath(plan.primaryPath, resolver.hostCwd),
          plan.oldContent ?? "",
          plan.nextContent ?? "",
        ));
      } else if (plan.kind === "move") {
        blocks.push(`--- a/${displayPath(plan.primaryPath, resolver.hostCwd)}` +
          `\n+++ b/${displayPath(plan.moveTo!, resolver.hostCwd)}\n（移动文件）`);
      } else {
        blocks.push(`删除 ${displayPath(plan.primaryPath, resolver.hostCwd)}`);
      }
    }
    const outcome = await ctx.ask({
      toolName: "fs_apply_patch",
      op: "patch",
      target: baseDir,
      summary: `应用包含 ${ops.length} 个操作的补丁（起始目录 ${baseDir}）`,
      diff: blocks.join("\n\n"),
      permanentlyAllowable: true,
    });
    if (outcome === "denied") return permissionDeniedResult();

    // 3. 逐个原子应用（每个文件独立加锁）。
    const results: Array<{ op: string; path: string; status: "ok" }> = [];
    for (const plan of plans) {
      ctx.signal?.throwIfAborted();
      await withPathLock(plan.primaryPath, async () => {
        if (plan.kind === "add") {
          await atomicWriteText(plan.primaryPath, plan.nextContent ?? "", {});
        } else if (plan.kind === "modify") {
          await atomicWriteText(plan.primaryPath, plan.nextContent ?? "", {
            ...(plan.profile === undefined ? {} : { profile: plan.profile }),
            expectedExisting: {
              content: plan.expectedContent ?? "",
              profile: plan.profile ?? emptyProfile(),
            },
          });
        } else if (plan.kind === "move") {
          await moveFile(plan.primaryPath, plan.moveTo!, (plan.operand as { overwrite?: boolean }).overwrite ?? false);
        } else {
          await fsp.rm(plan.primaryPath, {
            recursive: (plan.operand as { recursive?: boolean }).recursive ?? false,
            force: false,
          });
        }
      });
      results.push({ op: plan.kind, path: plan.primaryPath, status: "ok" });
    }
    return { patch: { operations: results }, base: baseDir };
  };
}

async function assertNotExists(
  abs: string,
  op: { op: string; path: string },
): Promise<void> {
  void op;
  try {
    await fsp.stat(abs);
    throw new FilesystemToolError("fs_apply_patch", `新增目标已存在: ${abs}`);
  } catch (error) {
    if (error instanceof FilesystemToolError) throw error;
    // ENOENT 符合预期。
  }
}

function emptyProfile(): TextFileProfile {
  return { hadBom: false, lineEnding: "none" };
}

/** 展示用相对标签：优先相对 hostCwd，否则用绝对路径。 */
function displayPath(abs: string, hostCwd: string): string {
  const rel = path.relative(hostCwd, abs);
  return rel === "" || rel.startsWith("..") ? abs : rel;
}

function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = content.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function replaceOnce(content: string, needle: string, replacement: string): string {
  const index = content.indexOf(needle);
  if (index === -1) return content;
  return content.slice(0, index)
    + replacement
    + content.slice(index + needle.length);
}

async function moveFile(from: string, to: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    try {
      await fsp.access(to);
      throw new FilesystemToolError("fs_apply_patch", `move 目标已存在: ${to}`);
    } catch (error) {
      if (error instanceof FilesystemToolError) throw error;
      // 不存在，继续。
    }
  }
  try {
    await fsp.rename(from, to);
  } catch {
    // 跨设备移动：复制后删除。
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
    const stats = await fsp.lstat(from);
    await fsp.rm(from, { recursive: stats.isDirectory(), force: true });
  }
}

function makeFsTool<T>(
  name: string,
  description: string,
  inputSchema: z.ZodType<T>,
  handler: (input: T, ctx: ToolExecutionContext) => Promise<unknown>,
): AgentTool<T, unknown> {
  return { name, inputSchema, description, execute: handler };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code: unknown }).code === "ENOENT";
}
