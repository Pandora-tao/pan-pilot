import type { z } from "zod";

/** 提供给模型的工具描述；parameters 使用标准 JSON Schema。 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Agent 可执行工具的最小契约。
 *
 * 工具负责声明输入约束并执行已经校验过的参数；注册表负责查找、统一校验、
 * 中断检查和错误归一化，避免每个调用方重复实现这些横切逻辑。
 */
export interface AgentTool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  execute(input: TInput, signal?: AbortSignal): Promise<TOutput>;
}

/** 注册表需要在同一集合中保存不同输入、输出类型的工具。 */
export type AnyAgentTool = AgentTool<any, unknown>;
