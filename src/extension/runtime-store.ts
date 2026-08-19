import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CandidateRecord,
  DraftRecord,
  InstalledRecord,
} from "./types.js";
import { ExtensionError } from "./validate.js";

/**
 * 插件运行存储：管理草稿、候选、已安装版本、隔离 KV 与构建缓存。
 * 所有关键写入采用「临时文件 + rename」原子替换；路径写入经 assertSafeDraftPath
 * 校验防止穿越。仓库外不写 `plugins/`。
 */

const ACTIVE_FILE = "active";
const ENABLED_FILE = "enabled";
const DRAFT_JSON = "draft.json";
const CANDIDATE_JSON = "candidate.json";

export class RuntimeStore {
  constructor(readonly baseDir: string) {}

  draftsDir(): string {
    return path.join(this.baseDir, "drafts");
  }

  candidatesDir(): string {
    return path.join(this.baseDir, "candidates");
  }

  installedDir(): string {
    return path.join(this.baseDir, "installed");
  }

  storageDir(): string {
    return path.join(this.baseDir, "storage");
  }

  cacheDir(draftId: string): string {
    return path.join(this.baseDir, "cache", draftId);
  }

  async init(): Promise<void> {
    await Promise.all([
      fsp.mkdir(this.draftsDir(), { recursive: true }),
      fsp.mkdir(this.candidatesDir(), { recursive: true }),
      fsp.mkdir(this.installedDir(), { recursive: true }),
      fsp.mkdir(this.storageDir(), { recursive: true }),
      fsp.mkdir(path.join(this.baseDir, "cache"), { recursive: true }),
    ]);
  }

  // ---- 草稿 ----

  newDraftId(): string {
    return randomUUID();
  }

  draftRoot(id: string): string {
    return path.join(this.draftsDir(), id);
  }

  async createDraft(record: DraftRecord): Promise<void> {
    await fsp.mkdir(this.draftRoot(record.id), { recursive: true });
    await this.writeJson(this.draftPath(record.id), record);
  }

  async readDraft(id: string): Promise<DraftRecord | undefined> {
    return this.readJson<DraftRecord>(this.draftPath(id));
  }

  async listDrafts(): Promise<DraftRecord[]> {
    return this.listDirRecords(this.draftsDir(), DRAFT_JSON);
  }

  async writeDraftRecord(record: DraftRecord): Promise<void> {
    await this.writeJson(this.draftPath(record.id), record);
  }

  async readDraftFile(id: string, rel: string): Promise<string | undefined> {
    return this.readFileSafe(this.draftRoot(id), rel);
  }

