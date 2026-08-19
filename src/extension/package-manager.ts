import path from "node:path";
import { z } from "zod";
import type { AnyAgentTool, ToolExecutionContext } from "../tools/tool.js";
import { createHostFilesystemService } from "../tools/host-filesystem.js";
import { createHostTerminalService } from "../tools/host-terminal.js";
import { generateUnifiedDiff } from "../tools/diff.js";
import {
  DEFAULT_SANDBOX_LIMITS,
  emptyPermissions,
  mergePermissions,
  type CandidateRecord,
  type DraftRecord,
  type HostPermission,
  type InstalledRecord,
  type PluginManifestV2,
  type PluginToolDeclaration,
  type ResolvedPermissions,
  type SandboxLimits,
  type TestReport,
} from "./types.js";
import { RuntimeStore } from "./runtime-store.js";
import {
  buildIntegrity,
  readJsonFile,
  verifyIntegrity,
  writeJsonFile,
} from "./integrity.js";
import {
  assertSafeDraftPath,
  compareSemver,
  ExtensionError,
  parseManifest,
} from "./validate.js";
import { buildBundle } from "./build/builder.js";
import { runDependencyResolve } from "./build/dependency.js";
import { typecheckDraft } from "./build/typecheck.js";
import {
  handleHostOp,
  type SandboxHostDeps,
} from "./sandbox/host-bridge.js";
import { runSandboxCall } from "./sandbox/worker-runner.js";

export interface ExtensionOptions {
  store: RuntimeStore;
  hostCwd: string;
  adminRoots?: readonly string[];
  limits?: SandboxLimits;
  /** npm registry（默认 https://registry.npmjs.org）。 */
  registry?: string;
  pnpmBin?: string;
  /** 凭据槽名 -> 密钥。 */
  credentials?: ReadonlyMap<string, string>;
  /** 安装/卸载/停用/回滚后通知刷新 ToolRegistry。 */
  onRegistryChanged?: () => void | Promise<void>;
  /** 沙箱 SDK 依赖注入（测试替身）。 */
  hostDeps?: Partial<SandboxHostDeps>;
}

export interface CandidateSummary {
  id: string;
  name: string;
  version: string;
  digest: string;
  createdAt: string;
  expiresAt: string;
  manifest: PluginManifestV2;
  sourceFiles: Array<{ path: string; content: string; diff?: string }>;
  dependencies: unknown;
  testReport: TestReport | undefined;
  riskSummary: string[];
  bundleBytes: number;
}

const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_FILES = 200;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;

export class SandboxPackageManager {
  private readonly store: RuntimeStore;
  private readonly hostCwd: string;
  private readonly adminRoots: readonly string[];
  private readonly limits: SandboxLimits;
  private readonly registry: string;
  private readonly pnpmBin: string | undefined;
  private readonly credentials: ReadonlyMap<string, string>;
  private readonly onRegistryChanged: (() => void | Promise<void>) | undefined;
  private readonly hostDeps: Partial<SandboxHostDeps> | undefined;

  constructor(private readonly options: ExtensionOptions) {
    this.store = options.store;
    this.hostCwd = options.hostCwd;
    this.adminRoots = options.adminRoots ?? [];
    this.limits = options.limits ?? DEFAULT_SANDBOX_LIMITS;
    this.registry = options.registry ?? "https://registry.npmjs.org";
    this.pnpmBin = options.pnpmBin;
    this.credentials = options.credentials ?? new Map();
    this.onRegistryChanged = options.onRegistryChanged;
    this.hostDeps = options.hostDeps;
  }

  // ---------------------------------------------------------------- 草稿 ----

