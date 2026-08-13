import type {
  ModelClient,
  ModelMessage,
  ModelToolCall,
} from "../model/model-client.js";
import { z } from "zod";
import { ToolRegistryError, type ToolRegistry } from "../tools/tool-registry.js";
import {
  AgentMaxStepsError,
  type AgentRunResult,
  type AgentToolExecution,
} from "./chat-agent.js";
import {
  ContextManager,
  emptyContextUsage,
  type ContextManagerOptions,
} from "./context-manager.js";

const DEFAULT_MAX_STEPS = 10;

/** 可持久化的 Agent 安全检查点；只在模型调用或单次工具调用完成后更新。 */
const persistedToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
}).strict();

const persistedMessageSchema = z.union([
  z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string() }).strict(),
  z.object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(persistedToolCallSchema),
  }).strict(),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
  }).strict(),
]);

export const agentRunCheckpointSchema = z.object({
  version: z.literal(1),
  history: z.array(persistedMessageSchema),
  pendingToolCalls: z.array(persistedToolCallSchema),
  nextToolCallIndex: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  model: z.string(),
  totalTokens: z.number().int().nonnegative().optional(),
  toolExecutions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["success", "error"]),
  }).strict()),
  context: z.object({
    compactions: z.number().int().nonnegative(),
    summarizedMessages: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();

export type AgentRunCheckpoint = z.infer<typeof agentRunCheckpointSchema>;

/** 当前正在进行、尚未到达安全检查点的动作，用于重启后判断恢复风险。 */
export const agentRunActivitySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("model") }).strict(),
  z.object({
    phase: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
  }).strict(),
]);

export type AgentRunActivity = z.infer<typeof agentRunActivitySchema>;

export type ResumableAgentOutcome =
  | { type: "completed"; result: AgentRunResult }
  | { type: "paused"; checkpoint: AgentRunCheckpoint };

export interface ResumableChatAgentOptions {
  maxSteps?: number;
  shouldPause?: () => boolean | Promise<boolean>;
  onActivity?: (activity: AgentRunActivity) => void | Promise<void>;
  onCheckpoint?: (checkpoint: AgentRunCheckpoint) => void | Promise<void>;
  context?: ContextManagerOptions;
}

/**
 * 为后台任务提供可恢复的单 Agent 工具循环。
 *
 * 暂停只会发生在模型调用之前，或一项工具执行完成并已把结果写入检查点之后；
 * 因此正常暂停不会重复有副作用的工具。正在执行的动作另行记录为 activity，
 * 服务异常退出后可据此区分“模型可安全重试”和“工具结果不确定”。
 */
export class ResumableChatAgent {
  private readonly maxSteps: number;
  private readonly contextManager: ContextManager;

  constructor(
    private readonly modelClient: ModelClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly options: ResumableChatAgentOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) {
      throw new Error(`maxSteps 必须是正整数，实际为 ${this.maxSteps}`);
    }
    this.contextManager = new ContextManager(modelClient, options.context);
  }

  async run(
    messages: readonly ModelMessage[],
    checkpoint?: AgentRunCheckpoint,
    signal?: AbortSignal,
  ): Promise<ResumableAgentOutcome> {
    signal?.throwIfAborted();
    const state = checkpoint === undefined
      ? createInitialCheckpoint(messages)
      : structuredClone(checkpoint);
    await this.persistCheckpoint(state);

    while (true) {
      signal?.throwIfAborted();
      if (await this.pauseRequested()) return paused(state);

      if (state.nextToolCallIndex < state.pendingToolCalls.length) {
        await this.executePendingTool(state, signal);
        await this.persistCheckpoint(state);
        if (await this.pauseRequested()) return paused(state);
        continue;
      }

      if (state.pendingToolCalls.length > 0) {
        state.pendingToolCalls = [];
        state.nextToolCallIndex = 0;
        await this.persistCheckpoint(state);
      }
      if (state.steps >= this.maxSteps) throw new AgentMaxStepsError(this.maxSteps);

      const prepared = await this.contextManager.prepare(
        state.history as ModelMessage[],
        this.toolRegistry.listDefinitions(),
        state.context ?? emptyContextUsage(),
        signal,
      );
      state.context = prepared.usage;
      if (prepared.totalTokens !== undefined) {
        state.totalTokens = (state.totalTokens ?? 0) + prepared.totalTokens;
      }
      if (prepared.compacted) await this.persistCheckpoint(state);

      await this.options.onActivity?.({ phase: "model" });
      const completion = await this.modelClient.complete({
        messages: state.history as ModelMessage[],
        tools: this.toolRegistry.listDefinitions(),
        ...(signal === undefined ? {} : { signal }),
      });
      state.steps += 1;
      state.model = completion.model;
      if (completion.totalTokens !== undefined) {
        state.totalTokens = (state.totalTokens ?? 0) + completion.totalTokens;
      }

      if (completion.toolCalls.length === 0) {
        return {
          type: "completed",
          result: {
            content: completion.content,
            model: state.model,
            ...(state.totalTokens === undefined ? {} : { totalTokens: state.totalTokens }),
            steps: state.steps,
            toolExecutions: structuredClone(state.toolExecutions),
            ...(state.context.compactions === 0 ? {} : { context: state.context }),
          },
        };
      }

      state.history.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls.map((call) => structuredClone(call)),
      });
      state.pendingToolCalls = completion.toolCalls.map((call) => structuredClone(call));
      state.nextToolCallIndex = 0;
      await this.persistCheckpoint(state);
    }
  }

  private async executePendingTool(
    state: AgentRunCheckpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    const toolCall = state.pendingToolCalls[state.nextToolCallIndex];
    if (toolCall === undefined) return;
    await this.options.onActivity?.({
      phase: "tool",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });

    let status: AgentToolExecution["status"];
    let content: string;
    try {
      const result = await this.toolRegistry.execute(
        toolCall.name,
        toolCall.arguments,
        signal,
      );
      status = "success";
      content = typeof result === "string"
        ? result
        : JSON.stringify(result) ?? String(result);
    } catch (error) {
      signal?.throwIfAborted();
      status = "error";
      content = toolErrorMessage(error);
    }

    state.toolExecutions.push({ id: toolCall.id, name: toolCall.name, status });
    state.history.push({
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      content,
    });
    state.nextToolCallIndex += 1;
  }

  private async pauseRequested(): Promise<boolean> {
    return await this.options.shouldPause?.() ?? false;
  }

  private async persistCheckpoint(state: AgentRunCheckpoint): Promise<void> {
    await this.options.onCheckpoint?.(structuredClone(state));
  }
}

function createInitialCheckpoint(
  messages: readonly ModelMessage[],
): AgentRunCheckpoint {
  return {
    version: 1,
    history: messages.map((message) => structuredClone(message)),
    pendingToolCalls: [],
    nextToolCallIndex: 0,
    steps: 0,
    model: "",
    toolExecutions: [],
    context: emptyContextUsage(),
  };
}

function paused(checkpoint: AgentRunCheckpoint): ResumableAgentOutcome {
  return { type: "paused", checkpoint: structuredClone(checkpoint) };
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof ToolRegistryError) {
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    return cause === undefined ? error.message : `${error.message}：${cause}`;
  }
  return error instanceof Error ? error.message : String(error);
}
