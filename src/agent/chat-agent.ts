import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
} from "../model/model-client.js";
import { ToolRegistryError, type ToolRegistry } from "../tools/tool-registry.js";
import {
  type AgentToolDefinition,
  type PermissionOutcome,
  type ToolExecutionContext,
  type ToolPermissionAsk,
} from "../tools/tool.js";
import type { PermissionService, PermissionRequestPublic } from "../permissions/permission-service.js";
import {
  ContextManager,
  emptyContextUsage,
  type ContextManagerOptions,
  type ContextPreparation,
  type ContextUsage,
} from "./context-manager.js";

/**
 * 一次工具执行的对外摘要：只含标识、状态和耗时，
 * 不包含原始入参与工具结果，避免敏感数据透传给 HTTP。
 */
export interface AgentToolExecution {
  id: string;
  name: string;
  status: "success" | "error";
  /** 单次工具执行的耗时（毫秒），由 Agent 层在注册表调用前后测得。 */
  durationMs: number;
}

/** Agent 层结果：HTTP 只应返回这里的字段，而不是模型原始参数或工具结果。 */
export interface AgentRunResult {
  content: string;
  model: string;
  totalTokens?: number;
  /** 最终回答那轮的模型思考/推理内容（思维链），不持久化到会话。 */
  reasoning?: string;
  /** 本轮实际执行的模型调用次数，含产出最终回答的那一次。 */
  steps: number;
  toolExecutions: readonly AgentToolExecution[];
  context?: ContextUsage;
  /** 仅含调用方原始角色的压缩历史，不含内部 tool 消息和工具参数。 */
  contextMessages?: readonly ModelMessage[];
}

/**
 * Agent 流式输出事件。
 *
 * - status：阶段进展（model = 等待模型响应，tool = 即将执行工具），
 *   只在等待模型和执行工具之前发出，字段全部来自 Agent 静态枚举；
 * - reasoning：模型思考/推理内容增量（思维链），可直接转发给客户端；
 * - content：模型文本增量，可直接转发给客户端；
 * - tool_start：工具开始执行，只含 id/name，不含参数；
 * - tool_execution：单次工具执行摘要（含 durationMs），发生在执行完成后；
 * - done：整轮结束，携带与 chat() 相同的最终结果。
 *
 * 事件可以携带模型思考内容（reasoning），但不得携带工具参数、附件正文
 * 或内部提示词。
 */
export type AgentStreamEvent =
  | { type: "reasoning"; content: string }
  | { type: "content"; content: string }
  | { type: "status"; stage: "model" | "tool"; step: number }
  | { type: "tool_start"; id: string; name: string; step: number }
  | { type: "permission_request"; request: PermissionRequestPublic }
  | { type: "tool_execution"; execution: AgentToolExecution }
  | { type: "done"; result: AgentRunResult };

export interface ChatAgentOptions {
  /** 模型调用最大轮次，防止工具循环失控；默认 10。 */
  maxSteps?: number;
  context?: ContextManagerOptions;
  /** 等待一次模型响应（含上下文压缩调用）的超时；默认 120 秒。 */
  modelTimeoutMs?: number;
  /** 单次工具执行的超时；默认 120 秒。 */
  toolTimeoutMs?: number;
  /** 整个请求（全部模型/工具步骤）的总超时；默认 10 分钟。 */
  timeoutMs?: number;
  /** 授权服务（buildApp 单例）；未注入时所有需要授权的工具 fail-closed。 */
  permissionService?: PermissionService;
  /** 待决授权请求创建时的通知（聊天 SSE 通过此回调把 permission_request 事件写给前端）。 */
  emitPermissionRequest?: (request: PermissionRequestPublic) => void;
}

type AgentExecutionMode = "complete" | "stream";

const DEFAULT_MAX_STEPS = 10;
export const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export type AgentTimeoutKind = "model" | "tool" | "request";

const TIMEOUT_LABELS: Record<AgentTimeoutKind, string> = {
  model: "模型响应",
  tool: "工具执行",
  request: "整体请求",
};

