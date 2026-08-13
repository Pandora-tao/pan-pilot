import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

describe("MCP Streamable HTTP transport", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const handlers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(handlers.splice(0).map((handler) => handler.close()));
  });

  it("uses official Streamable HTTP negotiation and injects configured headers", async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer(
        { name: "http-test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.registerTool("hello", {
        inputSchema: z.object({ name: z.string() }),
      }, async ({ name }) => ({ content: [{ type: "text", text: `hello ${name}` }] }));
      return server;
    });
    handlers.push(handler);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      return handler.fetch(request);
    });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "http-call", name: "mcp__remote__hello", arguments: { name: "Pan" } }],
        model: "test",
      })
      .mockImplementationOnce(async (request) => {
        expect(request.messages.at(-1)?.content).toContain("hello Pan");
        return { content: "HTTP MCP works", toolCalls: [], model: "test" };
      });
    const app = buildApp({
      modelClient: modelClient(complete),
      apiToken: "secret",
      mcpConfig: {
        version: 1,
        servers: {
          remote: {
            transport: "streamableHttp",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "Bearer ${env:MCP_HTTP_TOKEN}" },
          },
        },
      },
      mcpFetchImpl: fetchImpl,
      mcpEnv: { MCP_HTTP_TOKEN: "test-token" },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { message: "say hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "HTTP MCP works" });
    expect(fetchImpl).toHaveBeenCalled();
  });
});

function modelClient(complete: ModelClient["complete"]): ModelClient {
  return { complete, async *completeStream() { throw new Error("unused"); } };
}
