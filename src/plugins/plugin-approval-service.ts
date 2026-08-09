import { z } from "zod";
import type { AnyAgentTool } from "../tools/tool.js";
import {
  hashAction,
  hashManifest,
  newApprovalId,
  type ApprovalPreview,
  type ApprovalRecord,
  type ApprovalStore,
  type PluginApprovalAction,
  type PublicApproval,
} from "./approval-store.js";
import { createDeclarativeTool } from "./declarative-tool.js";
import {
  extractEnvRefs,
  parseStaticUrl,
  type HttpExecutorRuntimeOptions,
} from "./http-executor.js";
import { hashPluginDirectorySnapshot } from "./plugin-loader.js";
import {
  PLUGIN_NAME_PATTERN,
  pluginManifestSchema,
  type PluginManifest,
} from "./manifest-schema.js";
import type { PluginManager, PluginStatus } from "./plugin-manager.js";
import { PluginApprovalError } from "./plugin-approval-error.js";
import {
  pluginExistsOnDisk,
  readPluginManifestFingerprint,
  readPluginManifestRaw,
  rollbackNewPlugin,
  writeNewPluginManifest,
  type WrittenPlugin,
  PluginWriteError,
} from "./plugin-writer.js";

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface PluginApprovalServiceOptions {
  /** 审批记录存储端口；当前进程内实现，重启后失效。 */
  store: ApprovalStore;
  manager: PluginManager;
  /** 供 builtin 引用解析与草案构造性校验。 */
  builtinTools: readonly AnyAgentTool[];
  allowedHosts?: readonly string[];
  allowedEnvVars?: readonly string[];
  /** 审批有效期，默认 15 分钟。 */
  ttlMs?: number;
  /** 时钟注入，便于测试控制过期。 */
  now?: () => number;
}

/** 执行结果：create/reload 返回注册表状态，启停返回单个插件状态。 */
export type PluginExecutionResult =
  | { applied: boolean; plugins: PluginStatus[] }
  | { plugin: PluginStatus };

const createPluginActionSchema = z.object({
  type: z.literal("create_plugin"),
  manifest: z.unknown(),
}).strict();

const reloadPluginsActionSchema = z.object({
  type: z.literal("reload_plugins"),
}).strict();

const setEnabledActionSchema = z.object({
  type: z.literal("set_plugin_enabled"),
  plugin: z.string().regex(
    PLUGIN_NAME_PATTERN,
    "插件名必须匹配 ^[a-z][a-z0-9_]*$",
  ),
  enabled: z.boolean(),
}).strict();

const approvalActionSchema = z.discriminatedUnion("type", [
  createPluginActionSchema,
  reloadPluginsActionSchema,
  setEnabledActionSchema,
]);

/**
 * 自服务插件闭环的审批编排：
 *
 * createDraft（草案，零副作用）→ approve/reject（受鉴权 HTTP 调用）→
 * execute（只执行已批准且哈希匹配的一次性冻结动作，原子写入 + 重载）。
 *
 * 模型工具只暴露 createDraft；approve/reject/execute 只走 HTTP，
 * 模型没有批准自己的工具，无法绕过审批门。
 */
export class PluginApprovalService {
  private readonly store: ApprovalStore;
  private readonly manager: PluginManager;
  private readonly builtinTools: ReadonlyMap<string, AnyAgentTool>;
  private readonly builtinNames: ReadonlySet<string>;
  private readonly httpOptions: HttpExecutorRuntimeOptions;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** 正在执行中的审批 id，防止同一动作被并发执行。 */
  private activeApprovalId: string | undefined;

  constructor(options: PluginApprovalServiceOptions) {
    this.store = options.store;
    this.manager = options.manager;
    this.ttlMs = options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.now = options.now ?? Date.now;
    this.httpOptions = {
      ...(options.allowedHosts === undefined
        ? {}
        : { allowedHosts: options.allowedHosts }),
      ...(options.allowedEnvVars === undefined
        ? {}
        : { allowedEnvVars: options.allowedEnvVars }),
    };
    const builtins = new Map<string, AnyAgentTool>();
    for (const tool of options.builtinTools) {
      builtins.set(tool.name, tool);
    }
    this.builtinTools = builtins;
    this.builtinNames = new Set(builtins.keys());
  }

