import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "./tool.js";

/**
 * 原生终端工具：在宿主机 shell 中执行一条命令，返回 stdout/stderr 与退出码。
 *
 * 安全与工程护栏：
 * - 环境净化：只继承 PATH/HOME/USER/SHELL/LANG/TZ/临时目录等基础变量，
 *   以及 PAN_PILOT_TERMINAL_ENV_ALLOWLIST 显式放行的变量；PanPilot 的
 *   API / 模型 / 通行证密钥绝不进入子进程环境；
 * - 命令执行前经 ctx.ask() 进入授权闭环：严格只读白名单自动放行，
 *   其余询问（不提供永久放行）；
 * - 超时与 AbortSignal 以进程组为单位终止（POSIX detached + kill(-pgid)），
 *   避免残留子进程；
 * - 输出超限保留尾部并标记 truncated，防止撑爆上下文。
 */

export interface TerminalToolOptions {
  /** 未指定 cwd 时默认使用的工作目录；默认 ./workspace。 */
  defaultCwd?: string;
  /** 单条命令默认超时（毫秒），默认 60 秒。 */
  defaultTimeoutMs?: number;
  /** 单条命令超时上限（毫秒），默认 10 分钟；模型给的 timeoutMs 会被钳制到该值。 */
  maxTimeoutMs?: number;
  /** 捕获 stdout+stderr 的最大总字节数，超出部分保留尾部截断，默认 512KB。 */
  maxOutputBytes?: number;
  /** 额外允许继承的环境变量名白名单（PAN_PILOT_TERMINAL_ENV_ALLOWLIST 解析值）。 */
  extraEnv?: readonly string[];
  /** 测试注入的环境视图（默认 process.env）。 */
  envSource?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_COMMAND_LENGTH = 16_384;
const KILL_GRACE_MS = 1500;

/** 终端工具边界的稳定错误类型。 */
export class TerminalToolError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "TerminalToolError";
  }
}

const terminalInputSchema = z.object({
  command: z.string().trim().min(1, "command 不能为空").max(MAX_COMMAND_LENGTH),
  /** 执行命令的工作目录；默认使用工具配置的 defaultCwd。 */
  cwd: z.string().trim().min(1).max(4096).optional(),
  /** 单条命令超时（毫秒），默认 60 秒，上限 10 分钟。 */
  timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional(),
}).strict();

export type TerminalInput = z.infer<typeof terminalInputSchema>;

export interface TerminalOutput {
  /** 进程退出码；被信号终止时返回 -1。 */
  exitCode: number;
  /** 是否因超时被强制终止。 */
  timedOut: boolean;
  /** 终止信号的名称（正常退出时为 null）。 */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** stdout/stderr 达到上限被截断（保留尾部）。 */
  truncated: boolean;
  /** 命令实际执行耗时（毫秒）。 */
  durationMs: number;
  /** 实际使用的工作目录。 */
  cwd: string;
  /** 授权被拒绝时置为 PERMISSION_DENIED，命令未执行。 */
  error?: "PERMISSION_DENIED";
  message?: string;
}

/** 终端基础环境白名单：始终继承（除非源环境缺失）。 */
const BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "USERNAME", "SHELL", "LANG", "LC_ALL", "TZ",
  "TMPDIR", "TEMP", "TMP",
] as const;

/** 已知的 PanPilot 密钥变量名集合（含厂商密钥前缀）。 */
const SECRET_KEY_PATTERNS = [/^DEEPSEEK_/i, /^VOLCENGINE_/i, /^PAN_PILOT_/i, /^MIMO_API_KEY/i, /^JAVA_SERVICE_URL/i];

/**
 * 构造净化后的子进程环境：基础变量 + 白名单变量；
 * 任何命中密钥模式的变量都不会被复制，即使被加入白名单也被忽略。
 */
