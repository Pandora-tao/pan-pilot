import path from "node:path";
import { randomUUID } from "node:crypto";
import { matchesGlob } from "../../utils/glob.js";
import type { HostFilesystemService } from "../../tools/host-filesystem.js";
import type { HostTerminalService } from "../../tools/host-terminal.js";
import type { ToolExecutionContext } from "../../tools/tool.js";
import type {
  ResolvedPermissions,
  SandboxLimits,
} from "../types.js";

/**
 * 宿主桥：沙箱 SDK 调用的主进程侧校验与执行。
 * 沙箱不可信：host/路径/命令/方法/重定向/大小/超时/凭据注入全部在这里强制，
 * 文件与终端操作复用 Host 服务与既有权责闭环（同一个 ctx.ask）。
 */

export interface SandboxHostDeps {
  defaultCwd: string;
  limits: SandboxLimits;
  caps: ResolvedPermissions;
  meta: { name: string; version: string };
  fsService: HostFilesystemService;
  terminalService: HostTerminalService;
  storage: {
    read(name: string): Promise<Record<string, string>>;
    write(name: string, entries: Record<string, string>): Promise<void>;
  };
  /** 凭据槽名 -> 密钥；插件代码拿不到明文。 */
  credentials: ReadonlyMap<string, string>;
  fetchImpl?: typeof fetch;
}

export type HostOpResult = unknown;

export class SandboxDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxDeniedError";
  }
}

function deny(message: string): never {
  throw new SandboxDeniedError(message);
}

function resolveFsTarget(deps: SandboxHostDeps, payload: { path?: unknown }): string {
  const raw = typeof payload?.path === "string" ? payload.path : "";
  if (raw === "" || !isPlainPath(raw)) deny("沙箱 fs 路径不合法");
  const abs = path.resolve(deps.defaultCwd, raw);
  if (deps.caps.files.length === 0) deny("该包未声明文件访问权限");
  const matched = deps.caps.files.some((pattern) =>
    matchesGlob(pattern, abs) || matchesGlob(pattern, `${abs}/`));
  if (!matched) deny(`路径超出包裹文件权限: ${abs}`);
  return abs;
}

function isPlainPath(value: string): boolean {
  return !value.includes("\0") && !value.includes("\\");
}

/** 执行一次 fs SDK 调用（复用 HostFilesystemService 与 ask）。 */
async function executeFsOp(
  deps: SandboxHostDeps,
  ctx: ToolExecutionContext,
  op: string,
  payload: Record<string, unknown>,
): Promise<HostOpResult> {
  switch (op) {
    case "fs.list":
      return deps.fsService.list({ path: resolveFsTarget(deps, payload) }, ctx);
    case "fs.info":
      return deps.fsService.info({ path: resolveFsTarget(deps, payload) }, ctx);
    case "fs.read":
      return deps.fsService.read({
        path: resolveFsTarget(deps, payload),
        ...(typeof payload.offset === "number" ? { offset: payload.offset } : {}),
        ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
      }, ctx);
    case "fs.readBase64":
      return deps.fsService.readBase64({ path: resolveFsTarget(deps, payload) }, ctx);
    case "fs.write":
      return deps.fsService.write({
        path: resolveFsTarget(deps, payload),
        content: String(payload.content ?? ""),
        ...(payload.mode === "append" ? { mode: "append" } : {}),
        ...(payload.createParents === true ? { createParents: true } : {}),
      }, ctx);
    case "fs.edit":
      return deps.fsService.edit({
        path: resolveFsTarget(deps, payload),
        oldText: String(payload.oldText ?? ""),
        newText: String(payload.newText ?? ""),
        ...(payload.replaceAll === true ? { replaceAll: true } : {}),
      }, ctx);
    case "fs.applyPatch":
      return deps.fsService.applyPatch({
        patch: { operations: Array.isArray(payload.operations) ? payload.operations : [] },
      }, ctx);
    case "fs.delete":
      return deps.fsService.delete({
        path: resolveFsTarget(deps, payload),
        ...(payload.recursive === true ? { recursive: true } : {}),
      }, ctx);
    case "fs.glob":
      return deps.fsService.glob({
        pattern: String(payload.pattern ?? ""),
        ...(typeof payload.path === "string" ? { path: payload.path } : {}),
        ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
      }, ctx);
    case "fs.grep":
      return deps.fsService.grep({
        pattern: String(payload.pattern ?? ""),
        ...(typeof payload.path === "string" ? { path: payload.path } : {}),
        ...(typeof payload.include === "string" ? { include: payload.include } : {}),
        ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
      }, ctx);
    default:
      deny(`不支持的 fs 操作: ${op}`);
  }
}

function executeTerminal(
  deps: SandboxHostDeps,
  ctx: ToolExecutionContext,
  payload: Record<string, unknown>,
): Promise<HostOpResult> {
  const command = String(payload.command ?? "");
  if (command.trim() === "") deny("终端命令为空");
  if (deps.caps.commands.length === 0) deny("该包未声明终端执行权限");
  const allowed = deps.caps.commands.some((pattern) => command.trim().startsWith(pattern));
  if (!allowed) deny("终端命令不在包裹允许范围内");
  return deps.terminalService.run({
    command,
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
  }, ctx);
}

export interface SandboxHttpSpec {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  credential?: string;
}

