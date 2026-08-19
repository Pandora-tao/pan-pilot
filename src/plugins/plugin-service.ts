import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AnyAgentTool } from "../tools/tool.js";
import { canonicalJson } from "./canonical-json.js";
import { createDeclarativeTool } from "./declarative-tool.js";
import {
  extractEnvRefs,
  parseStaticUrl,
  type HttpExecutorRuntimeOptions,
} from "./http-executor.js";
import {
  pluginManifestSchema,
  type PluginManifest,
} from "./manifest-schema.js";
import type { PluginManager, PluginStatus } from "./plugin-manager.js";
import { PluginOperationError } from "./plugin-operation-error.js";
import {
  pluginExistsOnDisk,
  readPluginManifestRaw,
  rollbackNewPlugin,
  writeNewPluginManifest,
  writePluginManifest,
  type WrittenPlugin,
  PluginWriteError,
} from "./plugin-writer.js";

export interface PluginInstallPreview {
  summary: string;
  changes: string[];
  riskSummary: string;
  pluginName: string;
  executorType: "builtin" | "http";
  targetHost?: string;
  httpMethod?: string;
  envVarNames?: string[];
}

/** Agent 只能创建建议；完整 manifest 留在服务端，用户通过 id 选择安装。 */
export interface PluginSuggestion {
  id: string;
  createdAt: string;
  preview: PluginInstallPreview;
}

interface StoredPluginSuggestion extends PluginSuggestion {
  manifest: PluginManifest;
}

export interface PluginServiceOptions {
  manager: PluginManager;
  builtinTools: readonly AnyAgentTool[];
  allowedHosts?: readonly string[];
  allowedEnvVars?: readonly string[];
  /** 核心 HostRuntime 工具名：安装不得遮蔽/卸载。 */
  reservedNames?: ReadonlySet<string>;
}

export type PluginApplyResult = { applied: boolean; plugins: PluginStatus[] };

/**
 * 单用户插件管理：Agent 可以提出安装建议，只有用户侧 HTTP 接口能够安装、
 * 重载或启停。所有落盘仍经过 manifest 白名单校验、create-only 写入与原子重载。
 */
export class PluginService {
  private readonly manager: PluginManager;
  private readonly builtinTools: ReadonlyMap<string, AnyAgentTool>;
  private readonly builtinNames: ReadonlySet<string>;
  private readonly reservedNames: ReadonlySet<string>;
  private readonly httpOptions: HttpExecutorRuntimeOptions;
  private readonly suggestions = new Map<string, StoredPluginSuggestion>();

  constructor(options: PluginServiceOptions) {
    this.manager = options.manager;
    this.httpOptions = {
      ...(options.allowedHosts === undefined
        ? {}
        : { allowedHosts: options.allowedHosts }),
      ...(options.allowedEnvVars === undefined
        ? {}
        : { allowedEnvVars: options.allowedEnvVars }),
    };
    const builtins = new Map<string, AnyAgentTool>();
    for (const tool of options.builtinTools) builtins.set(tool.name, tool);
    this.builtinTools = builtins;
    this.builtinNames = new Set(builtins.keys());
    this.reservedNames = options.reservedNames ?? EMPTY_NAMES;
  }

