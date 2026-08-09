import type { HttpExecutor } from "./manifest-schema.js";

export interface HttpExecutorRuntimeOptions {
  fetchImpl?: typeof fetch;
  /** host 白名单（可含端口）。未配置时默认拒绝所有 http 插件。 */
  allowedHosts?: readonly string[];
  /** 允许通过 ${env:NAME} 引用的环境变量名白名单。未配置时默认拒绝所有引用。 */
  allowedEnvVars?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PLACEHOLDER_PATTERN =
  /\$\{([a-zA-Z_][a-zA-Z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 展开 URL / 请求头模板：`${param}` 取工具入参，`${env:NAME}` 取白名单内的环境变量。
 * 密钥只允许经环境变量注入，不允许直接写进 manifest。
 */
export function renderTemplate(
  template: string,
  input: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const rendered = template.replace(PLACEHOLDER_PATTERN, (match, rawName) => {
    if (rawName.startsWith("env:")) {
      const name = rawName.slice(4);
      const value = env[name];
      if (value === undefined) throw new Error(`环境变量 ${name} 未配置`);
      return value;
    }
    if (!(rawName in input)) {
      throw new Error(`模板参数 ${rawName} 未在入参中提供`);
    }
    const value = input[rawName];
    if (value === null || value === undefined) {
      throw new Error(`模板参数 ${rawName} 为空`);
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
  if (rendered.includes("${")) {
    throw new Error(`模板包含无法解析的占位符: ${template}`);
  }
  return rendered;
}

/**
 * 模板展开之后做 host 校验，防止 SSRF 绕过白名单。
 * 白名单为空时默认拒绝，避免「未配置 = 放行任意域名」的默认宽松。
 */
export function assertAllowedHost(
  url: URL,
  allowedHosts: readonly string[],
): void {
  if (allowedHosts.length === 0) {
    throw new Error("未配置 host 白名单，http 插件默认拒绝执行");
  }
  if (!allowedHosts.includes(url.host)) {
    throw new Error(`插件请求的 host ${url.host} 不在白名单中`);
  }
}

/**
 * 解析 url 模板的静态部分：协议必须是字面 https，authority（host[:port]）
 * 不允许模板占位符。path/query 允许 `${param}` / `${env:NAME}`。
 * 这样 host 可以在加载与草案阶段静态校验，模型无法动态指定 SSRF 目标。
 */
export function parseStaticUrl(url: string): {
  protocol: "https:";
  host: string;
  pathname: string;
} {
  if (!url.startsWith("https://")) {
    throw new Error("http 插件只允许 https 请求");
  }
  const rest = url.slice("https://".length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.length === 0) {
    throw new Error("http 插件 url 缺少 host");
  }
  if (authority.includes("${")) {
    throw new Error("http 插件 url 的 host 部分不允许模板占位符");
  }
  return {
    protocol: "https:",
    host: authority,
    pathname: authorityEnd === -1 ? "" : rest.slice(authorityEnd),
  };
}

/** 提取 manifest 中所有 `${env:NAME}` 引用（url 与 headers 值）。 */
export function extractEnvRefs(executor: HttpExecutor): string[] {
  const refs = new Set<string>();
  const values = [executor.url, ...Object.values(executor.headers ?? {})];
  for (const value of values) {
    for (const match of value.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      refs.add(match[1]!);
    }
  }
  return [...refs].sort();
}

/**
 * 构造期策略校验（加载与草案阶段都调用）：
 * - 协议必须 https；host 必须静态且命中白名单（未配置 = 默认拒绝）；
 * - 引用的环境变量名必须全部在白名单内（未配置 = 默认拒绝）。
 * 执行期还会做同样的运行时校验作为纵深防御。
 */
export function assertHttpExecutorPolicy(
  executor: HttpExecutor,
  options: HttpExecutorRuntimeOptions,
): void {
  const { host } = parseStaticUrl(executor.url);
  const allowedHosts = options.allowedHosts ?? [];
  if (allowedHosts.length === 0) {
    throw new Error("未配置 PAN_PILOT_PLUGIN_ALLOWED_HOSTS，http 插件默认拒绝");
  }
  if (!allowedHosts.includes(host)) {
    throw new Error(`插件请求的 host ${host} 不在白名单中`);
  }

  const allowedEnvVars = options.allowedEnvVars ?? [];
  for (const name of extractEnvRefs(executor)) {
    if (!allowedEnvVars.includes(name)) {
      throw new Error(`环境变量 ${name} 不在允许引用白名单中`);
    }
  }
}

/**
 * 构造只含白名单环境变量的受限 env 视图：不在白名单中的名字
 * 一律不注入，运行时即使被绕过也读不到任意 process.env。
 */
function resolveAllowedEnv(
  executor: HttpExecutor,
  allowedEnvVars: readonly string[] | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of extractEnvRefs(executor)) {
    if (allowedEnvVars?.includes(name)) {
      env[name] = process.env[name];
    }
  }
  return env;
}

/**
 * 执行声明式 http 工具：https 限制、host 白名单、超时、响应体大小上限、
 * JSON 解析与 responsePath 提取。错误以普通 Error 抛出，由注册表统一归一化。
 */
export async function executeHttpRequest(
  executor: HttpExecutor,
  input: Readonly<Record<string, unknown>>,
  options: HttpExecutorRuntimeOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const method = executor.method ?? "GET";
  const timeoutMs = executor.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let url: URL;
  try {
    url = new URL(
      renderTemplate(executor.url, input, resolveAllowedEnv(executor, options.allowedEnvVars)),
    );
  } catch (error) {
    throw new Error(`插件 url 渲染失败: ${messageOf(error)}`);
  }
  // https 与静态 host 在构造期由 assertHttpExecutorPolicy 强制；
  // 这里只保留对渲染后 host 的运行时复核（纵深防御）。
  assertAllowedHost(url, options.allowedHosts ?? []);

  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(executor.headers ?? {})) {
    headers[key] = renderTemplate(
      raw,
      input,
      resolveAllowedEnv(executor, options.allowedEnvVars),
    );
  }
  if (
    method === "POST"
    && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
  ) {
    headers["content-type"] = "application/json";
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      // 默认 follow 的重定向可能把白名单 host 带向任意地址/私网；
      // 显式禁止跟随，任何 3xx 都直接失败。
      redirect: "error",
      signal: abortSignal,
    });
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (isTimeoutError(error)) {
      throw new Error(`插件 HTTP 请求超时（${timeoutMs}ms）`);
    }
    throw new Error(`插件 HTTP 请求失败: ${messageOf(error)}`);
  }

  if (!response.ok) {
    throw new Error(`插件 HTTP 请求返回 ${response.status} ${response.statusText}`);
  }

  const text = await readResponseText(response, MAX_RESPONSE_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("插件响应不是有效 JSON");
  }

  return executor.responsePath === undefined
    ? json
    : getByPath(json, executor.responsePath);
}

/** 带大小上限读取响应体，避免插件返回超大 payload 撑爆内存。 */
async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`插件响应超过 ${maxBytes} 字节上限`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`插件响应超过 ${maxBytes} 字节上限`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 点路径提取：`a.b[0].c`，数字段用于数组下标。 */
function getByPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(/[.[\]]+/).filter((s) => s !== "")) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`responsePath ${path} 无法解析：${segment} 处不是对象`);
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        throw new Error(`responsePath ${path} 无法解析：数组下标 ${segment} 非法`);
      }
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined) {
      throw new Error(`responsePath ${path} 不存在`);
    }
  }
  return current;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === "TimeoutError" || error.name === "AbortError");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
