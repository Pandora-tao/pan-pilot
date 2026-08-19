import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { ToolExecutionContext } from "../../tools/tool.js";
import type { ResolvedPermissions, SandboxLimits } from "../types.js";
import { handleHostOp, type SandboxHostDeps } from "./host-bridge.js";

const require = createRequire(import.meta.url);

let modulePaths: { core: string; variant: string } | undefined;
function resolveModulePaths(): { core: string; variant: string } {
  modulePaths ??= {
    core: require.resolve("quickjs-emscripten-core"),
    variant: require.resolve("@jitl/quickjs-wasmfile-release-asyncify"),
  };
  return modulePaths;
}

let workerSourceCache: string | undefined;
function workerSource(): string {
  if (workerSourceCache !== undefined) return workerSourceCache;
  const { core, variant } = resolveModulePaths();
  const template = readFileSync(
    new URL("./worker-template.cjs", import.meta.url),
    "utf8",
  );
  workerSourceCache = template
    .replace(/__MODULE_QUICKJS_CORE__/g, core)
    .replace(/__MODULE_QUICKJS_VARIANT__/g, variant);
  return workerSourceCache;
}

export interface SandboxCallOptions {
  bundleSource: string;
  toolName: string;
  input: unknown;
  meta: { name: string; version: string };
  caps: ResolvedPermissions;
  limits: SandboxLimits;
  deps: SandboxHostDeps;
  ctx: ToolExecutionContext;
}

export interface SandboxCallResult {
  ok: boolean;
  value?: unknown;
  error?: { message: string };
}

interface OpReadyMessage {
  type: "op-ready";
}

/**
 * 每个调用在独立 Worker + 全新（同步）QuickJS runtime 中运行；宿主调用通过
 * 共享缓冲 + Atomics 同步阻塞桥完成。墙钟预算只计 Worker「纯计算」：宿主调用
 * （网络/权限等待）期间冻结预算，用户授权等待不会被 30s 上限误杀。宿主调用
 * 次数、输入/输出大小上限在主进程侧强制执行；超限 terminate Worker，不影响主进程。
 */
export function runSandboxCall(options: SandboxCallOptions): Promise<SandboxCallResult> {
  return new Promise<SandboxCallResult>((resolve) => {
    // 共享缓冲：请求/应答各 1MB 上限。
    const requestBuf = new SharedArrayBuffer(options.limits.maxIoBytes);
    const replyBuf = new SharedArrayBuffer(options.limits.maxIoBytes);
    const requestReady = new SharedArrayBuffer(4);
    const replyReady = new SharedArrayBuffer(4);

    const worker = new Worker(workerSource(), {
      eval: true,
      workerData: {
        bundleSource: options.bundleSource,
        toolName: options.toolName,
        inputJson: JSON.stringify(options.input ?? {}),
        limits: options.limits,
        meta: options.meta,
        buffers: { requestBuf, replyBuf, requestReady, replyReady },
      },
    });

    let settled = false;
    let hostCalls = 0;
    let computeBudgetMs = options.limits.wallLimitMs;
    let computeStart = Date.now();
    let wallTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: SandboxCallResult): void => {
      if (settled) return;
      settled = true;
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      void worker.terminate();
      resolve(result);
    };

    const armWallTimer = (): void => {
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      computeStart = Date.now();
      wallTimer = setTimeout(() => {
        settle({ ok: false, error: { message: "沙箱计算超预算（wall limit）" } });
      }, Math.max(1, computeBudgetMs));
      wallTimer.unref?.();
    };

    const readRequest = (): { op: string; payload: unknown } | undefined => {
      const text = Buffer.from(new Uint8Array(requestBuf)).toString("utf8")
        .replace(/\0+$/, "");
      try {
        const parsed = JSON.parse(text) as { op: string; payload: unknown };
        if (typeof parsed.op !== "string") return undefined;
        return { op: parsed.op, payload: parsed.payload };
      } catch {
        return undefined;
      }
    };

    const writeReply = (result: { ok: boolean; value?: unknown; error?: { message: string } }): boolean => {
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.byteLength > replyBuf.byteLength) return false;
      bytes.copy(new Uint8Array(replyBuf));
      Atomics.store(new Int32Array(replyReady), 0, 1);
      Atomics.notify(new Int32Array(replyReady), 0);
      return true;
    };

    armWallTimer();

    worker.on("message", async (message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === "result") {
        const result = message as {
          ok: boolean;
          payload?: { value?: unknown; error?: { message?: string } };
        };
        if (result.ok) settle({ ok: true, value: result.payload?.value });
        else settle({ ok: false, error: { message: result.payload?.error?.message ?? "sandbox failed" } });
        return;
      }
      if (msg.type !== "op-ready") return;
      const opMessage = message as OpReadyMessage;
      void opMessage;
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      // 计算阶段结束：冻结墙钟预算（宿主调用在途期间不消耗）。
      computeBudgetMs -= Math.max(0, Date.now() - computeStart);

      hostCalls += 1;
      if (hostCalls > options.limits.maxHostCalls) {
        writeReply({ ok: false, error: { message: `宿主调用次数超限（${options.limits.maxHostCalls}）` } });
        armWallTimer();
        return;
      }
      const request = readRequest();
      if (request === undefined) {
        writeReply({ ok: false, error: { message: "宿主调用请求无法解析" } });
        armWallTimer();
        return;
      }
      const payloadJson = JSON.stringify(request.payload ?? {});
      if (Buffer.byteLength(payloadJson, "utf8") > options.limits.maxIoBytes) {
        writeReply({ ok: false, error: { message: "宿主调用输入超过大小上限" } });
        armWallTimer();
        return;
      }
      try {
        const result = await handleHostOp(options.deps, options.ctx, request.op, request.payload);
        const resultJson = JSON.stringify(result);
        if (Buffer.byteLength(resultJson, "utf8") > options.limits.maxIoBytes) {
          writeReply({ ok: false, error: { message: "宿主调用结果超过大小上限" } });
        } else {
          writeReply({ ok: true, value: result });
        }
      } catch (error) {
        writeReply({
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        armWallTimer();
      }
    });

    worker.on("error", (error: Error) => {
      settle({ ok: false, error: { message: `沙箱 Worker 崩溃: ${error.message}` } });
    });
    if (options.ctx.signal !== undefined) {
      if (options.ctx.signal.aborted) {
        settle({ ok: false, error: { message: "cancelled" } });
      } else {
        options.ctx.signal.addEventListener("abort", () => {
          settle({ ok: false, error: { message: "cancelled" } });
        }, { once: true });
      }
    }
  });
}