/** 校验并发出 http 请求：https、host/方法在允许列表、重定向逐跳校验、大小/超时上限。 */
async function executeHttp(
  deps: SandboxHostDeps,
  spec: SandboxHttpSpec,
): Promise<HostOpResult> {
  const method = String(spec.method ?? "GET").toUpperCase();
  const urlText = String(spec.url ?? "");
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    deny("http url 不合法");
  }
  if (url.protocol !== "https:") deny("只允许 https");
  const hostEntry = deps.caps.hosts.find((entry) =>
    entry.host === `${url.hostname}${url.port ? `:${url.port}` : ""}`
    || entry.host === url.hostname);
  if (hostEntry === undefined) deny(`host 不在包裹允许列表: ${url.hostname}`);
  if (!hostEntry.methods.includes(method as never)) deny(`方法不允许: ${method}`);

  const headers: Record<string, string> = {};
  if (spec.headers && typeof spec.headers === "object") {
    for (const [key, value] of Object.entries(spec.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  if (spec.credential !== undefined && spec.credential !== "") {
    if (!deps.caps.credentials.includes(spec.credential)) deny(`凭据槽未声明: ${spec.credential}`);
    const secret = deps.credentials.get(spec.credential);
    if (secret === undefined || secret === "") deny(`凭据槽未配置: ${spec.credential}`);
    headers.Authorization = `Bearer ${secret}`;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.limits.maxIoBytes;
  const timeoutMs = 15_000;
  let currentUrl: URL = url;
  const seen = new Set<string>();
  const redirectLimit = 5;
  let currentMethod = method;
  let body = spec.body;

  for (let hop = 0; hop <= redirectLimit; hop += 1) {
    if (seen.has(currentUrl.href)) deny("检测到重定向环");
    seen.add(currentUrl.href);
    if (currentUrl.protocol !== "https:") deny("重定向目标必须是 https");
    const hopEntry = deps.caps.hosts.find((entry) =>
      entry.host === `${currentUrl.hostname}${currentUrl.port ? `:${currentUrl.port}` : ""}`
      || entry.host === currentUrl.hostname);
    if (hopEntry === undefined) deny(`重定向目标不在允许列表: ${currentUrl.hostname}`);
    // 重定向跳转只允许 GET/HEAD。
    if (hop > 0 && !["GET", "HEAD"].includes(currentMethod)) deny("重定向后只能使用 GET/HEAD");

    const response = await fetchImpl(currentUrl.href, {
      method: currentMethod,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(["GET", "HEAD"].includes(currentMethod) || body === undefined || body === ""
        ? {} : { body: body as BodyInit }),
    }).catch((error: unknown) => {
      deny(`http 请求失败: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        return { status: response.status, headers: headerObject(response.headers), body: "" };
      }
      currentUrl = new URL(location, currentUrl);
      headers.Host = currentUrl.host;
      currentMethod = "GET";
      body = undefined;
      // 释放本次响应体。
      try {
        await response.arrayBuffer();
      } catch {
        // 忽略
      }
      continue;
    }

    const buffer = await readBounded(response, maxBytes);
    let text = "";
    if (buffer !== null) text = buffer.toString("utf8");
    return {
      status: response.status,
      headers: headerObject(response.headers),
      body: text,
      truncated: buffer === null,
    };
  }
  deny("重定向次数超限");
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function headerObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function executeStorage(
  deps: SandboxHostDeps,
  op: string,
  payload: Record<string, unknown>,
): Promise<HostOpResult> {
  if (!deps.caps.storage) deny("该包未声明持久存储权限");
  const name = deps.meta.name;
  const store = await deps.storage.read(name);
  switch (op) {
    case "storage.get": {
      const key = String(payload.key ?? "");
      return store[key] === undefined ? { ok: true, value: null } : { ok: true, value: store[key] };
    }
    case "storage.set": {
      const key = String(payload.key ?? "");
      const value = String(payload.value ?? "");
      const budget = totalBytes(store);
      if (budget + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") > 1024 * 1024) {
        deny("存储配额超限（1MB）");
      }
      const next = { ...store, [key]: value };
      await deps.storage.write(name, next);
      return { ok: true };
    }
    case "storage.del": {
      const key = String(payload.key ?? "");
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(store)) if (k !== key) next[k] = v;
      await deps.storage.write(name, next);
      return { ok: true };
    }
    case "storage.list":
      return { keys: Object.keys(store) };
    default:
      deny(`不支持的存储操作: ${op}`);
  }
}

function totalBytes(store: Record<string, string>): number {
  let total = 0;
  for (const [k, v] of Object.entries(store)) {
    total += Buffer.byteLength(k, "utf8") + Buffer.byteLength(v, "utf8");
  }
  return total;
}

function executeClock(op: string): HostOpResult {
  if (op === "clock.uuid") {
    return { id: randomUUID() };
  }
  return { iso: new Date().toISOString() };
}

/** 主进程侧宿主调用入口：校验 + 分派（被 worker-runner 调用）。 */
export async function handleHostOp(
  deps: SandboxHostDeps,
  ctx: ToolExecutionContext,
  op: string,
  payload: unknown,
): Promise<HostOpResult> {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (op.startsWith("fs.")) {
    return executeFsOp(deps, ctx, op, record);
  }
  if (op === "terminal.run") {
    return executeTerminal(deps, ctx, record);
  }
  if (op === "http.request") {
    return executeHttp(deps, record as SandboxHttpSpec);
  }
  if (op.startsWith("storage.")) {
    return executeStorage(deps, op, record);
  }
  if (op === "clock.now") return executeClock("clock.now");
  if (op === "clock.uuid") return executeClock("clock.uuid");
  deny(`不支持的宿主操作: ${op}`);
}
