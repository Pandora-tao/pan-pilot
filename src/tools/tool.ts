import type { z } from "zod";

/** 提供给模型的工具描述；parameters 使用标准 JSON Schema。 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 工具向授权层提交的一次「需要用户确认」的请求。
 *
 * - target：规范化绝对路径或 shell 命令；
 * - summary：展示文本（路径 / 命令说明）；
 * - diff：写入、编辑、补丁的统一 diff 预览（敏感内容只在内存与已鉴权 SSE 中：
 *   绝不写入服务端日志）；
 * - permanentlyAllowable：是否允许用户选择「始终允许」落永久规则；
 *   删除、破坏性命令与敏感路径必须为 false。
 */
export interface ToolPermissionAsk {
  toolName: string;
  /** 操作分类：write/edit/patch/delete/command/read-sensitive。 */
  op: string;
  target: string;
  summary: string;
  diff?: string;
  permanentlyAllowable: boolean;
}

/** ask() 的返回：允许或拒绝（拒绝时工具应返回 PERMISSION_DENIED 结果反馈模型）。 */
export type PermissionOutcome = "allowed" | "denied";

/**
 * 一次工具执行的完整上下文。
 *
 * - signal：合并了请求截止时间与单工具超时的 AbortSignal；
 * - origin/callId/runId：执行来源与调用标识，供授权、SSE 与定时任务闭环使用；
 * - ask()：需要授权的操作（写入/编辑/补丁/删除/终端命令/敏感读取）必须先
 *   await ask(...)，得到 allowed 后才能动盘；denied 时返回结构化错误结果而非
 *   继续副作用。服务端在「离屏挂起」模式（定时任务等待用户决定）下，ask 会
 *   在登记请求并通知挂起后抛出 PermissionPendingError（控制流异常，非工具失败）。
 */
export interface ToolExecutionContext {
  signal?: AbortSignal;
  origin: "chat" | "scheduled_task" | "manual" | "test";
  callId?: string;
  runId?: string;
  ask(ask: ToolPermissionAsk): Promise<PermissionOutcome>;
}

/**
 * Agent 可执行工具的最小契约。
 *
 * 工具负责声明输入约束并执行已经校验过的参数；注册表负责查找、统一校验、
 * 中断检查和错误归一化，避免每个调用方重复实现这些横切逻辑。
 * 中断信号从执行上下文的 ctx.signal 读取；需要授权的操作通过 ctx.ask() 接入授权闭环。
 */
export interface AgentTool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}

/** 注册表需要在同一集合中保存不同输入、输出类型的工具。 */
export type AnyAgentTool = AgentTool<any, unknown>;

/** 缺少授权上下文时，ask 直接拒绝（fail-closed），避免误放行。 */
export const noopAsk = (): Promise<PermissionOutcome> =>
  Promise.resolve("denied");

/** 构造最小可用执行上下文（如单元测试直接调用工具时）：信号可传，授权默认拒绝。 */
export function defaultToolContext(
  signal?: AbortSignal,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  const cleaned: Partial<ToolExecutionContext> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (cleaned as Record<string, unknown>)[key] = value;
    }
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    origin: "test",
    ask: () => Promise.resolve("denied" as const),
    ...cleaned,
  };
}

/**
 * 定时任务「离屏挂起」信号：ctx.ask 在登记请求并通知挂起后抛出。
 * 属于控制流异常（Agent 据此返回 permission_wait 并保存检查点），
 * 不得被当作普通工具失败处理。
 */
export class PermissionPendingError extends Error {
  constructor(message = "工具需要等待授权决定") {
    super(message);
    this.name = "PermissionPendingError";
  }
}