  async createDraft(
    manifestRaw: unknown,
    files: Array<{ path: string; content: string }>,
  ): Promise<DraftRecord> {
    const manifest = parseManifest(manifestRaw);
    const id = this.store.newDraftId();
    const now = new Date().toISOString();
    const record: DraftRecord = {
      id,
      state: "editing",
      name: manifest.name,
      version: manifest.version,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createDraft(record);
    await this.writeDraftJson(record, manifest);
    await this.applyDraftWrites(id, files);
    return this.touchDraft(record);
  }

  async updateDraft(
    draftId: string,
    manifestRaw: unknown,
    files: Array<{ path: string; content: string }>,
  ): Promise<DraftRecord> {
    const record = await this.requireDraft(draftId);
    if (record.state === "frozen") {
      throw new ExtensionError("FORBIDDEN", "已冻结的草稿不可再修改（可重新创建）");
    }
    if (manifestRaw !== undefined) {
      const manifest = parseManifest(manifestRaw);
      await this.writeDraftJson({ ...record, name: manifest.name, version: manifest.version }, manifest);
    }
    await this.applyDraftWrites(draftId, files);
    record.state = "editing";
    record.updatedAt = new Date().toISOString();
    return this.touchDraft(record);
  }

  private async applyDraftWrites(
    draftId: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    for (const file of files) {
      if (typeof file.path !== "string" || typeof file.content !== "string") {
        throw new ExtensionError("INVALID_PACKAGE", "文件写入必须包含 path 与 content");
      }
      assertSafeDraftPath(file.path);
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > MAX_SINGLE_FILE_BYTES) {
        throw new ExtensionError("FILE_TOO_LARGE", `文件过大: ${file.path}`);
      }
      await this.store.writeDraftFileRaw(draftId, file.path, file.content);
    }
  }

  private async writeDraftJson(record: DraftRecord, manifest: PluginManifestV2): Promise<void> {
    await this.store.writeDraftFileRaw(record.id, "plugin.json", `${JSON.stringify(manifest, null, 2)}\n`);
    record.name = manifest.name;
    record.version = manifest.version;
  }

  private async requireDraft(id: string): Promise<DraftRecord> {
    const record = await this.store.readDraft(id);
    if (record === undefined) throw new ExtensionError("NOT_FOUND", "草稿不存在");
    return record;
  }

  private async touchDraft(record: DraftRecord): Promise<DraftRecord> {
    record.updatedAt = new Date().toISOString();
    await this.store.writeDraftRecord(record);
    return structuredClone(record);
  }

  /** 校验草稿：typecheck → 依赖安装 → 构建 → 沙箱测试，写 report 与 bundle。 */
  async validateDraft(draftId: string): Promise<{ ok: boolean; report: TestReport }> {
    const record = await this.requireDraft(draftId);
    const manifestRaw = await this.store.readDraftFile(draftId, "plugin.json");
    if (manifestRaw === undefined) {
      throw new ExtensionError("INVALID_PACKAGE", "草稿缺少 plugin.json");
    }
    const manifest = parseManifest(JSON.parse(manifestRaw));

    const sourceRoot = this.store.draftRoot(draftId);
    const typecheck = typecheckDraft(path.join(sourceRoot, "source"));
    let build: { ok: boolean; outputBytes?: number; error?: string } = { ok: false };

    if (typecheck.ok) {
      try {
        const lock = await runDependencyResolve(manifest, this.store.cacheDir(draftId), {
          registry: this.registry,
          ...(this.pnpmBin === undefined ? {} : { pnpmBin: this.pnpmBin }),
        });
        await writeJsonFile(
          path.join(sourceRoot, "dependencies", "lock.json"),
          lock,
        );
        const entry = await findSourceEntry(path.join(sourceRoot, "source"));
        if (entry === undefined) {
          throw new ExtensionError("INVALID_PACKAGE", "source/ 缺少 index.ts 或 index.js 入口");
        }
        const output = await buildBundle({
          entry,
          sourceDir: path.join(sourceRoot, "source"),
          declaredDeps: new Set(Object.keys(manifest.dependencies ?? {})),
          nodeModulesDir: this.store.cacheDir(draftId),
          outfile: path.join(sourceRoot, "bundle", "plugin.js"),
        });
        build = { ok: true, outputBytes: output.outputBytes };
      } catch (error) {
        build = { ok: false, error: error instanceof Error ? error.message : String(error) };
        if (error instanceof ExtensionError) {
          // 记录诊断并保持草稿未提交。
        }
      }
    }

    let tests: TestReport["tests"] = [];
    if (typecheck.ok && build.ok && manifest.tests !== undefined) {
      const testSource = await this.store.readDraftFile(draftId, manifest.tests.entry);
      if (testSource !== undefined) {
        try {
          const result = await runSandboxCall({
            bundleSource: testSource,
            toolName: "__test__",
            input: null,
            meta: { name: manifest.name, version: manifest.version },
            caps: emptyPermissions(),
            limits: this.limits,
            deps: this.buildHostDeps(manifest, emptyPermissions()),
            ctx: quietCtx(),
          });
          if (result.ok && Array.isArray(result.value)) {
            tests = (result.value as Array<{ name: string; ok: boolean; error?: string }>).map((item) => ({
              name: String(item.name ?? ""),
              ok: item.ok === true,
              ...(typeof item.error === "string" ? { error: item.error.slice(0, 2000) } : {}),
              durationMs: 0,
            }));
          } else {
            tests = [{ name: "sandbox", ok: false, error: result.error?.message ?? "测试运行失败", durationMs: 0 }];
          }
        } catch (error) {
          tests = [{ name: "sandbox", ok: false, error: String(error instanceof Error ? error.message : error), durationMs: 0 }];
        }
      }
    }

    const report: TestReport = {
      format: "pan-pilot.tests/v1",
      typecheck: { ok: typecheck.ok, ...(typecheck.ok ? {} : { diagnostics: typecheck.diagnostics }) },
      build,
      tests: tests.length > 0 ? tests : undefined,
    };
    await writeJsonFile(path.join(sourceRoot, "tests", "report.json"), report);
    record.state = typecheck.ok && build.ok ? "validated" : "editing";
    await this.store.writeDraftRecord(record);
    return { ok: typecheck.ok && build.ok, report };
  }