  /**
   * 创建审批草案：校验并规范化动作、生成哈希与脱敏预览、写入存储。
   * 本方法零副作用——不落盘、不重载、不启用任何插件。
   */
  createDraft(rawAction: unknown): PublicApproval {
    const parsed = approvalActionSchema.safeParse(rawAction);
    if (!parsed.success) {
      throw new PluginApprovalError(
        "PLUGIN_VALIDATION_FAILED",
        "审批动作不合法",
        { details: parsed.error.issues },
      );
    }

    const action = this.normalizeAction(parsed.data);
    const now = this.now();
    const record: ApprovalRecord = {
      id: newApprovalId(),
      action,
      actionHash: hashAction(action),
      status: "pending",
      createdAt: now,
      expiresAt: now + this.ttlMs,
      preview: buildPreview(action),
    };
    this.store.create(record);
    return toPublicApproval(record, this.now());
  }

  listApprovals(): PublicApproval[] {
    return this.store
      .list()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => toPublicApproval(record, this.now()));
  }

  /** 批准：只接受 pending；过期、已拒绝、已执行、哈希不符都会被拒绝。 */
  approve(id: string, expectedHash: string): PublicApproval {
    const record = this.requireRecord(id);
    this.assertFrozen(record);
    this.assertHash(record, expectedHash);
    if (isExpired(record, this.now())) {
      throw new PluginApprovalError(
        "APPROVAL_EXPIRED",
        `审批 ${id} 已过期`,
      );
    }
    if (record.status === "rejected") {
      throw new PluginApprovalError("APPROVAL_REJECTED", `审批 ${id} 已被拒绝`);
    }
    if (record.status === "executed") {
      throw new PluginApprovalError(
        "APPROVAL_ALREADY_USED",
        `审批 ${id} 已执行，不能重复批准`,
      );
    }
    if (record.status === "approved") {
      throw new PluginApprovalError(
        "APPROVAL_ALREADY_USED",
        `审批 ${id} 已批准`,
      );
    }
    const updated = this.store.updateStatus(id, "approved");
    return toPublicApproval(updated ?? record, this.now());
  }

  /** 拒绝/取消：pending 与 approved 均可取消；已执行不可取消。 */
  reject(id: string): PublicApproval {
    const record = this.requireRecord(id);
    if (record.status === "executed") {
      throw new PluginApprovalError(
        "APPROVAL_ALREADY_USED",
        `审批 ${id} 已执行，不能取消`,
      );
    }
    const updated = this.store.updateStatus(id, "rejected");
    return toPublicApproval(updated ?? record, this.now());
  }

  /**
   * 执行已批准的一次性动作：哈希匹配 + 未过期 + 未被拒绝/重放。
   * 失败（如重载不通过）会回滚新写入的文件并保持旧注册表，
   * 审批保持 approved 状态以便人工决定重试或拒绝。
   */
  async execute(
    id: string,
    expectedHash: string,
  ): Promise<{ approval: PublicApproval; result: PluginExecutionResult }> {
    const record = this.requireRecord(id);
    this.assertFrozen(record);
    this.assertHash(record, expectedHash);
    if (isExpired(record, this.now())) {
      throw new PluginApprovalError("APPROVAL_EXPIRED", `审批 ${id} 已过期`);
    }
    if (record.status === "rejected") {
      throw new PluginApprovalError("APPROVAL_REJECTED", `审批 ${id} 已被拒绝`);
    }
    if (record.status === "executed") {
      throw new PluginApprovalError(
        "APPROVAL_ALREADY_USED",
        `审批 ${id} 已执行，不能重复执行`,
      );
    }
    if (record.status !== "approved") {
      throw new PluginApprovalError(
        "APPROVAL_NOT_APPROVED",
        `审批 ${id} 尚未批准`,
      );
    }
    if (this.activeApprovalId !== undefined) {
      throw new PluginApprovalError(
        "APPROVAL_CONCURRENT",
        this.activeApprovalId === id
          ? `审批 ${id} 正在执行中`
          : `另一个审批 ${this.activeApprovalId} 正在执行，请稍后重试`,
      );
    }

    // 全局 mutation 互斥：所有插件变更（create/reload/enable/disable）共用
    // 一个临界区，串行化「快照校验 → 写入 → reload」整段过程，防止不同审批
    // 交错执行造成顺带加载未审内容或半成品状态。
    this.activeApprovalId = id;
    try {
      // 临界区起点让出一次微任务：使并发的 execute 请求能观察到互斥锁。
      await Promise.resolve();
      const result = await this.applyAction(record.action);
      const updated = this.store.updateStatus(id, "executed");
      return {
        approval: toPublicApproval(updated ?? record, this.now()),
        result,
      };
    } finally {
      this.activeApprovalId = undefined;
    }
  }

  /** 校验并规范化动作；create_plugin 在这里完成 manifest 的正式校验。 */
  private normalizeAction(
    action: z.infer<typeof approvalActionSchema>,
  ): PluginApprovalAction {
    if (action.type === "create_plugin") {
      const result = pluginManifestSchema.safeParse(action.manifest);
      if (!result.success) {
        throw new PluginApprovalError(
          "PLUGIN_VALIDATION_FAILED",
          "插件 manifest 不合法",
          { details: result.error.issues },
        );
      }
      const manifest = result.data;
      // 同名冲突：内置工具名、磁盘上已有目录、管理器已知名字（含错误目录）。
      if (this.builtinNames.has(manifest.name)) {
        throw new PluginApprovalError(
          "PLUGIN_CONFLICT",
          `插件名 ${manifest.name} 与内置工具冲突`,
        );
      }
      if (
        pluginExistsOnDisk(this.manager.pluginsDir, manifest.name)
        || this.manager.getStatus(manifest.name) !== undefined
      ) {
        throw new PluginApprovalError(
          "PLUGIN_CONFLICT",
          `同名插件 ${manifest.name} 已存在，create_plugin 不支持覆盖`,
        );
      }
      // 构造性校验：builtin 引用存在、http 策略（https/静态 host 白名单/env 白名单）
      // 与 JSON Schema -> zod 可转换性。只做干跑，不产生任何副作用。
      try {
        createDeclarativeTool(manifest, this.builtinTools, this.httpOptions);
      } catch (error) {
        throw new PluginApprovalError(
          "PLUGIN_VALIDATION_FAILED",
          messageOf(error),
        );
      }
      return {
        type: "create_plugin",
        manifest,
        // 绑定草案时的插件目录快照：执行前目录必须与草案时完全一致，
        // 防止批准后换入的其他插件随 create 的全量 reload 被顺带加载。
        dirSnapshotHash: hashPluginDirectorySnapshot(this.manager.pluginsDir),
      };
    }
    if (action.type === "reload_plugins") {
      return {
        type: "reload_plugins",
        dirSnapshotHash: hashPluginDirectorySnapshot(this.manager.pluginsDir),
      };
    }
    const status = this.manager.getStatus(action.plugin);
    if (status === undefined) {
      throw new PluginApprovalError(
        "PLUGIN_NOT_FOUND",
        `插件 ${action.plugin} 不存在`,
      );
    }
    if (status.state === "error") {
      throw new PluginApprovalError(
        "PLUGIN_VALIDATION_FAILED",
        `插件 ${action.plugin} 加载失败，不可启停`,
      );
    }
    let manifestFingerprint: string;
    try {
      manifestFingerprint = readPluginManifestFingerprint(
        this.manager.pluginsDir,
        action.plugin,
      );
    } catch (error) {
      throw new PluginApprovalError(
        "PLUGIN_VALIDATION_FAILED",
        `无法读取插件 ${action.plugin} 的 manifest: ${messageOf(error)}`,
      );
    }
    return {
      type: "set_plugin_enabled",
      plugin: action.plugin,
      enabled: action.enabled,
      manifestFingerprint,
    };
  }

  private requireRecord(id: string): ApprovalRecord {
    const record = this.store.get(id);
    if (record === undefined) {
      throw new PluginApprovalError("APPROVAL_NOT_FOUND", `审批 ${id} 不存在`);
    }
    return record;
  }

  private assertHash(record: ApprovalRecord, expectedHash: string): void {
    if (record.actionHash !== expectedHash) {
      throw new PluginApprovalError(
        "APPROVAL_HASH_MISMATCH",
        `审批 ${record.id} 的内容哈希不匹配，拒绝批准/执行（疑似篡改）`,
      );
    }
  }

  /**
   * 强制验证冻结动作本身未被篡改：存储层返回的记录可能来自
   * 任何实现，因此批准/执行前都重新哈希 action 与 actionHash 比对。
   */
  private assertFrozen(record: ApprovalRecord): void {
    if (hashAction(record.action) !== record.actionHash) {
      throw new PluginApprovalError(
        "APPROVAL_HASH_MISMATCH",
        `审批 ${record.id} 的冻结动作被篡改（重新哈希不匹配）`,
      );
    }
  }

  private async applyAction(
    action: PluginApprovalAction,
  ): Promise<PluginExecutionResult> {
    if (action.type === "create_plugin") {
      return this.applyCreate(action.manifest, action.dirSnapshotHash);
    }
    if (action.type === "reload_plugins") {
      const current = hashPluginDirectorySnapshot(this.manager.pluginsDir);
      if (current !== action.dirSnapshotHash) {
        throw new PluginApprovalError(
          "PLUGIN_DIR_CHANGED",
          "插件目录在审批期间发生变化，拒绝执行；请重新创建草案",
        );
      }
      const result = this.manager.reload();
      if (!result.applied) {
        throw new PluginApprovalError(
          "PLUGIN_APPLY_FAILED",
          "插件重载失败，注册表保持原状",
          { details: { statuses: result.statuses } },
        );
      }
      return { applied: true, plugins: result.statuses };
    }
    let currentFingerprint: string;
    try {
      currentFingerprint = readPluginManifestFingerprint(
        this.manager.pluginsDir,
        action.plugin,
      );
    } catch (error) {
      throw new PluginApprovalError(
        "PLUGIN_DIR_CHANGED",
        `插件 ${action.plugin} 的 manifest 在审批期间变化或不可读: ${messageOf(error)}`,
      );
    }
    if (currentFingerprint !== action.manifestFingerprint) {
      throw new PluginApprovalError(
        "PLUGIN_DIR_CHANGED",
        `插件 ${action.plugin} 的 manifest 在审批期间被替换，拒绝执行`,
      );
    }
    const status = this.manager.setEnabled(action.plugin, action.enabled);
    if (status === undefined) {
      throw new PluginApprovalError(
        "PLUGIN_NOT_FOUND",
        `插件 ${action.plugin} 不存在`,
      );
    }
    return { plugin: status };
  }

  /** 原子写入 + 一致性校验 + 重载；任一步失败都回滚新文件。 */
  private applyCreate(
    manifest: PluginManifest,
    dirSnapshotHash: string,
  ): PluginExecutionResult {
    // 写入前验证目录快照与草案时完全一致（包含其他插件的 manifest/错误）。
    const current = hashPluginDirectorySnapshot(this.manager.pluginsDir);
    if (current !== dirSnapshotHash) {
      throw new PluginApprovalError(
        "PLUGIN_DIR_CHANGED",
        "插件目录在审批期间发生变化，拒绝执行；请重新创建草案",
      );
    }
    let written: WrittenPlugin | undefined;
    try {
      written = writeNewPluginManifest(this.manager.pluginsDir, manifest);
      // 落盘内容与批准动作的哈希一致性：防止写入后被并发篡改（TOCTOU 纵深）。
      const onDisk = JSON.parse(
        readPluginManifestRaw(written.manifestPath),
      ) as PluginManifest;
      if (hashManifest(onDisk) !== hashManifest(manifest)) {
        throw new PluginApprovalError(
          "APPROVAL_HASH_MISMATCH",
          "落盘内容与批准动作哈希不一致（疑似被篡改）",
        );
      }
      const reload = this.manager.reload();
      if (!reload.applied) {
        throw new PluginApprovalError(
          "PLUGIN_APPLY_FAILED",
          "插件重载失败，已回滚新写入的文件，注册表保持原状",
          { details: { statuses: reload.statuses } },
        );
      }
      return { applied: true, plugins: reload.statuses };
    } catch (error) {
      if (written !== undefined) {
        rollbackNewPlugin(this.manager.pluginsDir, manifest.name);
      }
      if (error instanceof PluginApprovalError) throw error;
      if (error instanceof PluginWriteError) {
        throw new PluginApprovalError(
          error.code === "PLUGIN_EXISTS" ? "PLUGIN_EXISTS" : "PLUGIN_APPLY_FAILED",
          error.message,
        );
      }
      throw new PluginApprovalError(
        "PLUGIN_APPLY_FAILED",
        `插件写入失败: ${messageOf(error)}`,
      );
    }
  }
}

