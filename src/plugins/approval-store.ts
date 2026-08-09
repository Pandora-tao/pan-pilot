import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { PluginManifest } from "./manifest-schema.js";

/**
 * 审批绑定的一次性不可变动作。
 *
 * - create_plugin：创建新插件（manifest 已规范化），执行时原子写入 + 重载；
 * - reload_plugins：全量重载插件目录并原子重建注册表；
 * - set_plugin_enabled：运行时启停（仅内存态）。
 */
export type PluginApprovalAction =
  | { type: "create_plugin"; manifest: PluginManifest; dirSnapshotHash: string }
  | { type: "reload_plugins"; dirSnapshotHash: string }
  | {
      type: "set_plugin_enabled";
      plugin: string;
      enabled: boolean;
      manifestFingerprint: string;
    };

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed";

/**
 * 审批预览：只含脱敏摘要，绝不包含 manifest 原文、header 值、
 * 环境变量值或任何密钥。审批页与模型工具看到的都是这个结构。
 */
export interface ApprovalPreview {
  /** 一句话摘要。 */
  summary: string;
  /** 将发生的文件/注册表变化清单。 */
  changes: string[];
  /** 风险摘要：网络目标、方法、引用的环境变量名、资源上限等。 */
  riskSummary: string;
  pluginName?: string;
  executorType?: "builtin" | "http";
  targetHost?: string;
  httpMethod?: string;
  /** 只列名字，不列值。 */
  envVarNames?: string[];
}

/** 存储层保存的完整审批记录（含冻结动作）。 */
export interface ApprovalRecord {
  id: string;
  action: PluginApprovalAction;
  /** 规范化动作的 SHA-256，绑定「批准/执行的是完全相同的一份参数」。 */
  actionHash: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  preview: ApprovalPreview;
  lastError?: string;
}

/** 对外安全快照：永远不包含 action.manifest（header 值可能含密钥）。 */
export interface PublicApproval {
  id: string;
  type: PluginApprovalAction["type"];
  status: ApprovalStatus | "expired";
  hash: string;
  createdAt: string;
  expiresAt: string;
  preview: ApprovalPreview;
  lastError?: string;
}

export interface ApprovalStoreOptions {
  /** 时钟注入，便于测试控制过期。 */
  now?: () => number;
}

/**
 * 审批记录持久化端口。
 *
 * 当前唯一实现是进程内 `InMemoryApprovalStore`：重启后所有审批立即失效，
 * 需要重新创建草案。未来换数据库实现时保持本接口不变即可。
 */
export interface ApprovalStore {
  create(record: ApprovalRecord): ApprovalRecord;
  get(id: string): ApprovalRecord | undefined;
  list(): ApprovalRecord[];
  updateStatus(
    id: string,
    status: ApprovalStatus,
    lastError?: string,
  ): ApprovalRecord | undefined;
}

/**
 * 进程内实现：单个进程内原子可见；进程重启后数据全部丢失。
 *
 * 存储边界做深拷贝：create/get/list/updateStatus 返回的都是内部记录的
 * 深拷贝，调用方拿到的任何对象都不是内部引用，无法通过返回值篡改冻结动作。
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly now: () => number;

  constructor(options: ApprovalStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  create(record: ApprovalRecord): ApprovalRecord {
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  get(id: string): ApprovalRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  list(): ApprovalRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  updateStatus(
    id: string,
    status: ApprovalStatus,
    lastError?: string,
  ): ApprovalRecord | undefined {
    const record = this.records.get(id);
    if (record === undefined) return undefined;
    record.status = status;
    if (lastError === undefined) {
      delete record.lastError;
    } else {
      record.lastError = lastError;
    }
    return structuredClone(record);
  }
}

export function newApprovalId(): string {
  return randomUUID();
}

export function hashAction(action: PluginApprovalAction): string {
  return createHash("sha256").update(canonicalJson(action)).digest("hex");
}

export function hashManifest(manifest: PluginManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