  suggest(rawManifest: unknown): PluginSuggestion {
    const manifest = this.validateInstallableManifest(rawManifest);
    const suggestion: StoredPluginSuggestion = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      manifest,
      preview: buildPreview(manifest),
    };
    this.suggestions.set(suggestion.id, structuredClone(suggestion));
    return publicSuggestion(suggestion);
  }

  listSuggestions(): PluginSuggestion[] {
    return [...this.suggestions.values()]
      .map(publicSuggestion)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  dismissSuggestion(id: string): PluginSuggestion {
    const suggestion = this.requireSuggestion(id);
    this.suggestions.delete(id);
    return publicSuggestion(suggestion);
  }

  installSuggestion(id: string): {
    suggestion: PluginSuggestion;
    result: PluginApplyResult;
  } {
    const suggestion = this.requireSuggestion(id);
    const result = this.install(suggestion.manifest);
    this.suggestions.delete(id);
    return { suggestion: publicSuggestion(suggestion), result };
  }

  install(rawManifest: unknown): PluginApplyResult {
    const manifest = this.validateInstallableManifest(rawManifest);
    return this.applyCreate(manifest);
  }

  reload(): PluginApplyResult {
    const result = this.manager.reload();
    if (!result.applied) {
      throw new PluginOperationError(
        "PLUGIN_APPLY_FAILED",
        "插件重载失败，注册表保持原状",
        { details: { statuses: result.statuses } },
      );
    }
    return { applied: true, plugins: result.statuses };
  }

  setEnabled(name: string, enabled: boolean): PluginStatus {
    const status = this.manager.getStatus(name);
    if (status === undefined) {
      throw new PluginOperationError("PLUGIN_NOT_FOUND", `插件 ${name} 不存在`);
    }
    if (status.state === "error") {
      throw new PluginOperationError(
        "PLUGIN_VALIDATION_FAILED",
        `插件 ${name} 加载失败，不可启停`,
      );
    }
    const manifestPath = path.join(this.manager.pluginsDir, name, "manifest.json");
    let manifest: PluginManifest;
    try {
      manifest = pluginManifestSchema.parse(
        JSON.parse(readPluginManifestRaw(manifestPath)),
      );
      writePluginManifest(this.manager.pluginsDir, { ...manifest, enabled });
      const reload = this.manager.reload();
      if (!reload.applied) {
        writePluginManifest(this.manager.pluginsDir, manifest);
        this.manager.reload();
        throw new PluginOperationError(
          "PLUGIN_APPLY_FAILED",
          `插件 ${name} 状态更新失败，已恢复原状态`,
          { details: { statuses: reload.statuses } },
        );
      }
      const updated = this.manager.getStatus(name);
      if (updated === undefined) {
        throw new PluginOperationError("PLUGIN_NOT_FOUND", `插件 ${name} 不存在`);
      }
      return updated;
    } catch (error) {
      if (error instanceof PluginOperationError) throw error;
      if (error instanceof PluginWriteError) {
        throw new PluginOperationError("PLUGIN_APPLY_FAILED", error.message);
      }
      throw new PluginOperationError(
        "PLUGIN_VALIDATION_FAILED",
        `无法更新插件 ${name}: ${messageOf(error)}`,
      );
    }
  }

  private requireSuggestion(id: string): StoredPluginSuggestion {
    const suggestion = this.suggestions.get(id);
    if (suggestion === undefined) {
      throw new PluginOperationError(
        "PLUGIN_SUGGESTION_NOT_FOUND",
        `插件建议 ${id} 不存在`,
      );
    }
    return structuredClone(suggestion);
  }

  private validateInstallableManifest(rawManifest: unknown): PluginManifest {
    const parsed = pluginManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      throw new PluginOperationError(
        "PLUGIN_VALIDATION_FAILED",
        "插件 manifest 不合法",
        { details: parsed.error.issues },
      );
    }
    const manifest = parsed.data;
    if (this.builtinNames.has(manifest.name)) {
      throw new PluginOperationError(
        "PLUGIN_CONFLICT",
        `插件名 ${manifest.name} 与内置工具冲突`,
      );
    }
    if (this.reservedNames.has(manifest.name)) {
      throw new PluginOperationError(
        "PLUGIN_CONFLICT",
        `插件名 ${manifest.name} 与核心 HostRuntime 工具冲突（不可遮蔽/卸载）`,
      );
    }
    if (
      pluginExistsOnDisk(this.manager.pluginsDir, manifest.name)
      || this.manager.getStatus(manifest.name) !== undefined
    ) {
      throw new PluginOperationError(
        "PLUGIN_CONFLICT",
        `同名插件 ${manifest.name} 已安装`,
      );
    }
    try {
      createDeclarativeTool(manifest, this.builtinTools, this.httpOptions);
    } catch (error) {
      throw new PluginOperationError(
        "PLUGIN_VALIDATION_FAILED",
        messageOf(error),
      );
    }
    return manifest;
  }

  private applyCreate(manifest: PluginManifest): PluginApplyResult {
    let written: WrittenPlugin | undefined;
    try {
      written = writeNewPluginManifest(this.manager.pluginsDir, manifest);
      const onDisk = JSON.parse(
        readPluginManifestRaw(written.manifestPath),
      ) as PluginManifest;
      if (hashManifest(onDisk) !== hashManifest(manifest)) {
        throw new PluginOperationError(
          "PLUGIN_APPLY_FAILED",
          "落盘内容与待安装 manifest 不一致",
        );
      }
      const reload = this.manager.reload();
      if (!reload.applied) {
        throw new PluginOperationError(
          "PLUGIN_APPLY_FAILED",
          "插件加载失败，已回滚新写入的文件，注册表保持原状",
          { details: { statuses: reload.statuses } },
        );
      }
      return { applied: true, plugins: reload.statuses };
    } catch (error) {
      if (written !== undefined) {
        rollbackNewPlugin(this.manager.pluginsDir, manifest.name);
        // 回滚磁盘后同步恢复管理器对旧目录的视图。
        this.manager.reload();
      }
      if (error instanceof PluginOperationError) throw error;
      if (error instanceof PluginWriteError) {
        throw new PluginOperationError(
          error.code === "PLUGIN_EXISTS" ? "PLUGIN_EXISTS" : "PLUGIN_APPLY_FAILED",
          error.message,
        );
      }
      throw new PluginOperationError(
        "PLUGIN_APPLY_FAILED",
        `插件写入失败: ${messageOf(error)}`,
      );
    }
  }
}

function publicSuggestion(suggestion: StoredPluginSuggestion): PluginSuggestion {
  return {
    id: suggestion.id,
    createdAt: suggestion.createdAt,
    preview: structuredClone(suggestion.preview),
  };
}

function buildPreview(manifest: PluginManifest): PluginInstallPreview {
  if (manifest.executor.type === "builtin") {
    return {
      summary: `安装插件 ${manifest.name}（builtin 引用 ${manifest.executor.ref}）`,
      pluginName: manifest.name,
      executorType: "builtin",
      changes: [
        `新建 plugins/${manifest.name}/manifest.json`,
        "验证后原子重载工具注册表",
      ],
      riskSummary: "引用框架内置实现，不发起额外网络请求。",
    };
  }
  const { host, pathname } = parseStaticUrl(manifest.executor.url);
  const method = manifest.executor.method ?? "GET";
  const envVarNames = extractEnvRefs(manifest.executor);
  return {
    summary: `安装 HTTP 插件 ${manifest.name}：${method} ${host}${pathname}`,
    pluginName: manifest.name,
    executorType: "http",
    targetHost: host,
    httpMethod: method,
    envVarNames,
    changes: [
      `新建 plugins/${manifest.name}/manifest.json`,
      "验证后原子重载工具注册表",
    ],
    riskSummary: `向 ${host} 发起 ${method} HTTPS 请求；`
      + `可引用环境变量：${envVarNames.length ? envVarNames.join(", ") : "无"}；`
      + "受 host 白名单、超时与 1MB 响应上限约束。",
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();

function hashManifest(manifest: PluginManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}
