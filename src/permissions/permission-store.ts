import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 授权数据持久层：永久规则与「定时任务关联的待决请求」的原子 JSON 存储。
 *
 * 规则文件 rule 每次整体重写（临时文件 + rename），保证任一时刻磁盘上是
 * 完整集合；待决请求同样整体持久化，服务重启后可被重新决定并续跑任务。
 * 只存储必要的展示/标识字段，绝不写入密钥、文件正文或日志。
 */

export interface StoredPermissionRule {
  id: string;
  createdAt: string;
  kind: "file" | "command";
  pattern: string;
  operations: string[];
}

export interface StoredPendingRequest {
  id: string;
  key: string;
  toolName: string;
  op: string;
  target: string;
  summary: string;
  diff?: string;
  permanentlyAllowable: boolean;
  scope: { origin: string; callId?: string; runId?: string };
  createdAt: string;
  expiresAt: string;
}

const RULES_FILE = "rules.json";
const PENDING_FILE = "pending.json";

export class PermissionStore {
  constructor(private readonly dir: string) {}

  loadRules(): StoredPermissionRule[] {
    return this.readJson<StoredPermissionRule[]>(RULES_FILE, []);
  }

  /** 追加一条规则并原子写回。 */
  appendRule(rule: StoredPermissionRule): StoredPermissionRule {
    const rules = this.loadRules();
    rules.push(rule);
    this.writeJson(RULES_FILE, rules);
    return rule;
  }

  /** 按 id 移除规则；返回是否真的删除。 */
  deleteRule(id: string): boolean {
    const rules = this.loadRules();
    const next = rules.filter((rule) => rule.id !== id);
    if (next.length === rules.length) return false;
    this.writeJson(RULES_FILE, next);
    return true;
  }

  loadPending(): StoredPendingRequest[] {
    return this.readJson<StoredPendingRequest[]>(PENDING_FILE, []);
  }

  /** 写入/更新一个持久化待决请求（支持多次更新，按 id 去重）。 */
  upsertPending(request: StoredPendingRequest): void {
    const pending = this.loadPending();
    const index = pending.findIndex((item) => item.id === request.id);
    if (index >= 0) pending[index] = request;
    else pending.push(request);
    this.writeJson(PENDING_FILE, pending);
  }

  removePending(id: string): void {
    const pending = this.loadPending();
    const next = pending.filter((item) => item.id !== id);
    if (next.length === pending.length) return;
    this.writeJson(PENDING_FILE, next);
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      const raw = readFileSync(path.join(this.dir, file), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, file);
    const temp = path.join(this.dir, `.${file}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw new Error(`写入授权存储 ${file} 失败: ${messageOf(error)}`);
    }
  }
}

export function newPermissionRuleId(): string {
  return randomUUID();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
