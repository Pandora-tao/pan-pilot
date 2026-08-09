import { z } from "zod";
import type {
  AgentToolDefinition,
  AnyAgentTool,
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
  private readonly tools = new Map<string, AnyAgentTool>();

  constructor(tools: readonly AnyAgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyAgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(
        "DUPLICATE_TOOL",
        tool.name,
        `工具 ${tool.name} 已注册`,
      );
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * 原子替换整个工具集合：先构造新集合并校验重复，全部合法才替换。
   * 抛错时原集合保持不变，供插件重载保留旧注册表。
   */
  replaceAll(tools: readonly AnyAgentTool[]): void {
    const next = new Map<string, AnyAgentTool>();
    for (const tool of tools) {
      if (next.has(tool.name)) {
        throw new ToolRegistryError(
          "DUPLICATE_TOOL",
          tool.name,
          `工具 ${tool.name} 已注册`,
        );
      }
      next.set(tool.name, tool);
    }
    this.tools.clear();
    for (const [name, tool] of next) {
      this.tools.set(name, tool);
    }
  }

  get(name: string): AnyAgentTool | undefined {
    return this.tools.get(name);
  }

  /** 返回可序列化的模型工具声明，不暴露 execute 函数或 Zod 实例。 */
  listDefinitions(): AgentToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();

    const tool = this.tools.get(name);
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

    signal?.throwIfAborted();

    let result: unknown;
    try {
      result = await tool.execute(parsed.data, signal);
    } catch (error) {
      // 中断属于调用方控制流，保留原始 reason，不包装成普通工具故障。
      if (signal?.aborted) signal.throwIfAborted();
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
