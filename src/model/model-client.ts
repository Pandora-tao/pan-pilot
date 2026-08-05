import type { AgentToolDefinition } from "../tools/tool.js";

/** 模型请求执行的单次工具调用；arguments 在模型边界解析后仍按未知输入处理。 */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * 模型层使用的厂商无关消息协议。
 *
 * assistant 工具请求和 tool 执行结果必须完整回传给下一轮模型调用；
 * toolCallId 用来把执行结果与原始请求一一对应。
 */
export type ModelMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: readonly ModelToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

/** 一次模型调用所需的全部输入；工具执行仍由 Agent 层负责。 */
export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly AgentToolDefinition[];
  signal?: AbortSignal;
}

/** 将不同模型厂商的返回值归一化为 Agent 关心的字段。 */
export interface ModelCompletion {
  content: string;
  toolCalls: readonly ModelToolCall[];
  model: string;
  totalTokens?: number;
}

/**
 * 模型适配端口。
 *
 * Agent 只认识这个接口；真实运行时可接 DeepSeek，测试时则可传入内存中的假实现。
 */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelCompletion>;
}
