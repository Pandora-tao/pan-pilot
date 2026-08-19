import type { CallToolResult, Client, Tool } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTool } from "../tools/tool.js";

const MAX_MCP_RESULT_BYTES = 1024 * 1024;

export class McpToolCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolCallError";
  }
}

export function createMcpTool(
  serverName: string,
  tool: Tool,
  client: Pick<Client, "callTool">,
  timeoutMs: number,
): AgentTool<Record<string, unknown>, unknown> {
  const publicName = mcpToolName(serverName, tool.name);
  const inputSchema = parseInputSchema(serverName, tool);
  return {
    name: publicName,
    description: (`[MCP:${serverName}] ${tool.description?.trim() || tool.name}`).slice(0, 2000),
    inputSchema,
    async execute(input, ctx) {
      const signal = ctx.signal;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);
      let result: CallToolResult;
      try {
        result = await client.callTool(
          { name: tool.name, arguments: input },
          { signal: combinedSignal, toolDefinition: tool },
        );
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (timeoutSignal.aborted) {
          throw new McpToolCallError(`MCP 工具 ${publicName} 执行超时`);
        }
        throw new McpToolCallError(`MCP 工具 ${publicName} 调用失败`);
      }
      if (result.isError) {
        throw new McpToolCallError(`MCP 工具 ${publicName} 返回错误`);
      }
      assertResultSize(publicName, result);
      return result;
    },
  };
}

export function mcpToolName(serverName: string, remoteName: string): string {
  const normalized = remoteName.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) {
    throw new Error(`MCP Server ${serverName} 返回了不支持的工具名`);
  }
  const prefix = `mcp__${serverName}__`;
  if (prefix.length + normalized.length <= 64) return prefix + normalized;
  const hash = createHash("sha256").update(remoteName).digest("hex").slice(0, 8);
  const available = 64 - prefix.length - hash.length - 1;
  if (available < 1) throw new Error(`MCP Server ${serverName} 名称过长`);
  return `${prefix}${normalized.slice(0, available)}_${hash}`;
}

function parseInputSchema(
  serverName: string,
  tool: Tool,
): z.ZodType<Record<string, unknown>> {
  if (tool.inputSchema.type !== "object") {
    throw new Error(`MCP Server ${serverName} 的工具 ${tool.name} inputSchema 不是 object`);
  }
  try {
    return z.fromJSONSchema(
      tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
    ) as z.ZodType<Record<string, unknown>>;
  } catch {
    throw new Error(`MCP Server ${serverName} 的工具 ${tool.name} inputSchema 不受支持`);
  }
}

function assertResultSize(toolName: string, result: CallToolResult): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new McpToolCallError(`MCP 工具 ${toolName} 返回了不可序列化的结果`);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_RESULT_BYTES) {
    throw new McpToolCallError(`MCP 工具 ${toolName} 结果超过 1MB 上限`);
  }
}