/**
 * Agent 层超时错误：HTTP 适配层按 kind 区分模型超时、工具超时与整体请求超时，
 * 与用户中止（AbortError）和普通失败分开处理。
 */
export class AgentTimeoutError extends Error {
  readonly kind: AgentTimeoutKind;

  constructor(kind: AgentTimeoutKind, timeoutMs: number) {
    super(`${TIMEOUT_LABELS[kind]}超过 ${timeoutMs}ms，已取消`);
    this.name = "AgentTimeoutError";
    this.kind = kind;
  }
}

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
 * 在错误及其 cause/reason 链上查找 AgentTimeoutError。
 * 超时时我们会以该实例作为 AbortSignal 的 reason，因此 fetch/undici
 * 可能把 reason 包在 AbortError 或 SDK 包装错误里；这里沿链恢复类型。
 */
export function findAgentTimeout(error: unknown): AgentTimeoutError | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): AgentTimeoutError | undefined => {
    if (value === null || value === undefined || seen.has(value)) return undefined;
    seen.add(value);
    if (value instanceof AgentTimeoutError) return value;
    if (value instanceof Error) {
      const fromCause = walk(value.cause);
      if (fromCause !== undefined) return fromCause;
      if (value.name === "AbortError" && "reason" in value) {
        return walk((value as { reason?: unknown }).reason);
      }
    }
    return undefined;
  };
  return walk(error);
}

/** 判断错误是否为中止类错误（含被包装在 cause 链里的 AbortError）。 */
export function isAbortError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (value === null || value === undefined || seen.has(value)) return false;
    seen.add(value);
    if (value instanceof Error && value.name === "AbortError") return true;
    if (value instanceof Error) return walk(value.cause);
    return false;
  };
  return walk(error);
}

/**
 * 请求级截止时间：组合用户中止信号与整体超时，二者谁先触发都
 * 让 deadline.signal 中止；reason 保持来源不变，便于上层区分。
 */
class RequestDeadline {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly timer: NodeJS.Timeout;
  private readonly timeoutError: AgentTimeoutError;
  timedOut = false;

  constructor(userSignal: AbortSignal | undefined, timeoutMs: number) {
    this.timeoutError = new AgentTimeoutError("request", timeoutMs);
    this.signal = userSignal === undefined
      ? this.controller.signal
      : AbortSignal.any([userSignal, this.controller.signal]);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort(this.timeoutError);
    }, timeoutMs);
    this.timer.unref?.();
  }

  get error(): AgentTimeoutError {
    return this.timeoutError;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  /** 每个循环边界检查：用户中止或整体超时都按各自 reason 抛出。 */
  throwIfCancelled(): void {
    if (this.timedOut) throw this.timeoutError;
    this.signal.throwIfAborted();
  }

  /**
   * 与具体操作竞速的拒绝 Promise：用户中止或整体超时任一发生时立即拒绝，
   * 用于兜住不遵守 AbortSignal 的实现，保证请求仍能在截止时间内终止。
   */
  abortRejection(): Promise<never> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    return new Promise((_resolve, reject) => {
      this.signal.addEventListener(
        "abort",
        () => reject(this.signal.reason),
        { once: true },
      );
    });
  }
}

/**
 * 把一次异步操作与「单调用超时」和「整体截止时间」竞速。
 * 超时触发时先执行 onTimeout（通常用于中止操作自身的 signal），再拒绝。
 */
async function raceOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: AgentTimeoutError,
  deadline: RequestDeadline,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutRejection = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(timeoutError);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      operation,
      timeoutRejection,
      deadline.abortRejection(),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 流式模型调用的空闲超时包装：
 * - 每次收到增量后重置空闲计时，长时间无增量视为模型超时；
 * - 超时中止调用 signal、拒绝当前 next() 并尝试关闭底层迭代器；
 * - 用户中止或整体超时通过 deadline.abortRejection 立即向上传播。
 */
