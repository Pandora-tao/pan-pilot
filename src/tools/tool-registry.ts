import { z } from "zod";
import {
  type AgentToolDefinition,
  type AnyAgentTool,
  type ToolExecutionContext,
  defaultToolContext,
} from "./tool.js";

export type ToolRegistryErrorCode =
  | "DUPLICATE_TOOL"
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_INPUT"
  | "TOOL_EXECUTION_FAILED"
  | "INVALID_TOOL_RESULT";

/** 工具边界的稳定错误类型，供后续 Agent Loop 按错误码决定如何反馈模型。 */
export class ToolRegistryError extends Error {
  readonly code: ToolRegistryErrorCode;
  readonly toolName: string;
  readonly details?: unknown;

  constructor(
    code: ToolRegistryErrorCode,
    toolName: string,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolRegistryError";
    this.code = code;
    this.toolName = toolName;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** 只允许执行启动时显式注册的工具，不接受任意模块名或函数名。 */
export class ToolRegistry {
  /**
   * 核心 HostRuntime 工具（fs_*、terminal）单独存放：
   * replaceAll（插件/MCP 原子重建）不得覆盖或移除它们。
   */
  private readonly coreTools = new Map<string, AnyAgentTool>();
  private readonly tools = new Map<string, AnyAgentTool>();

  constructor(tools: readonly AnyAgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /**
   * 注册不可被插件重载移除的核心工具。命名冲突（含与既有核心工具冲突）
   * 直接抛错；核心工具必须先于依赖它的 replaceAll 注册完毕。
   */
  registerCore(tool: AnyAgentTool): void {
    if (this.coreTools.has(tool.name) || this.tools.has(tool.name)) {
      throw new ToolRegistryError(
        "DUPLICATE_TOOL",
        tool.name,
        `核心工具 ${tool.name} 已注册`,
      );
    }
    this.coreTools.set(tool.name, tool);
  }

  /** 核心 HostRuntime 工具名集合：插件与安装流程据此拒绝遮蔽。 */
  coreNames(): ReadonlySet<string> {
    return this.coreTools.size === 0
      ? EMPTY_NAME_SET
      : new Set(this.coreTools.keys());
  }

  register(tool: AnyAgentTool): void {
    if (this.coreTools.has(tool.name) || this.tools.has(tool.name)) {
      throw new ToolRegistryError(
        "DUPLICATE_TOOL",
        tool.name,
        `工具 ${tool.name} 已注册`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 原子替换「非核心」工具集合：先构造新集合并校验重复（含与核心工具冲突），
   * 全部合法才替换。抛错时原集合保持不变，供插件重载保留旧注册表。
   * 核心工具始终保留，插件启停/重载不会影响它们。
   */
  replaceAll(tools: readonly AnyAgentTool[]): void {
    // 用「核心 + 新集合」做重复校验（含与核心工具冲突），全部合法才替换。
    const checked = new Map<string, AnyAgentTool>();
    for (const tool of this.coreTools.values()) checked.set(tool.name, tool);
    for (const tool of tools) {
      if (checked.has(tool.name)) {
        throw new ToolRegistryError(
          "DUPLICATE_TOOL",
          tool.name,
          `工具 ${tool.name} 已注册（含核心工具）`,
        );
      }
      checked.set(tool.name, tool);
    }
    const next = new Map<string, AnyAgentTool>();
    for (const tool of tools) next.set(tool.name, tool);
    this.tools.clear();
    for (const [name, tool] of next) this.tools.set(name, tool);
  }

  get(name: string): AnyAgentTool | undefined {
    return this.tools.get(name) ?? this.coreTools.get(name);
  }

  /** 返回可序列化的模型工具声明，不暴露 execute 函数或 Zod 实例。 */
  listDefinitions(): AgentToolDefinition[] {
    const merged = mergedTools(this.coreTools, this.tools);
    return [...merged.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }

  /** 返回当前注册工具名（注册顺序），供系统提示词等轻量场景使用，无需构造 JSON Schema。 */
  listNames(): string[] {
    return [...mergedTools(this.coreTools, this.tools).keys()];
  }

  async execute(
    name: string,
    input: unknown,
    ctx?: ToolExecutionContext,
  ): Promise<unknown> {
    const context = ctx ?? defaultToolContext();
    context.signal?.throwIfAborted();

    const tool = this.tools.get(name)
      ?? this.coreTools.get(name);
    if (!tool) {
      throw new ToolRegistryError(
        "UNKNOWN_TOOL",
        name,
        `未知工具: ${name}`,
      );
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolRegistryError(
        "INVALID_TOOL_INPUT",
        name,
        `工具 ${name} 的参数不正确`,
        { details: parsed.error.issues },
      );
    }

    context.signal?.throwIfAborted();

    let result: unknown;
    try {
      result = await tool.execute(parsed.data, context);
    } catch (error) {
      // 中断属于调用方控制流，保留原始 reason，不包装成普通工具故障。
      if (context.signal?.aborted) context.signal.throwIfAborted();
      throw new ToolRegistryError(
        "TOOL_EXECUTION_FAILED",
        name,
        `工具 ${name} 执行失败`,
        { cause: error },
      );
    }

    assertJsonSerializable(name, result);
    return result;
  }
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set();

/** 核心 + 非核心工具的合并视图（核心优先，名称唯一）。 */
function mergedTools(
  core: Map<string, AnyAgentTool>,
  tools: Map<string, AnyAgentTool>,
): Map<string, AnyAgentTool> {
  const merged = new Map<string, AnyAgentTool>();
  for (const [name, tool] of core) merged.set(name, tool);
  for (const [name, tool] of tools) merged.set(name, tool);
  return merged;
}

function assertJsonSerializable(toolName: string, value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ToolRegistryError(
      "INVALID_TOOL_RESULT",
      toolName,
      `工具 ${toolName} 返回了不可序列化的结果`,
      { cause: error },
    );
  }

  if (serialized === undefined) {
    throw new ToolRegistryError(
      "INVALID_TOOL_RESULT",
      toolName,
      `工具 ${toolName} 返回了不可序列化的结果`,
    );
  }
}
