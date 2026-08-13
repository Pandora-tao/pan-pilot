import { Client, InMemoryTransport, type Transport } from "@modelcontextprotocol/client";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

describe("MCP tool protocol integration", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const servers: McpServer[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
  });

  it("discovers namespaced tools and runs them through the real ChatAgent loop", async () => {
    const server = mcpServer();
    server.registerTool("sum", {
      description: "计算两个数字之和",
      inputSchema: z.object({ left: z.number(), right: z.number() }),
    }, async ({ left, right }) => ({
      content: [{ type: "text", text: String(left + right) }],
      structuredContent: { value: left + right },
    }));
    const transportFactory = connectServer(server);
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "mcp-1", name: "mcp__math__sum", arguments: { left: 20, right: 22 } }],
        model: "test",
      })
      .mockImplementationOnce(async (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          name: "mcp__math__sum",
          content: expect.stringContaining("42"),
        });
        return { content: "结果是 42", toolCalls: [], model: "test" };
      });
    const app = buildApp({
      modelClient: modelClient(complete),
      apiToken: "secret",
      mcpConfig: { version: 1, servers: { math: { transport: "stdio", command: "unused" } } },
      mcpTransportFactory: transportFactory,
    });
    apps.push(app);

    const status = await app.inject({
      method: "GET", url: "/v1/mcp/servers",
      headers: { authorization: "Bearer secret" },
    });
    expect(status.json()).toMatchObject({ servers: [{ name: "math", state: "connected", toolNames: ["mcp__math__sum"] }] });
    expect(JSON.stringify(status.json())).not.toContain("unused");

    const chat = await app.inject({
      method: "POST", url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { message: "计算 20+22" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      message: "结果是 42",
      execution: { toolExecutions: [{ id: "mcp-1", name: "mcp__math__sum", status: "success" }] },
    });
  });

  it("isolates a broken server and keeps healthy MCP tools available", async () => {
    const healthy = mcpServer();
    healthy.registerTool("ping", { inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await healthy.connect(serverTransport);
    servers.push(healthy);
    const app = buildApp({
      modelClient: modelClient(vi.fn()),
      apiToken: "secret",
      mcpConfig: {
        version: 1,
        servers: {
          broken: { transport: "stdio", command: "unused" },
          healthy: { transport: "stdio", command: "unused" },
        },
      },
      mcpTransportFactory: (name) => name === "healthy" ? clientTransport : failingTransport(),
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/mcp/servers", headers: { authorization: "Bearer secret" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "broken", state: "error", toolNames: [] }),
      expect.objectContaining({ name: "healthy", state: "connected", toolNames: ["mcp__healthy__ping"] }),
    ]));
  });

  it("does not connect MCP servers when PanPilot auth is not configured", async () => {
    const transportFactory = vi.fn(() => failingTransport());
    const app = buildApp({
      modelClient: modelClient(vi.fn()),
      mcpConfig: { version: 1, servers: { external: { transport: "stdio", command: "secret-command" } } },
      mcpTransportFactory: transportFactory,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/mcp/servers" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "AUTH_NOT_CONFIGURED" });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("keeps chat available when the MCP config file is corrupt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "panpilot-bad-mcp-"));
    const configPath = path.join(dir, "mcp.json");
    writeFileSync(configPath, "{broken");
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "chat still works", toolCalls: [], model: "test",
    });
    const app = buildApp({
      modelClient: modelClient(complete),
      apiToken: "secret",
      mcpConfigPath: configPath,
    });
    apps.push(app);
    const mcp = await app.inject({ method: "GET", url: "/v1/mcp/servers", headers: { authorization: "Bearer secret" } });
    expect(mcp.statusCode).toBe(503);
    expect(mcp.json()).toMatchObject({ error: "MCP_CONFIG_UNAVAILABLE" });
    const chat = await app.inject({ method: "POST", url: "/v1/chat", headers: { authorization: "Bearer secret" }, payload: { message: "hello" } });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({ message: "chat still works" });
  });

  it("refreshes the registered tools after tools/list_changed", async () => {
    const server = mcpServer();
    server.registerTool("first", { inputSchema: z.object({}) }, async () => ({ content: [] }));
    const transportFactory = connectServer(server);
    const app = buildApp({
      modelClient: modelClient(vi.fn()),
      apiToken: "secret",
      mcpConfig: { version: 1, servers: { dynamic: { transport: "stdio", command: "unused" } } },
      mcpTransportFactory: transportFactory,
    });
    apps.push(app);
    await app.ready();
    server.registerTool("second", { inputSchema: z.object({}) }, async () => ({ content: [] }));
    server.sendToolListChanged();
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: "/v1/mcp/servers", headers: { authorization: "Bearer secret" } });
      expect(response.json().servers[0].toolNames).toEqual([
        "mcp__dynamic__first",
        "mcp__dynamic__second",
      ]);
    });
  });

  it("propagates AbortSignal cancellation to MCP tools", async () => {
    const server = mcpServer();
    let aborted = false;
    let serverStarted = false;
    server.registerTool("wait", { inputSchema: z.object({}) }, async (_input, context) => {
      serverStarted = true;
      await new Promise<void>((_resolve, reject) => {
        context.mcpReq.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        }, { once: true });
      });
      return { content: [] };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    servers.push(server);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    const controller = new AbortController();
    const pending = client.callTool({ name: "wait", arguments: {} }, { signal: controller.signal });
    await vi.waitFor(() => expect(serverStarted).toBe(true));
    controller.abort();
    await expect(pending).rejects.toBeTruthy();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await client.close();
  });
});

function mcpServer(): McpServer {
  return new McpServer({ name: "test-server", version: "1.0.0" }, {
    capabilities: { tools: { listChanged: true } },
  });
}

function connectServer(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return () => clientTransport;
}

function failingTransport(): Transport {
  return {
    async start() { throw new Error("connection refused"); },
    async send() {},
    async close() {},
  };
}

function modelClient(complete: ModelClient["complete"]): ModelClient {
  return { complete, async *completeStream() { throw new Error("unused"); } };
}