class ModelStreamRunner {
  private readonly iterator: AsyncIterator<ModelStreamEvent>;
  private readonly controller = new AbortController();
  private readonly timeoutError: AgentTimeoutError;
  private readonly timeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private idleReject: ((reason: unknown) => void) | undefined;
  private finished = false;

  constructor(
    client: ModelClient,
    request: ModelRequest,
    deadline: RequestDeadline,
    timeoutMs: number,
  ) {
    this.timeoutMs = timeoutMs;
    this.timeoutError = new AgentTimeoutError("model", timeoutMs);
    const signal = AbortSignal.any([deadline.signal, this.controller.signal]);
    this.iterator = client.completeStream({
      ...request,
      signal,
    })[Symbol.asyncIterator]();
  }

  private arm(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleReject = undefined;
    this.idleTimer = setTimeout(() => {
      this.controller.abort(this.timeoutError);
      this.idleReject?.(this.timeoutError);
      // 尝试温和关闭底层迭代器；不 await，避免被不配合的实现再次卡住。
      void Promise.resolve(this.iterator.return?.()).catch(() => {});
    }, this.timeoutMs);
    this.idleTimer.unref?.();
  }

  private idleRejection(): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.idleReject = reject;
    });
  }

  async *stream(deadline: RequestDeadline): AsyncGenerator<ModelStreamEvent> {
    try {
      this.arm();
      while (!this.finished) {
        let result: IteratorResult<ModelStreamEvent>;
        try {
          result = await Promise.race([
            this.iterator.next(),
            this.idleRejection(),
            deadline.abortRejection(),
          ]);
        } catch (error) {
          if (error === this.timeoutError) throw this.timeoutError;
          throw error;
        }
        if (result.done) {
          this.finished = true;
          return;
        }
        this.arm();
        yield result.value;
      }
    } finally {
      if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
      if (!this.finished) {
        void Promise.resolve(this.iterator.return?.()).catch(() => {});
      }
    }
  }
}

/**
 * Agent 应用层：隔离 HTTP 协议与具体模型厂商，并负责单 Agent 工具循环。
 *
 * 每轮把消息历史和白名单工具定义交给模型；模型返回工具请求时，
 * 执行工具并把结果回填到历史，直到模型不再请求工具为止。
 * 模型、工具与整体请求各有独立超时；用户中止作为控制流向上传播。
 */
export class ChatAgent {
  private readonly maxSteps: number;
  private readonly modelTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly contextManager: ContextManager;
  private readonly permissionService: PermissionService | undefined;
  private readonly emitPermissionRequest: ((request: PermissionRequestPublic) => void) | undefined;

  // 依赖接口而非 DeepSeekClient 或具体工具，便于切换实现，也便于测试注入假实现。
  constructor(
    private readonly modelClient: ModelClient,
    private readonly toolRegistry: ToolRegistry,
    options: ChatAgentOptions = {},
  ) {
    this.maxSteps = positiveInt(options.maxSteps, DEFAULT_MAX_STEPS, "maxSteps");
    this.modelTimeoutMs = positiveInt(
      options.modelTimeoutMs, DEFAULT_MODEL_TIMEOUT_MS, "modelTimeoutMs",
    );
    this.toolTimeoutMs = positiveInt(
      options.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS, "toolTimeoutMs",
    );
    this.timeoutMs = positiveInt(
      options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "timeoutMs",
    );
    this.contextManager = new ContextManager(modelClient, options.context);
    this.permissionService = options.permissionService;
    this.emitPermissionRequest = options.emitPermissionRequest;
  }

  async chat(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    let result: AgentRunResult | undefined;
    for await (const event of this.run(messages, "complete", signal)) {
      if (event.type === "done") result = event.result;
    }
    if (result === undefined) {
      throw new Error("Agent run ended without a done event");
    }
    return result;
  }

  /**
   * 流式版 chat()：边生成边产出文本增量；等待模型和执行工具前先发状态，
   * 工具开始/结束后产出安全摘要（含耗时），最终以 done 事件返回完整结果。
   */
  async *chatStream(
    messages: readonly ModelMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    yield* this.run(messages, "stream", signal);
  }

