import type { AnyAgentTool } from "../tools/tool.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { createDeclarativeTool } from "./declarative-tool.js";
import type { HttpExecutorRuntimeOptions } from "./http-executor.js";
import {
  loadPluginManifests,
  type PluginLoadError,
} from "./plugin-loader.js";
import type { PluginManifest } from "./manifest-schema.js";

export interface PluginManagerOptions {
  pluginsDir: string;
  builtinTools: readonly AnyAgentTool[];
  /** ChatAgent 持有的同一个注册表；重载通过 replaceAll 原子替换内容。 */
  registry: ToolRegistry;
  allowedHosts?: readonly string[];
  /** 允许 ${env:NAME} 引用的环境变量名白名单（默认拒绝全部）。 */
  allowedEnvVars?: readonly string[];
  fetchImpl?: typeof fetch;
  /** 由其他动态协议贡献的工具（例如 MCP）；每次重建时原子合并。 */
  additionalTools?: () => readonly AnyAgentTool[];
}

export type PluginState = "loaded" | "error" | "disabled";

/** 对外状态快照：不含 manifest 原文、密钥引用或工具实现。 */
export interface PluginStatus {
  name: string;
  state: PluginState;
  enabled: boolean;
  toolNames: string[];
  error?: string;
  loadedAt?: string;
  /** manifest 描述，用于控制台展示插件用途；加载失败（无 manifest）时缺省。 */
  description?: string;
  /** 执行器类型：内置引用或 HTTP 请求。 */
  executorType?: "builtin" | "http";
  /** HTTP 型插件的完整目标 URL（不含 headers/密钥）；builtin 型缺省。 */
  httpUrl?: string;
}

interface PluginEntry {
  name: string;
  manifest: PluginManifest;
  enabled: boolean;
  tool: AnyAgentTool;
  loadedAt: string;
}

/**
 * 插件生命周期管理：
 *
 * - 启动加载为尽力而为：坏插件跳过并进入状态列表，服务照常启动；
 * - reload 为原子操作：任一插件失败则整体保留旧注册表，本次尝试结果返回给调用方；
 * - enable/disable 的底层内存切换保留给嵌入调用；HTTP 用户操作由 PluginService
 *   写回 manifest 后原子重载，以便重启后保持选择。
 */
export class PluginManager {
  /** 只读暴露给插件服务做冲突检查与安全写入。 */
  readonly pluginsDir: string;
  private readonly builtinTools: ReadonlyMap<string, AnyAgentTool>;
  private readonly builtinNames: ReadonlySet<string>;
  private readonly registry: ToolRegistry;
  private readonly httpOptions: HttpExecutorRuntimeOptions;
  private readonly additionalTools: () => readonly AnyAgentTool[];

  private entries: PluginEntry[] = [];
  private loadErrors: PluginLoadError[] = [];

  constructor(options: PluginManagerOptions) {
    this.pluginsDir = options.pluginsDir;
    this.registry = options.registry;
    this.additionalTools = options.additionalTools ?? (() => []);
    this.httpOptions = {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
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

  /** 启动时尽力加载：坏插件跳过并进入状态列表，其余照常注册。 */
  loadInitial(): PluginStatus[] {
    const { entries, errors } = this.buildEntries();
    this.entries = entries;
    this.loadErrors = errors;
    this.rebuildRegistry();
    return this.listStatuses();
  }

  /** 原子重载：任一插件失败则保留旧注册表，返回本次尝试结果。 */
  reload(): { applied: boolean; statuses: PluginStatus[] } {
    const { entries, errors } = this.buildEntries();
    const statuses = this.toStatuses(entries, errors);
    if (errors.length > 0) {
      return { applied: false, statuses };
    }
    try {
      this.entries = entries;
      this.loadErrors = [];
      this.rebuildRegistry();
      return { applied: true, statuses };
    } catch (error) {
      // 防御：replaceAll 本身原子，失败时注册表与条目都保持原状，只记录全局错误。
      this.loadErrors = [{
        dirName: "*",
        message: `注册表重建失败: ${messageOf(error)}`,
      }];
      return { applied: false, statuses: this.listStatuses() };
    }
  }

  listStatuses(): PluginStatus[] {
    return this.toStatuses(this.entries, this.loadErrors);
  }

  /** 按名字查询当前状态（含错误目录），供安装与启停校验。 */
  getStatus(name: string): PluginStatus | undefined {
    return this.listStatuses().find((status) => status.name === name);
  }

  /** 当前已启用的本地插件工具，供其他动态工具源做组合注册。 */
  listTools(): AnyAgentTool[] {
    return this.entries.filter((entry) => entry.enabled).map((entry) => entry.tool);
  }

  /** 运行时启停：只改内存态并重建注册表；加载失败的插件不可启停。 */
  setEnabled(name: string, enabled: boolean): PluginStatus | undefined {
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (!entry) return undefined;
    entry.enabled = enabled;
    this.rebuildRegistry();
    return this.toStatuses([entry], [])[0];
  }

  /** 解析 + 构造工具，返回条目与逐插件错误；不修改当前状态。 */
  private buildEntries(): {
    entries: PluginEntry[];
    errors: PluginLoadError[];
  } {
    const { plugins, errors } = loadPluginManifests(this.pluginsDir);
    const seen = new Set<string>();
    const entries: PluginEntry[] = [];

    for (const record of plugins) {
      const { manifest } = record;
      if (seen.has(manifest.name)) {
        errors.push({
          dirName: record.dirName,
          message: `插件名 ${manifest.name} 重复`,
        });
        continue;
      }
      seen.add(manifest.name);

      // 插件名不能遮蔽内置工具：同名只允许标准的 builtin 自引用。
      if (
        this.builtinNames.has(manifest.name)
        && (manifest.executor.type !== "builtin"
          || manifest.executor.ref !== manifest.name)
      ) {
        errors.push({
          dirName: record.dirName,
          message: `插件名 ${manifest.name} 与内置工具冲突`,
        });
        continue;
      }

      try {
        const tool = createDeclarativeTool(
          manifest,
          this.builtinTools,
          this.httpOptions,
        );
        entries.push({
          name: manifest.name,
          manifest,
          enabled: manifest.enabled ?? true,
          tool,
          loadedAt: new Date().toISOString(),
        });
      } catch (error) {
        errors.push({
          dirName: record.dirName,
          message: messageOf(error),
        });
      }
    }

    return { entries, errors };
  }

  private rebuildRegistry(): void {
    const tools = [...this.listTools(), ...this.additionalTools()];
    this.registry.replaceAll(tools);
  }

  private toStatuses(
    entries: readonly PluginEntry[],
    errors: readonly PluginLoadError[],
  ): PluginStatus[] {
    const statuses: PluginStatus[] = entries.map((entry) => ({
      name: entry.name,
      state: entry.enabled ? "loaded" : "disabled",
      enabled: entry.enabled,
      toolNames: entry.enabled ? [entry.name] : [],
      loadedAt: entry.loadedAt,
      description: entry.manifest.description,
      executorType: entry.manifest.executor.type,
      ...(entry.manifest.executor.type === "http"
        ? { httpUrl: entry.manifest.executor.url }
        : {}),
    }));
    for (const error of errors) {
      statuses.push({
        name: error.dirName,
        state: "error",
        enabled: false,
        toolNames: [],
        error: error.message,
      });
    }
    statuses.sort((a, b) => a.name.localeCompare(b.name));
    return statuses;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
