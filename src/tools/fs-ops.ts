import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 文件写入原语：格式（BOM / 换行 / 权限）保留 + 原子替换 + 防止并发覆盖。
 *
 * - 写前读取目标文件形态（BOM、换行风格、mode），写回时保持一致；
 * - 同目录临时文件 + rename 原子替换，避免读到半成品；
 * - 编辑 / 补丁基于快照推导，写入前用「期望旧内容」校验磁盘现状，
 *   拦截并发修改导致的内容错位；
 * - 进程内按绝对路径互斥，串行化同一文件的写入。
 */

export interface TextFileProfile {
  hadBom: boolean;
  lineEnding: "\r\n" | "\n" | "\r" | "mixed" | "none";
  mode?: number;
}

export interface ReadTextResult {
  content: string;
  buffer?: Buffer;
  profile: TextFileProfile;
}

export class FsOpsError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "FsOpsError";
  }
}

/** 判断字节是否含 NUL（常见二进制信号）。 */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

/** 读取文本文件并探测格式。文件不存在时返回 undefined。 */
export async function readTextWithProfile(
  absPath: string,
): Promise<ReadTextResult | undefined> {
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(absPath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const hadBom = buffer.length >= 3
    && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let content = buffer.toString("utf8");
  if (hadBom) content = content.replace(/^\uFEFF/, "");
  const lineEnding = detectLineEnding(content);
  let mode: number | undefined;
  try {
    const stats = await fsp.stat(absPath);
    mode = stats.mode & 0o777;
  } catch {
    // 忽略权限读取失败，仅尽力保留。
  }
  return {
    content,
    buffer,
    profile: {
      hadBom,
      lineEnding,
      ...(mode === undefined ? {} : { mode }),
    },
  };
}

/** 把「规范化正文」按目标格式序列化（BOM + 换行还原）。 */
export function serializeWithProfile(
  normalizedContent: string,
  profile: TextFileProfile,
): Buffer {
  let text = normalizedContent;
  if (profile.lineEnding !== "none") {
    const desired = profile.lineEnding === "mixed" ? "\n" : profile.lineEnding;
    text = splitAnyLines(text).join(desired);
  }
  if (profile.hadBom) text = `\uFEFF${text}`;
  return Buffer.from(text, "utf8");
}

/**
 * 原子写入：同目录临时文件 + rename 替换 + （尽力）还原权限。
 *
 * expectedExisting 非空时，写前校验磁盘现状与期望内容一致，
 * 不一致即并发修改，中止写入。
 */
export async function atomicWriteText(
  absPath: string,
  normalizedContent: string,
  options: {
    profile?: TextFileProfile;
    expectedExisting?: { content: string; profile: TextFileProfile };
  } = {},
): Promise<void> {
  const dir = path.dirname(absPath);
  const profile = options.profile;

  if (options.expectedExisting !== undefined) {
    const current = await readTextWithProfile(absPath);
    if (current === undefined) {
      throw new FsOpsError("write", `目标文件在写入前已被删除: ${absPath}`);
    }
    if (current.content !== options.expectedExisting.content) {
      throw new FsOpsError(
        "write",
        `文件 ${absPath} 在读取后被其他进程修改，已中止写入（避免覆盖并发变更）`,
      );
    }
  }

  const targetMode = profile?.mode;
  const buffer = profile === undefined
    ? Buffer.from(normalizedContent, "utf8")
    : serializeWithProfile(normalizedContent, profile);

  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(absPath)}.panpilot-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, buffer, { flag: "wx" });
    if (targetMode !== undefined && targetMode > 0) {
      await fsp.chmod(temp, targetMode).catch(() => {});
    }
    await fsp.rename(temp, absPath);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

/** 追加写入：用于 fs_write 的 append 模式。 */
export async function appendText(absPath: string, content: string): Promise<void> {
  await fsp.writeFile(absPath, content, { flag: "a" });
}

/**
 * 进程内路径互斥锁：同一绝对路径的写入串行化，
 * 避免同一文件并发覆盖/读到半成品。
 */
const locks = new Map<string, Promise<void>>();

export async function withPathLock<T>(
  absPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = path.normalize(absPath);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, currentTail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === currentTail) locks.delete(key);
  }
}

export type LineEnding = "\r\n" | "\n" | "\r" | "mixed" | "none";

function detectLineEnding(content: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let crOnly = 0;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "\r") {
      if (content[i + 1] === "\n") {
        crlf += 1;
        i += 2;
      } else {
        crOnly += 1;
        i += 1;
      }
    } else if (ch === "\n") {
      lf += 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  const total = crlf + lf + crOnly;
  if (total === 0) return "none";
  if (crlf === total) return "\r\n";
  if (lf === total) return "\n";
  if (crOnly === total) return "\r";
  return "mixed";
}

function splitAnyLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code: unknown }).code === "ENOENT";
}