  /**
   * 普通与流式入口共用的唯一 Agent Loop。两种模式只在模型传输策略上分支：
   * complete 使用整次调用超时，stream 使用增量空闲超时；其余状态与工具语义一致。
   */
  private async *run(
    messages: readonly ModelMessage[],
    mode: AgentExecutionMode,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    signal?.throwIfAborted();
    const deadline = new RequestDeadline(signal, this.timeoutMs);
    try {
      const history: ModelMessage[] = [...messages];
      const toolExecutions: AgentToolExecution[] = [];
      let totalTokens: number | undefined;
      let model = "";
      let steps = 0;
      let context = emptyContextUsage();
      let contextMessages: ModelMessage[] | undefined;

      while (steps < this.maxSteps) {
        deadline.throwIfCancelled();
        steps += 1;

        // 等待模型（含上下文压缩）之前先告知当前阶段。
        yield { type: "status", stage: "model", step: steps };
        const prepared = await this.prepareWithTimeout(history, context, deadline);
        context = prepared.usage;
        if (prepared.compacted) {
          contextMessages = publicContextMessages(history);
        }
        if (prepared.totalTokens !== undefined) {
          totalTokens = (totalTokens ?? 0) + prepared.totalTokens;
        }

        let completion: ModelCompletion;
        if (mode === "complete") {
          completion = await this.completeWithTimeout(history, deadline);
        } else {
          let streamedCompletion: ModelCompletion | undefined;
          const runner = new ModelStreamRunner(
            this.modelClient,
            {
              messages: history,
              tools: this.toolRegistry.listDefinitions(),
            },
            deadline,
            this.modelTimeoutMs,
          );
          for await (const event of runner.stream(deadline)) {
            switch (event.type) {
              case "activity":
                // 仅用于刷新模型空闲计时，不能进入对外 SSE。
                break;
              case "reasoning":
                // 模型思考内容增量：透传给客户端展示思考过程。
                yield { type: "reasoning", content: event.content };
                break;
              case "content":
                yield { type: "content", content: event.content };
                break;
              case "completion":
                streamedCompletion = event.completion;
                break;
            }
          }
          if (streamedCompletion === undefined) {
            throw new Error("Model stream ended without a completion event");
          }
          completion = streamedCompletion;
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
              ...(completion.reasoning === undefined
                ? {}
                : { reasoning: completion.reasoning }),
              steps,
              toolExecutions,
              ...(context.compactions === 0 ? {} : { context }),
              ...(contextMessages === undefined ? {} : { contextMessages }),
            },
          };
          return;
        }

        history.push({
          role: "assistant",
          content: completion.content,
          toolCalls: completion.toolCalls,
        });

        // 执行工具之前先告知当前阶段。
        yield { type: "status", stage: "tool", step: steps };
        for await (const event of this.runToolCalls(
          completion, history, toolExecutions, signal, deadline, steps,
        )) {
          yield event;
        }
      }