export function sanitizeTerminalEnv(
  source: Readonly<Record<string, string | undefined>>,
  extraAllowlist: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const isSecret = (name: string): boolean =>
    SECRET_KEY_PATTERNS.some((pattern) => pattern.test(name));
  for (const key of BASE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && !isSecret(key)) result[key] = value;
  }
  for (const raw of extraAllowlist) {
    const name = raw.trim();
    if (name === "") continue;
    if (isSecret(name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

/** 滚动保留尾部的输出缓冲。 */
class OutputTail {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private limited = false;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.bytes > this.maxBytes) {
      this.limited = true;
      const first = this.chunks[0];
      if (first === undefined) break;
      if (this.chunks.length === 1) {
        // 单块超限：只保留其尾部。
        const tail = first.subarray(first.byteLength - this.maxBytes);
        this.chunks = [tail];
        this.bytes = tail.byteLength;
        break;
      }
      this.chunks.shift();
      this.bytes -= first.byteLength;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }

  get truncated(): boolean {
    return this.limited;
  }
}

/** 在宿主 shell 中执行命令并收集输出，直至退出、超时或被信号中止。 */
function runCommand(
  command: string,
  options: RunCommandOptions,
): Promise<TerminalOutput> {
  return new Promise<TerminalOutput>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== "win32",
      env: options.env,
    });
    const startedAt = Date.now();
    const stdout = new OutputTail(options.maxOutputBytes);
    const stderr = new OutputTail(options.maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 以进程组为单位终止子进程；POSIX kill(-pgid)。 */
    const terminate = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
            .unref();
        } catch {
          child.kill();
        }
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const grace = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* 进程组已退出 */
        }
      }, KILL_GRACE_MS);
      grace.unref?.();
    };

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (options.signal !== undefined) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const settle = (then: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      then();
    };

    const onAbort = (): void => {
      terminate();
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) terminate();
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // 超时：先 SIGTERM 进程组，宽限后仍不退则 SIGKILL。
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      settle(() => {
        reject(new TerminalToolError(
          "terminal",
          `命令启动失败: ${error.message}`,
        ));
      });
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (options.signal !== undefined && options.signal.aborted) {
          const reason = options.signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
          return;
        }
        resolve({
          exitCode: code ?? -1,
          timedOut,
          signal: signal ?? null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - startedAt,
          cwd: options.cwd,
        });
      });
    });
  });
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
}

/**
 * 创建原生终端工具。命令执行前经授权闭环（严格只读白名单自动放行，
 * 其余询问且不可永久放行）；环境经过净化。
 */
export function createTerminalTool(
  options: TerminalToolOptions = {},
): AgentTool<TerminalInput, TerminalOutput> {
  const defaultCwd = path.resolve(options.defaultCwd ?? "./workspace");
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const extraEnv = options.extraEnv ?? [];
  const envSource = options.envSource ?? process.env;
  assertPositiveInt(defaultTimeoutMs, "defaultTimeoutMs");
  assertPositiveInt(maxTimeoutMs, "maxTimeoutMs");
  assertPositiveInt(maxOutputBytes, "maxOutputBytes");
  if (maxTimeoutMs < defaultTimeoutMs) {
    throw new Error("maxTimeoutMs 不能小于 defaultTimeoutMs");
  }
  const terminalEnv = sanitizeTerminalEnv(envSource, extraEnv);

  return {
    name: "terminal",
    description:
      "在宿主 shell 中执行一条命令并返回 stdout/stderr 与退出码。命令以 shell 语义执行"
      + "（支持管道/重定向/环境变量），最长超时 10 分钟，输出超限自动截断。"
      + "只自动执行严格只读白名单中的简单命令；其余命令需要用户授权。",
    inputSchema: terminalInputSchema,
    async execute(input, ctx) {
      ctx.signal?.throwIfAborted();
      const cwd = path.resolve(input.cwd ?? defaultCwd);
      const timeoutMs = Math.min(
        Math.max(input.timeoutMs ?? defaultTimeoutMs, 100),
        maxTimeoutMs,
      );
      const outcome = await ctx.ask({
        toolName: "terminal",
        op: "command",
        target: input.command,
        summary: `在宿主 shell 中执行命令：${input.command}`,
        permanentlyAllowable: false,
      });
      if (outcome === "denied") {
        return {
          exitCode: -1,
          timedOut: false,
          signal: null,
          stdout: "",
          stderr: "",
          truncated: false,
          durationMs: 0,
          cwd,
          error: "PERMISSION_DENIED" as const,
          message: "用户拒绝了该命令的执行",
        };
      }
      return runCommand(input.command, {
        cwd,
        timeoutMs,
        maxOutputBytes,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        env: terminalEnv,
      });
    },
  };
}

export const terminalTool = createTerminalTool();
