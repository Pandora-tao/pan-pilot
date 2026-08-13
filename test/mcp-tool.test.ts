import { describe, expect, it, vi } from "vitest";
import type { Client, Tool } from "@modelcontextprotocol/client";
import { createMcpTool, mcpToolName } from "../src/mcp/mcp-tool.js";

describe("MCP tool adapter", () => {
  const definition: Tool = {
    name: "echo",
    description: "echo",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };

  it("validates arguments locally before tools/call", async () => {
    const callTool = vi.fn<Pick<Client, "callTool">["callTool"]>();
    const tool = createMcpTool("demo", definition, { callTool }, 1000);
    await expect(tool.inputSchema.parseAsync({ text: 42 })).rejects.toBeTruthy();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("treats MCP isError results as tool failures", async () => {
    const callTool = vi.fn<Pick<Client, "callTool">["callTool"]>().mockResolvedValue({
      content: [{ type: "text", text: "private server error" }],
      isError: true,
    });
    const tool = createMcpTool("demo", definition, { callTool }, 1000);
    await expect(tool.execute({ text: "hello" })).rejects.toThrow(/返回错误/);
  });

  it("rejects MCP results larger than one megabyte", async () => {
    const callTool = vi.fn<Pick<Client, "callTool">["callTool"]>().mockResolvedValue({
      content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
    });
    const tool = createMcpTool("demo", definition, { callTool }, 1000);
    await expect(tool.execute({ text: "hello" })).rejects.toThrow(/1MB/);
  });

  it("produces deterministic provider-safe names no longer than 64 characters", () => {
    const name = mcpToolName("business", "a very long tool name ".repeat(10));
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^mcp__business__[a-zA-Z0-9_-]+$/);
    expect(mcpToolName("business", "a very long tool name ".repeat(10))).toBe(name);
  });
});