      throw new AgentMaxStepsError(this.maxSteps);
    } finally {
      deadline.dispose();
    }
  }

  /** 上下文压缩可能调用模型，同样受模型超时与整体截止时间约束。 */
  private prepareWithTimeout(
    history: ModelMessage[],
    context: ContextUsage,
    deadline: RequestDeadline,
  ): Promise<ContextPreparation> {
    const controller = new AbortController();
    const timeoutError = new AgentTimeoutError("model", this.modelTimeoutMs);
    const signal = AbortSignal.any([deadline.signal, controller.signal]);
    return raceOperation(
      this.contextManager.prepare(
        history,
        this.toolRegistry.listDefinitions(),
        context,
        signal,
      ),
      this.modelTimeoutMs,
      timeoutError,
      deadline,
      () => controller.abort(timeoutError),
    );
  }

  /** 非流式模型调用：受模型超时与整体截止时间双重约束。 */
  private completeWithTimeout(
    history: ModelMessage[],
    deadline: RequestDeadline,
  ): Promise<ModelCompletion> {
    const controller = new AbortController();
    const timeoutError = new AgentTimeoutError("model", this.modelTimeoutMs);
    const signal = AbortSignal.any([deadline.signal, controller.signal]);
    return raceOperation(
      this.modelClient.complete({
        messages: history,
        tools: this.toolRegistry.listDefinitions(),
        signal,
      }),
      this.modelTimeoutMs,
      timeoutError,
      deadline,
      () => controller.abort(timeoutError),
    );
  }

  /**
   * 执行一轮模型请求中的所有工具调用，回填历史并逐个产出
   * tool_start / tool_execution 事件。工具超时与整体超时终止整轮，
   * 用户中止作为控制流向上传播，不包装成普通工具错误。
   */
  private async *runToolCalls(
    completion: ModelCompletion,
    history: ModelMessage[],
    toolExecutions: AgentToolExecution[],
    userSignal: AbortSignal | undefined,
    deadline: RequestDeadline,
    step: number,
  ): AsyncGenerator<AgentStreamEvent> {
    for (const toolCall of completion.toolCalls) {
      deadline.throwIfCancelled();
      yield { type: "tool_start", id: toolCall.id, name: toolCall.name, step };

      const controller = new AbortController();
      const timeoutError = new AgentTimeoutError("tool", this.toolTimeoutMs);
      const callSignal = AbortSignal.any([deadline.signal, controller.signal]);

      // 授权闭环：需要授权的操作（写入/编辑/补丁/删除/命令/敏感读取）
      // 在工具内调用 ctx.ask → 转发到共享 PermissionService。
      // 需确认时先通过 emitPermissionRequest 发 SSE 事件，再阻塞等待决定；
      // 决定后同一工具调用继续执行（无副作用时恢复）。
      const ask = async (permissionAsk: ToolPermissionAsk): Promise<PermissionOutcome> => {
        if (this.permissionService === undefined) return "denied";
        const gate = await this.permissionService.gate(
          permissionAsk,
          { origin: "chat", callId: toolCall.id },
        );
        if (gate.outcome !== undefined) return gate.outcome;
        if (gate.request === undefined) return "denied";
        this.emitPermissionRequest?.(gate.request);
        return gate.wait(callSignal);
      };
      const toolCtx: ToolExecutionContext = {
        signal: callSignal,
        origin: "chat",
        callId: toolCall.id,
        ask,
      };

      const startedAt = Date.now();
      let status: AgentToolExecution["status"];
      let toolMessage: string;
      try {
        const result = await raceOperation(
          this.toolRegistry.execute(toolCall.name, toolCall.arguments, toolCtx),
          this.toolTimeoutMs,
          timeoutError,
          deadline,
          () => controller.abort(timeoutError),
        );
        status = "success";
        toolMessage = serializeToolResult(result);
      } catch (error) {
        if (error instanceof AgentTimeoutError) throw error;
        // 取消属于调用方控制流，不属于工具失败，继续向上传播。
        userSignal?.throwIfAborted();
        if (deadline.timedOut) throw deadline.error;
        status = "error";
        toolMessage = toErrorMessage(error);
      }

      const execution: AgentToolExecution = {
        id: toolCall.id,
        name: toolCall.name,
        status,
        durationMs: Date.now() - startedAt,
      };
      toolExecutions.push(execution);
      history.push({
        role: "tool",
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: toolMessage,
      });
      yield { type: "tool_execution", execution };
    }
  }
}

function positiveInt(
  raw: number | undefined,
  fallback: number,
  name: string,
): number {
  const value = raw ?? fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数，实际为 ${value}`);
  }
  return value;
}

function publicContextMessages(history: readonly ModelMessage[]): ModelMessage[] {
  return history.flatMap((message): ModelMessage[] => {
    if (message.role === "tool") return [];
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) return [];
    return [{ role: message.role, content: message.content }];
  });
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