function isExpired(record: ApprovalRecord, now: number): boolean {
  return now >= record.expiresAt;
}

function buildPreview(action: PluginApprovalAction): ApprovalPreview {
  if (action.type === "create_plugin") {
    return buildCreatePreview(action);
  }
  if (action.type === "reload_plugins") {
    return {
      summary: "重新加载全部插件并原子替换注册表",
      changes: [
        "重新扫描插件目录并原子重建注册表（不写任何文件）",
        `绑定插件目录快照 ${action.dirSnapshotHash.slice(0, 10)}…，`
          + "执行前目录内容变化将拒绝",
      ],
      riskSummary: "影响所有已加载插件的运行时可用性；任一插件失败时保留旧注册表。",
    };
  }
  return {
    summary: `${action.enabled ? "启用" : "禁用"}插件 ${action.plugin}`,
    changes: [
      `仅修改 ${action.plugin} 的运行时 enabled 状态（内存态，不写文件）`,
      `绑定 manifest 指纹 ${action.manifestFingerprint.slice(0, 10)}…，`
        + "执行前同名插件内容被替换将拒绝",
    ],
    riskSummary: action.enabled
      ? "启用后该插件工具对模型可见。"
      : "禁用后该插件工具对模型不可见。",
  };
}

function buildCreatePreview(
  action: Extract<PluginApprovalAction, { type: "create_plugin" }>,
): ApprovalPreview {
  const manifest = action.manifest;
  if (manifest.executor.type === "builtin") {
    return {
      summary: `创建插件 ${manifest.name}（builtin 引用 ${manifest.executor.ref}）`,
      pluginName: manifest.name,
      executorType: "builtin",
      changes: [
        `新建 plugins/${manifest.name}/manifest.json`,
        "重载注册表并启用新工具",
        `绑定插件目录快照 ${action.dirSnapshotHash.slice(0, 10)}…，`
          + "执行前目录内容变化将拒绝",
      ],
      riskSummary: "引用框架内置实现，不发起网络请求；参数校验以该实现自身 schema 为准。",
    };
  }
  const executor = manifest.executor;
  const { host, pathname } = parseStaticUrl(executor.url);
  const method = executor.method ?? "GET";
  const envVarNames = extractEnvRefs(executor);
  return {
    summary: `创建 HTTP 插件 ${manifest.name}：${method} ${host}${pathname}`,
    pluginName: manifest.name,
    executorType: "http",
    targetHost: host,
    httpMethod: method,
    envVarNames,
    changes: [
      `新建 plugins/${manifest.name}/manifest.json`,
      "重载注册表并启用新工具",
      `绑定插件目录快照 ${action.dirSnapshotHash.slice(0, 10)}…，`
        + "执行前目录内容变化将拒绝",
    ],
    riskSummary: `向 ${host} 发起 ${method} HTTPS 请求；响应 JSON 将回填给模型；`
      + `可引用白名单环境变量：${envVarNames.length === 0 ? "（无）" : envVarNames.join(", ")}；`
      + "受超时与 1MB 响应体上限约束。",
  };
}

/** 转换为对外快照：只含状态、哈希、预览，不含动作原文。 */
function toPublicApproval(record: ApprovalRecord, now: number): PublicApproval {
  return {
    id: record.id,
    type: record.action.type,
    // 只有仍处于 pending 的过期审批对外显示 expired；已执行/已拒绝保持原状态。
    status: record.status === "pending" && isExpired(record, now)
      ? "expired"
      : record.status,
    hash: record.actionHash,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    preview: record.preview,
    ...(record.lastError === undefined
      ? {}
      : { lastError: record.lastError }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