  /** 提交候选：校验通过 → 冻结 → 拷贝候选 + integrity。 */
  async submitCandidate(draftId: string): Promise<CandidateRecord> {
    const record = await this.requireDraft(draftId);
    const manifestRaw = await this.store.readDraftFile(draftId, "plugin.json");
    if (manifestRaw === undefined) {
      throw new ExtensionError("INVALID_PACKAGE", "草稿缺少 plugin.json");
    }
    const manifest = parseManifest(JSON.parse(manifestRaw));
    const report = (await readJsonFile<TestReport>(
      path.join(this.store.draftRoot(draftId), "tests", "report.json"),
    ));
    if (record.state !== "validated" || report?.typecheck.ok !== true || report.build.ok !== true) {
      throw new ExtensionError("INVALID_PACKAGE", "草稿尚未通过校验，不能提交");
    }

    const id = this.store.newDraftId();
    const now = new Date();
    const candidate: CandidateRecord = {
      id,
      draftId,
      name: manifest.name,
      version: manifest.version,
      digest: "",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + CANDIDATE_TTL_MS).toISOString(),
    };
    const integrity = await buildIntegrity(this.store.draftRoot(draftId), manifest as unknown as Record<string, unknown>);
    candidate.digest = integrity.digest;
    await this.store.createCandidate(candidate, this.store.draftRoot(draftId));
    await writeJsonFile(
      path.join(this.store.candidateRoot(id), "integrity.json"),
      integrity,
    );
    record.state = "frozen";
    await this.store.writeDraftRecord(record);
    return structuredClone(candidate);
  }

  // ---------------------------------------------------------------- 候选 ----

  listCandidates(): Promise<CandidateRecord[]> {
    return this.store.listCandidates();
  }

  async getCandidate(id: string): Promise<CandidateSummary | undefined> {
    const record = await this.store.readCandidate(id);
    if (record === undefined) return undefined;
    if (new Date(record.expiresAt).getTime() <= Date.now()) return undefined;
    const root = this.store.candidateRoot(id);
    const manifest = await readJsonFile<PluginManifestV2>(path.join(root, "plugin.json"));
    if (manifest === undefined) return undefined;

    // 上一可用版本的源码（用于相对 diff）。
    const installed = await this.store.readInstalled(manifest.name);
    const previousVersion = installed?.previousVersion ?? installed?.activeVersion;

    const sourceFiles: CandidateSummary["sourceFiles"] = [];
    for (const entry of await readSourceFilesUnder(root, "source")) {
      let diff: string | undefined;
      if (previousVersion !== undefined) {
        const previousSource = await this.store.readInstalledPackageFile(
          manifest.name, previousVersion, `source/${entry.path}`,
        );
        if (previousSource !== undefined) {
          diff = generateUnifiedDiff(`source/${entry.path}`, previousSource, entry.content);
        }
      }
      sourceFiles.push({
        path: entry.path,
        content: entry.content,
        ...(diff === undefined || diff === "" ? {} : { diff }),
      });
    }

    const dependencies = await readJsonFile<unknown>(path.join(root, "dependencies", "lock.json"));
    const testReport = await readJsonFile<TestReport>(path.join(root, "tests", "report.json"));
    const bundleBytes = (await readMaybeFile(path.join(root, "bundle", "plugin.js")))?.length ?? 0;

    return {
      id: record.id,
      name: manifest.name,
      version: manifest.version,
      digest: record.digest,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      manifest,
      sourceFiles,
      dependencies,
      testReport,
      riskSummary: summarizeRisks(manifest),
      bundleBytes,
    };
  }

  async discardCandidate(id: string): Promise<void> {
    await this.store.deleteCandidate(id);
  }

  // ---------------------------------------------------------------- 安装 ----

  async installCandidate(id: string, submittedDigest: string): Promise<InstalledRecord> {
    const candidate = await this.store.readCandidate(id);
    if (candidate === undefined) throw new ExtensionError("CANDIDATE_NOT_FOUND", "候选不存在");
    if (new Date(candidate.expiresAt).getTime() <= Date.now()) {
      throw new ExtensionError("CANDIDATE_EXPIRED", "候选已过期，请重新提交审核");
    }
    const root = this.store.candidateRoot(id);
    const integrity = await readJsonFile<Awaited<ReturnType<typeof buildIntegrity>>>(path.join(root, "integrity.json"));
    if (integrity === undefined) throw new ExtensionError("DIGEST_MISMATCH", "候选缺少完整性清单");
    if (submittedDigest !== integrity.digest) {
      throw new ExtensionError("DIGEST_MISMATCH", "提交摘要与候选不一致，需要重新审核");
    }
    const verified = await verifyIntegrity(root, integrity);
    if (!verified.ok) {
      throw new ExtensionError("DIGEST_MISMATCH", verified.errors.join("; "));
    }
    const manifest = await readJsonFile<PluginManifestV2>(path.join(root, "plugin.json"));
    if (manifest === undefined) throw new ExtensionError("INVALID_PACKAGE", "候选缺少 plugin.json");
    // 凭据槽必须在服务端已配置。
    const creds = (manifest.tools.flatMap((t) => t.permissions?.credentials ?? []));
    for (const slot of new Set(creds)) {
      if ((this.credentials.get(slot) ?? "") === "") {
        throw new ExtensionError("INVALID_PACKAGE", `凭据槽未配置: ${slot}`);
      }
    }

    const bundleSource = await readMaybeFile(path.join(root, "bundle", "plugin.js"));
    if (bundleSource === undefined) throw new ExtensionError("INVALID_PACKAGE", "候选缺少 bundle");

    // 安装烟测：沙箱启动 + bundle 装载 + 工具发现 + schema 可编译。
    const discovered = await runSandboxCall({
      bundleSource,
      toolName: "__discover__",
      input: null,
      meta: { name: manifest.name, version: manifest.version },
      caps: emptyPermissions(),
      limits: this.limits,
      deps: this.buildHostDeps(manifest, emptyPermissions()),
      ctx: quietCtx(),
    });
    if (!discovered.ok || !Array.isArray(discovered.value)) {
      throw new ExtensionError("INVALID_PACKAGE", `安装烟测失败: ${discovered.error?.message ?? "未知错误"}`);
    }
    const discoveredNames = new Set(
      (discovered.value as Array<{ name?: string }>).map((t) => t.name).filter((n): n is string => typeof n === "string"),
    );
    for (const tool of manifest.tools) {
      if (!discoveredNames.has(tool.name)) {
        throw new ExtensionError("INVALID_PACKAGE", `bundle 未导出声明工具: ${tool.name}`);
      }
    }
    for (const tool of manifest.tools) {
      if (typeof tool.parameters === "object" && tool.parameters !== null) {
        try {
          z.fromJSONSchema(tool.parameters as Record<string, unknown>);
        } catch {
          throw new ExtensionError("INVALID_PACKAGE", `工具 ${tool.name} 的参数 schema 不可编译`);
        }
      }
    }

    // 版本强化检查 + 原子安装。
    const installed = await this.store.readInstalled(manifest.name);
    const previousVersion = installed?.activeVersion;
    if (previousVersion !== undefined && compareSemver(manifest.version, previousVersion) <= 0) {
      throw new ExtensionError("VERSION_REGRESSION", "新版本必须高于当前 active 版本");
    }
    await this.store.installVersion(manifest.name, manifest.version, root, {
      ...(previousVersion === undefined ? {} : { previousVersion }),
    });
    await this.store.setActiveVersion(manifest.name, manifest.version);
    await this.store.deleteCandidate(id);
    if (this.onRegistryChanged !== undefined) await this.onRegistryChanged();
    const updated = await this.store.readInstalled(manifest.name);
    if (updated === undefined) throw new ExtensionError("NOT_FOUND", "安装后读取失败");
    return updated;
  }

  // ------------------------------------------------------------ 生命周期 ----

  listInstalled(): Promise<InstalledRecord[]> {
    return this.store.listInstalled();
  }

  async getVersions(name: string): Promise<string[]> {
    const installed = await this.store.readInstalled(name);
    if (installed === undefined) throw new ExtensionError("NOT_FOUND", "包未安装");
    return installed.versions;
  }

  async rollback(name: string): Promise<InstalledRecord> {
    const installed = await this.store.readInstalled(name);
    if (installed === undefined) throw new ExtensionError("NOT_FOUND", "包未安装");
    const previous = installed.previousVersion;
    if (previous === undefined) throw new ExtensionError("NOT_FOUND", "没有可回滚的上一版本");
    await this.store.setActiveVersion(name, previous);
    if (this.onRegistryChanged !== undefined) await this.onRegistryChanged();
    const updated = await this.store.readInstalled(name);
    if (updated === undefined) throw new ExtensionError("NOT_FOUND", "读取失败");
    return updated;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const installed = await this.store.readInstalled(name);
    if (installed === undefined) throw new ExtensionError("NOT_FOUND", "包未安装");
    await this.store.setEnabled(name, enabled);
    if (this.onRegistryChanged !== undefined) await this.onRegistryChanged();
  }

  async uninstall(name: string, options: { deleteStorage?: boolean } = {}): Promise<void> {
    const installed = await this.store.readInstalled(name);
    if (installed === undefined) throw new ExtensionError("NOT_FOUND", "包未安装");
    await this.store.deletePackage(name, options);
    if (this.onRegistryChanged !== undefined) await this.onRegistryChanged();
  }

  /** 缓存：供注册表 additionalTools 同步读取。 */
  private toolsCache: AnyAgentTool[] = [];

  /** 重新构建并缓存工具包装（安装/停用/回滚/卸载后调用）。 */
  async refreshTools(): Promise<void> {
    this.toolsCache = await this.makeTools();
  }

  /** 同步读取已安装工具包装缓存。 */
  syncTools(): AnyAgentTool[] {
    return this.toolsCache;
  }

  async close(): Promise<void> {
    this.toolsCache = [];
  }

  // ------------------------------------------------------------ 工具包装 ----

  /** 当前已安装并启用的包工具（每次调用重建，active 变化后由刷新触发）。 */
  async listTools(): Promise<AnyAgentTool[]> {
    return this.makeTools();
  }

  private async makeTools(): Promise<AnyAgentTool[]> {
    const installed = await this.store.listInstalled();
    const tools: AnyAgentTool[] = [];
    for (const record of installed) {
      if (!record.enabled) continue;
      const manifest = await readJsonFile<PluginManifestV2>(
        path.join(this.store.installedVersionRoot(record.name, record.activeVersion), "plugin.json"),
      );
      if (manifest === undefined) continue;
      const bundle = await readMaybeFile(
        path.join(this.store.installedVersionRoot(record.name, record.activeVersion), "bundle", "plugin.js"),
      );
      if (bundle === undefined) continue;
      for (const tool of manifest.tools) {
        tools.push(this.wrapTool(record.name, record.activeVersion, manifest, tool, bundle));
      }
    }
    return tools;
  }

  private wrapTool(
    pkgName: string,
    version: string,
    manifest: PluginManifestV2,
    declaration: PluginToolDeclaration,
    bundle: string,
  ): AnyAgentTool {
    const publicName = `plugin__${pkgName}__${declaration.name}`;
    let inputSchema: z.ZodType<unknown> = z.object({}).strict();
    if (typeof declaration.parameters === "object" && declaration.parameters !== null) {
      inputSchema = z.fromJSONSchema(declaration.parameters as Record<string, unknown>) as z.ZodType<unknown>;
    }
    return {
      name: publicName,
      description: declaration.description || `${pkgName}@${version} 的 ${declaration.name} 工具`,
      inputSchema,
      execute: async (input, ctx) => {
        const caps = mergePermissions(declaration.permissions);
        const inputJson = JSON.stringify(input ?? {});
        if (Buffer.byteLength(inputJson, "utf8") > this.limits.maxIoBytes) {
          return { error: "SANDBOX_INPUT_TOO_LARGE", message: "输入超过 1MB 上限" };
        }
        const result = await runSandboxCall({
          bundleSource: bundle,
          toolName: declaration.name,
          input: input ?? {},
          meta: { name: pkgName, version },
          caps,
          limits: this.limits,
          deps: this.buildHostDeps(manifest, caps),
          ctx,
        });
        if (!result.ok) {
          return { error: "SANDBOX_EXECUTION_FAILED", message: result.error?.message ?? "沙箱执行失败" };
        }
        return result.value;
      },
    };
  }

  private buildHostDeps(
    manifest: PluginManifestV2,
    caps: ResolvedPermissions,
  ): SandboxHostDeps {
    return {
      defaultCwd: this.hostCwd,
      limits: this.limits,
      caps,
      meta: { name: manifest.name, version: manifest.version },
      fsService: createHostFilesystemService({
        hostCwd: this.hostCwd,
        adminRoots: this.adminRoots,
      }),
      terminalService: createHostTerminalService({ defaultCwd: this.hostCwd }),
      storage: {
        read: (name) => this.store.storageRead(name),
        write: (name, entries) => this.store.storageWrite(name, entries),
      },
      credentials: this.credentials,
      ...(this.hostDeps?.fetchImpl === undefined
        ? {} : { fetchImpl: this.hostDeps.fetchImpl }),
    } as SandboxHostDeps;
  }
}

