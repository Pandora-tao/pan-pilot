import { createTerminalTool, type TerminalToolOptions } from "./terminal.js";
import type { ToolExecutionContext } from "./tool.js";

/**
 * HostTerminalService：把终端工具执行逻辑暴露为服务对象，与沙箱 SDK 共用
 * 同一实现与权限策略（命令先经 ctx.ask / 白名单分类）。
 */
export interface HostTerminalService {
  run(
    input: { command: string; cwd?: string; timeoutMs?: number },
    ctx: ToolExecutionContext,
  ): Promise<unknown>;
}

export function createHostTerminalService(
  options: TerminalToolOptions = {},
): HostTerminalService {
  const tool = createTerminalTool(options);
  return {
    run: (input, ctx) => tool.execute(input, ctx),
  };
}
