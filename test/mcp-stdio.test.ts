import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

describe("MCP stdio transport", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("spawns a real MCP child process and exposes its tool to ChatAgent", async () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/mcp-stdio-server.mjs",
    );
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "stdio-call",
          name: "mcp__local__echo",
          arguments: { text: "hello" },
        }],
        model: "test",
      })
      .mockImplementationOnce(async (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: expect.stringContaining("stdio:hello"),
        });
        return { content: "stdio works", toolCalls: [], model: "test" };
      });
    const app = buildApp({
      modelClient: modelClient(complete),
      apiToken: "secret",
      mcpConfig: {
        version: 1,
        servers: {
          local: {
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            timeoutMs: 10_000,
          },
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: { message: "echo hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ message: "stdio works" });
  });
});

function modelClient(complete: ModelClient["complete"]): ModelClient {
  return { complete, async *completeStream() { throw new Error("unused"); } };
}