// ---------------------------------------------------------------- 工具函数 ----

function quietCtx(): ToolExecutionContext {
  return {
    origin: "scheduled_task",
    ask: async () => "denied" as const,
  };
}

async function findSourceEntry(sourceDir: string): Promise<string | undefined> {
  for (const name of ["index.ts", "index.js", "main.ts", "main.js"]) {
    const candidate = path.join(sourceDir, name);
    try {
      const { stat } = await import("node:fs/promises");
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 继续
    }
  }
  return undefined;
}

async function readSourceFilesUnder(root: string, dir: string): Promise<Array<{ path: string; content: string }>> {
  const { readdir, stat, readFile } = await import("node:fs/promises");
  const base = path.join(root, dir);
  const out: Array<{ path: string; content: string }> = [];
  const walk = async (current: string, rel: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = path.join(current, name);
      let stats;
      try {
        stats = await stat(abs);
      } catch {
        continue;
      }
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (stats.isDirectory()) await walk(abs, childRel);
      else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(name)) {
        if (out.length >= MAX_SOURCE_FILES) continue;
        const content = await readFile(abs, "utf8").catch(() => "");
        if (Buffer.byteLength(content, "utf8") <= MAX_SOURCE_BYTES) {
          out.push({ path: childRel, content });
        }
      }
    }
  };
  await walk(base, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function readMaybeFile(abs: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

function summarizeRisks(manifest: PluginManifestV2): string[] {
  const risks: string[] = [];
  for (const tool of manifest.tools) {
    const p = tool.permissions;
    if (p === undefined) continue;
    if (p.files?.length) risks.push(`文件访问: ${p.files.join(", ")}`);
    if (p.hosts?.length) risks.push(`网络: ${p.hosts.length} 个 host`);
    if (p.commands?.length) risks.push(`终端: ${p.commands.join(", ")}`);
    if (p.storage) risks.push("持久存储");
    if (p.credentials?.length) risks.push(`凭据槽: ${p.credentials.join(", ")}`);
  }
  return [...new Set(risks)];
}
