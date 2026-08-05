import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
} from "../model/model-client.js";
import { ToolRegistryError, type ToolRegistry } from "../tools/tool-registry.js";

/**
 * 一次工具执行的对外摘要：只含标识和状态，不包含原始入参与工具结果。
 * 未来工具的参数与返回可能包含敏感数据，因此不应默认透传给 HTTP。
 */
export interface AgentToolExecution {
  id: string;
  name: string;
  status: "success" | "error";
}

/** Agent 层结果：HTTP 只应返回这里的字段，而不是模型原始参数或工具结果。 */
export interface AgentRunResult {
  content: string;
  model: string;
  totalTokens?: number;
  /** 本轮实际执行的模型调用次数，含产出最终回答的那一次。 */
  steps: number;
  toolExecutions: readonly AgentToolExecution[];
}

/**
 * Agent 流式输出事件。
 *
 * - content：模型文本增量，可直接转发给客户端；
 * - tool_execution：单次工具执行摘要，发生在执行完成后；
 * - done：整轮结束，携带与 chat() 相同的最终结果。
 */
export type AgentStreamEvent =
  | { type: "content"; content: string }
  | { type: "tool_execution"; execution: AgentToolExecution }
  | { type: "done"; result: AgentRunResult };

export interface ChatAgentOptions {
  /** 模型调用最大轮次，防止工具循环失控；默认 10。 */
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 10;

/** 达到 maxSteps 仍未产出最终正文时抛出的终止错误。 */
export class AgentMaxStepsError extends Error {
  readonly steps: number;

  constructor(steps: number) {
    super(`Agent 在 ${steps} 步内未完成`);
    this.name = "AgentMaxStepsError";
    this.steps = steps;
  }
}

/**
 * Agent 应用层：隔离 HTTP 协议与具体模型厂商，并负责单 Agent 工具循环。
 *
 * 每轮把消息历史和白名单工具定义交给模型；模型返回工具请求时，
 * 执行工具并把结果回填到历史，直到模型不再请求工具为止。
 */
export class ChatAgent {
  private readonly maxSteps: number;

  // 依赖接口而非 DeepSeekClient 或具体工具，便于切换实现，也便于测试注入假实现。
  constructor(
    private readonly modelClient: ModelClient,
    private readonly toolRegistry: ToolRegistry,
    options: ChatAgentOptions = {},
  ) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new Error(`maxSteps 必须是正整数，实际为 ${maxSteps}`);
    }
    this.maxSteps = maxSteps;
  }

  async chat(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    signal?.throwIfAborted();

    const history: ModelMessage[] = [...messages];
    const toolExecutions: AgentToolExecution[] = [];
    let totalTokens: number | undefined;
    let model = "";
    let steps = 0;

    while (steps < this.maxSteps) {
      signal?.throwIfAborted();
      steps += 1;

      const completion = await this.modelClient.complete({
        messages: history,
        tools: this.toolRegistry.listDefinitions(),
        ...(signal === undefined ? {} : { signal }),
      });
      model = completion.model;
      if (completion.totalTokens !== undefined) {
        totalTokens = (totalTokens ?? 0) + completion.totalTokens;
      }

      // 模型不再请求工具时，本轮内容就是最终回答。
      if (completion.toolCalls.length === 0) {
        return {
          content: completion.content,
          model,
          ...(totalTokens === undefined ? {} : { totalTokens }),
          steps,
          toolExecutions,
        };
      }

      history.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      for await (const _ of this.runToolCalls(
        completion,
        history,
        toolExecutions,
        signal,
      )) {
        // 非流式调用不需要工具执行事件，只消费生成器完成回填。
      }
    }

    throw new AgentMaxStepsError(this.maxSteps);
  }

  /**
   * 流式版 chat()：边生成边产出文本增量，工具执行后产出摘要，
   * 最终以 done 事件返回与 chat() 相同的 AgentRunResult。
   */
  async *chatStream(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    signal?.throwIfAborted();

    const history: ModelMessage[] = [...messages];
    const toolExecutions: AgentToolExecution[] = [];
    let totalTokens: number | undefined;
    let model = "";
    let steps = 0;

    while (steps < this.maxSteps) {
      signal?.throwIfAborted();
      steps += 1;

      let completion: ModelCompletion | undefined;
      for await (const event of this.modelClient.completeStream({
        messages: history,
        tools: this.toolRegistry.listDefinitions(),
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (event.type === "content") {
          yield { type: "content", content: event.content };
        } else {
          completion = event.completion;
        }
      }
      if (completion === undefined) {
        throw new Error("Model stream ended without a completion event");
      }

      model = completion.model;
      if (completion.totalTokens !== undefined) {
        totalTokens = (totalTokens ?? 0) + completion.totalTokens;
      }

      // 模型不再请求工具时，本轮内容就是最终回答。
      if (completion.toolCalls.length === 0) {
        yield {
          type: "done",
          result: {
            content: completion.content,
            model,
            ...(totalTokens === undefined ? {} : { totalTokens }),
            steps,
            toolExecutions,
          },
        };
        return;
      }

      history.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });

      for await (const execution of this.runToolCalls(
        completion,
        history,
        toolExecutions,
        signal,
      )) {
        yield { type: "tool_execution", execution };
      }
    }

    throw new AgentMaxStepsError(this.maxSteps);
  }

  /** 执行一轮模型请求中的所有工具调用，回填历史并逐个产出执行摘要。 */
  private async *runToolCalls(
    completion: ModelCompletion,
    history: ModelMessage[],
    toolExecutions: AgentToolExecution[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentToolExecution> {
    for (const toolCall of completion.toolCalls) {
      let status: AgentToolExecution["status"];
      let toolMessage: string;
      try {
        const result = await this.toolRegistry.execute(
          toolCall.name,
          toolCall.arguments,
          signal,
        );
        status = "success";
        toolMessage = serializeToolResult(result);
      } catch (error) {
        // 取消属于调用方控制流，不属于工具失败，继续向上传播。
        signal?.throwIfAborted();
        status = "error";
        toolMessage = toErrorMessage(error);
      }

      const execution: AgentToolExecution = {
        id: toolCall.id,
        name: toolCall.name,
        status,
      };
      toolExecutions.push(execution);
      history.push({
        role: "tool",
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: toolMessage,
      });
      yield execution;
    }
  }
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  // 注册表已保证结果可 JSON 序列化；这里只负责转成回填给模型的文本。
  return JSON.stringify(result) ?? String(result);
}

function toErrorMessage(error: unknown): string {
  // 注册表错误只暴露稳定摘要；把底层原因拼给模型便于它修正，但不回传 HTTP。
  if (error instanceof ToolRegistryError) {
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    return cause === undefined ? error.message : `${error.message}：${cause}`;
  }
  return error instanceof Error ? error.message : String(error);
}