  async writeDraftFileRaw(id: string, rel: string, content: string): Promise<void> {
    const root = this.draftRoot(id);
    const abs = await this.safeJoin(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
  }

  async deleteDraft(id: string): Promise<void> {
    await fsp.rm(this.draftRoot(id), { recursive: true, force: true }).catch(() => {});
  }

  private draftPath(id: string): string {
    return path.join(this.draftRoot(id), DRAFT_JSON);
  }

  // ---- 候选 ----

  candidateRoot(id: string): string {
    return path.join(this.candidatesDir(), id);
  }

  async createCandidate(record: CandidateRecord, sourceRoot: string): Promise<void> {
    await fsp.rm(this.candidateRoot(record.id), { recursive: true, force: true });
    await fsp.mkdir(this.candidateRoot(record.id), { recursive: true });
    await fsp.cp(sourceRoot, this.candidateRoot(record.id), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    await this.writeJson(path.join(this.candidateRoot(record.id), CANDIDATE_JSON), record);
  }

  async readCandidate(id: string): Promise<CandidateRecord | undefined> {
    return this.readJson<CandidateRecord>(
      path.join(this.candidateRoot(id), CANDIDATE_JSON),
    );
  }

  async listCandidates(): Promise<CandidateRecord[]> {
    return this.listDirRecords(this.candidatesDir(), CANDIDATE_JSON);
  }

  async deleteCandidate(id: string): Promise<void> {
    await fsp.rm(this.candidateRoot(id), { recursive: true, force: true }).catch(() => {});
  }

  // ---- 已安装 ----

  installedRoot(name: string): string {
    return path.join(this.installedDir(), name);
  }

  installedVersionRoot(name: string, version: string): string {
    return path.join(this.installedDir(), name, version);
  }

  async readInstalled(name: string): Promise<InstalledRecord | undefined> {
    const root = this.installedRoot(name);
    try {
      const stat = await fsp.stat(path.join(root, ACTIVE_FILE));
      void stat;
    } catch {
      return undefined;
    }
    const activeVersion = await this.readLine(path.join(root, ACTIVE_FILE));
    const versions = await this.listDirNames(root);
    const enabled = await this.exists(path.join(root, ENABLED_FILE));
    if (activeVersion === undefined) return undefined;
    const previousVersion = await this.readLine(path.join(root, "previous"));
    return {
      name,
      versions: versions.filter((v) => v !== ACTIVE_FILE && v !== ENABLED_FILE && v !== "previous"),
      activeVersion,
      ...(previousVersion === undefined ? {} : { previousVersion }),
      enabled,
      installedAt: await this.readLine(path.join(root, "installedAt")) ?? new Date().toISOString(),
    };
  }

  async listInstalled(): Promise<InstalledRecord[]> {
    const names = await this.listDirNames(this.installedDir());
    const out: InstalledRecord[] = [];
    for (const name of names) {
      const record = await this.readInstalled(name);
      if (record !== undefined) out.push(record);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** 把候选包文件复制进已安装版本目录并设 active、enabled、previous。 */
  async installVersion(
    name: string,
    version: string,
    sourceRoot: string,
    options: { previousVersion?: string },
  ): Promise<void> {
    const root = this.installedRoot(name);
    await fsp.mkdir(root, { recursive: true });
    const versionRoot = this.installedVersionRoot(name, version);
    await fsp.rm(versionRoot, { recursive: true, force: true });
    await fsp.cp(sourceRoot, versionRoot, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    // 原子切换 active 指针。
    await this.writeLine(path.join(root, ACTIVE_FILE), version);
    if (options.previousVersion !== undefined) {
      await this.writeLine(path.join(root, "previous"), options.previousVersion);
    }
    await this.writeLine(path.join(root, ENABLED_FILE), "1");
    await this.writeLine(path.join(root, "installedAt"), new Date().toISOString());
  }

  async setActiveVersion(name: string, version: string): Promise<void> {
    await this.writeLine(path.join(this.installedRoot(name), ACTIVE_FILE), version);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const flag = path.join(this.installedRoot(name), ENABLED_FILE);
    if (enabled) await this.writeLine(flag, "1");
    else await fsp.rm(flag, { force: true }).catch(() => {});
  }

  async deletePackage(name: string, options: { deleteStorage?: boolean } = {}): Promise<void> {
    await fsp.rm(this.installedRoot(name), { recursive: true, force: true }).catch(() => {});
    if (options.deleteStorage ?? false) {
      await fsp.rm(path.join(this.storageDir(), name), { force: true }).catch(() => {});
    }
  }

  async readInstalledPackageFile(
    name: string,
    version: string,
    rel: string,
  ): Promise<string | undefined> {
    return this.readFileSafe(this.installedVersionRoot(name, version), rel);
  }

  // ---- 隔离 KV（每包独立，配额由调用方按字节校验） ----

  storagePath(name: string): string {
    return path.join(this.storageDir(), `${name}.json`);
  }

  async storageRead(name: string): Promise<Record<string, string>> {
    const value = await this.readJson<Record<string, string>>(this.storagePath(name));
    return value ?? {};
  }

  async storageWrite(name: string, entries: Record<string, string>): Promise<void> {
    await this.writeJson(this.storagePath(name), entries);
  }

  // ---- 工具 ----

  private async safeJoin(root: string, rel: string): Promise<string> {
    if (path.isAbsolute(rel) || rel.includes("..") || rel.includes("\\")) {
      throw new ExtensionError("PATH_UNSAFE", `非法相对路径: ${rel}`);
    }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) {
      throw new ExtensionError("PATH_UNSAFE", `路径越界: ${rel}`);
    }
    return abs;
  }

  private async readFileSafe(root: string, rel: string): Promise<string | undefined> {
    const abs = await this.safeJoin(root, rel);
    try {
      return await fsp.readFile(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  private async readJson<T>(absPath: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fsp.readFile(absPath, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(absPath: string, value: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const temp = `${absPath}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(temp, absPath);
  }

  private async writeLine(absPath: string, value: string): Promise<void> {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const temp = `${absPath}.${randomUUID()}.tmp`;
    await fsp.writeFile(temp, `${value}\n`, "utf8");
    await fsp.rename(temp, absPath);
  }

  private async readLine(absPath: string): Promise<string | undefined> {
    try {
      return (await fsp.readFile(absPath, "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async exists(absPath: string): Promise<boolean> {
    try {
      await fsp.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  private async listDirNames(dir: string): Promise<string[]> {
    try {
      return (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async listDirRecords<T>(
    dir: string,
    marker: string,
  ): Promise<T[]> {
    const out: T[] = [];
    const names = await this.listDirNames(dir);
    for (const name of names) {
      const record = await this.readJson<T>(path.join(dir, name, marker));
      if (record !== undefined) out.push(record);
    }
    return out;
  }
}
