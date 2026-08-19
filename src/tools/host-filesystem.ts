import {
  createFilesystemTools,
  type FilesystemToolOptions,
} from "./filesystem.js";
import type { ToolExecutionContext } from "./tool.js";

/**
 * HostFilesystemService：把现有 fs_* 工具的执行逻辑暴露为可按操作调用的服务对象，
 * 核心工具与沙箱 SDK 共用同一实现与权限策略（同一 ctx.ask 闭环）。
 *
 * 本实现直接复用 createFilesystemTools 生成的同一批工具函数，
 * 因此路径解析、adminRoots 守卫、敏感路径过滤、原子写与授权行为完全一致。
 */
export interface HostFilesystemService {
  list(input: { path: string }, ctx: ToolExecutionContext): Promise<unknown>;
  info(input: { path: string }, ctx: ToolExecutionContext): Promise<unknown>;
  read(input: { path: string; offset?: number; limit?: number }, ctx: ToolExecutionContext): Promise<unknown>;
  readBase64(input: { path: string }, ctx: ToolExecutionContext): Promise<unknown>;
  write(
    input: { path: string; content: string; mode?: "write" | "append"; createParents?: boolean },
    ctx: ToolExecutionContext,
  ): Promise<unknown>;
  edit(
    input: { path: string; oldText: string; newText: string; replaceAll?: boolean },
    ctx: ToolExecutionContext,
  ): Promise<unknown>;
  applyPatch(
    input: { patch: { operations: unknown[] } },
    ctx: ToolExecutionContext,
  ): Promise<unknown>;
  delete(input: { path: string; recursive?: boolean }, ctx: ToolExecutionContext): Promise<unknown>;
  glob(input: { pattern: string; path?: string; limit?: number }, ctx: ToolExecutionContext): Promise<unknown>;
  grep(input: { pattern: string; path?: string; include?: string; limit?: number }, ctx: ToolExecutionContext): Promise<unknown>;
}

export function createHostFilesystemService(
  options: FilesystemToolOptions,
): HostFilesystemService {
  const tools = new Map(createFilesystemTools(options).map((tool) => [tool.name, tool]));
  return {
    list: (input, ctx) => tools.get("fs_list")!.execute(input, ctx),
    info: (input, ctx) => tools.get("fs_info")!.execute(input, ctx),
    read: (input, ctx) => tools.get("fs_read")!.execute(input, ctx),
    readBase64: (input, ctx) => tools.get("fs_read_base64")!.execute(input, ctx),
    write: (input, ctx) => tools.get("fs_write")!.execute(input, ctx),
    edit: (input, ctx) => tools.get("fs_edit")!.execute(input, ctx),
    applyPatch: (input, ctx) => tools.get("fs_apply_patch")!.execute(input, ctx),
    delete: (input, ctx) => tools.get("fs_delete")!.execute(input, ctx),
    glob: (input, ctx) => tools.get("fs_glob")!.execute(input, ctx),
    grep: (input, ctx) => tools.get("fs_grep")!.execute(input, ctx),
  };
}
