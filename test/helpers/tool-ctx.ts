import {
  defaultToolContext,
  type ToolExecutionContext,
} from "../../src/tools/tool.js";

/**
 * 测试用执行上下文：授权一律放行（模拟服务端对普通操作自动许可 / 用户已批准）。
 * 需要授权工具的单元测试都应使用本上下文，避免误命中 fail-closed。
 */
export function allowContext(signal?: AbortSignal): ToolExecutionContext {
  return defaultToolContext(signal, {
    ask: async () => "allowed" as const,
    origin: "test",
  });
}

/** 测试用执行上下文：授权一律拒绝（验证权限拒绝路径）。 */
export function denyContext(signal?: AbortSignal): ToolExecutionContext {
  return defaultToolContext(signal, {
    ask: async () => "denied" as const,
    origin: "test",
  });
}

/** 记录每次授权请求的可编程授权替身。 */
export function spyAllowContext(
  signal?: AbortSignal,
): { ctx: ToolExecutionContext; asks: Array<{ op: string; target: string; diff?: string }> } {
  const asks: Array<{ op: string; target: string; diff?: string }> = [];
  const ctx = defaultToolContext(signal, {
    ask: async (ask) => {
      asks.push({
        op: ask.op,
        target: ask.target,
        ...(ask.diff === undefined ? {} : { diff: ask.diff }),
      });
      return "allowed" as const;
    },
    origin: "test",
  });
  return { ctx, asks };
}
