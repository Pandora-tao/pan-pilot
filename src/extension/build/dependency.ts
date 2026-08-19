import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { sanitizeTerminalEnv } from "../../tools/terminal.js";
import {
  dependencyLockSchema,
  type DependencyLock,
  type LockEntry,
  type PluginManifestV2,
} from "../types.js";
import { ExtensionError } from "../validate.js";

export const MAX_DIRECT_DEPS = 20;
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * 依赖安装与锁定：
 * - 只允许 https npm registry 与精确版本（schema 已拒绝范围/Git/URL/file）；
 * - pnpm `--ignore-scripts` 安装、净化环境、明确超时；
 * - 通过 `pnpm list` 枚举直接+传递依赖，再从 registry 逐项取 integrity/license 写入
 *   dependencies/lock.json；任何一项取不到 integrity 都算失败（不得降级）。
 */

export interface DependencyOptions {
  registry: string;
  pnpmBin?: string;
  /** 测试注入的 registry 元数据获取器（避免真实网络）。 */
  fetchMetadata?: (registry: string, name: string, version: string) => Promise<Metadata | undefined>;
}

export interface Metadata {
  license?: string;
  integrity: string;
}

export async function runDependencyResolve(
  manifest: PluginManifestV2,
  cacheDir: string,
  options: DependencyOptions,
): Promise<DependencyLock> {
  const direct = Object.entries(manifest.dependencies ?? {});
  if (direct.length > MAX_DIRECT_DEPS) {
    throw new ExtensionError(
      "INVALID_PACKAGE",
      `直接依赖超过上限 ${MAX_DIRECT_DEPS}`,
    );
  }
  const registry = normalizeRegistry(options.registry);
  if (!registry.startsWith("https://")) {
    throw new ExtensionError("INVALID_PACKAGE", "依赖 registry 必须是 HTTPS");
  }
  if (direct.length === 0) {
    return {
      format: "pan-pilot.dependencies/v1",
      registry,
      direct: [],
      transitive: [],
    };
  }

  // 1) 生成最小 package.json 并以 pnpm --ignore-scripts 安装。
  await writeMinimalPackageJson(cacheDir, manifest);
  await runPnpmInstall(cacheDir, registry, options.pnpmBin);

  // 2) 解析直接+传递依赖树（精确版本）。
  const resolved = await resolveTree(cacheDir, options.pnpmBin, manifest);

  // 3) 逐项到 registry 取 integrity/license。
  const fetchMetadata = options.fetchMetadata ?? fetchRegistryMetadata;
  const resolvedEntries: LockEntry[] = [];
  const directNames = new Set(direct.map(([name]) => name));
  const failures: string[] = [];
  for (const item of resolved) {
    const metadata = await fetchMetadata(registry, item.name, item.version);
    if (metadata === undefined || metadata.integrity === "") {
      failures.push(`${item.name}@${item.version} 缺少 registry integrity`);
      continue;
    }
    resolvedEntries.push({
      name: item.name,
      version: item.version,
      integrity: metadata.integrity,
      ...(metadata.license === undefined ? {} : { license: metadata.license }),
    });
  }
  if (failures.length > 0) {
    throw new ExtensionError(
      "INVALID_PACKAGE",
      `依赖完整性校验失败: ${failures.join("; ")}`,
    );
  }

  return {
    format: "pan-pilot.dependencies/v1",
    registry,
    direct: resolvedEntries.filter((entry) => directNames.has(entry.name)),
    transitive: resolvedEntries.filter((entry) => !directNames.has(entry.name)),
  };
}

function normalizeRegistry(value: string): string {
  return value.replace(/\/+$/, "");
}

interface ResolvedItem {
  name: string;
  version: string;
}

/** 写最小 package.json（无 scripts，精确依赖）。 */
async function writeMinimalPackageJson(
  cacheDir: string,
  manifest: PluginManifestV2,
): Promise<void> {
  const pkg = {
    name: `pan-pilot-plugin-${manifest.name}`,
    version: "0.0.0",
    private: true,
    dependencies: manifest.dependencies ?? {},
  };
  const lock = {
    lockfileVersion: 9,
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  };
  void lock;
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(
    path.join(cacheDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf8",
  );
}

/** pnpm --ignore-scripts 安装（净化环境 + 超时）。 */
export async function runPnpmInstall(
  cacheDir: string,
  registry: string,
  pnpmBin?: string,
): Promise<void> {
  const env = sanitizeTerminalEnv(process.env, ["NODE_ENV"]);
  env.npm_config_registry = registry;
  env.npm_config_ignore_scripts = "true";
  const bin = pnpmBin ?? "pnpm";
  const args = [
    "--dir", cacheDir,
    "install",
    "--ignore-scripts",
    "--no-optional",
    "--registry", registry,
  ];
  await new Promise<void>((resolve, reject) => {
    execFile(bin, args, { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error) => {
      if (error) {
        console.error(`插件依赖安装失败 (${bin}): ${messageOf(error)}`);
        reject(new ExtensionError("INVALID_PACKAGE", `依赖安装失败: ${messageOf(error)}`));
        return;
      }
      resolve();
    });
  });
}

/** 用 pnpm list 枚举解析树；失败时回退为直接依赖视图。 */
async function resolveTree(
  cacheDir: string,
  pnpmBin: string | undefined,
  manifest: PluginManifestV2,
): Promise<ResolvedItem[]> {
  try {
    const raw = await execFileJson(
      [pnpmBin ?? "pnpm", "list", "--depth", "Infinity", "--json", "--dir", cacheDir],
    );
    const roots = Array.isArray(raw) ? raw : [];
    const out = new Map<string, ResolvedItem>();
    const walk = (node: { name?: string; version?: string; dependencies?: unknown }) => {
      if (typeof node.name === "string" && typeof node.version === "string") {
        const key = `${node.name}@${node.version}`;
        out.set(key, { name: node.name, version: node.version });
      }
      const deps = node.dependencies;
      if (Array.isArray(deps)) {
        for (const dep of deps) walk(dep as { name?: string; version?: string; dependencies?: unknown });
      }
    };
    for (const root of roots) walk(root as { name?: string; version?: string; dependencies?: unknown });
    if (out.size === 0) {
      // 回退：直接依赖视图（版本来自 manifest）。
      for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        out.set(`${name}@${version}`, { name, version });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => ({ name, version }));
  }
}

function execFileJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(args[0]!, args.slice(1), {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

export async function fetchRegistryMetadata(
  registry: string,
  name: string,
  version: string,
): Promise<Metadata | undefined> {
  const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { license?: string; dist?: { integrity?: string } };
    const integrity = data.dist?.integrity ?? "";
    if (integrity === "") return undefined;
    return { integrity, ...(typeof data.license === "string" ? { license: data.license } : {}) };
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseDependencyLock(raw: unknown): DependencyLock {
  return dependencyLockSchema.parse(raw);
}
