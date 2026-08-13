import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

serveStdio(() => {
  const server = new McpServer(
    { name: "panpilot-test-stdio", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.registerTool("echo", {
    description: "Echo text from a real stdio child process",
    inputSchema: z.object({ text: z.string() }),
  }, async ({ text }) => ({
    content: [{ type: "text", text: `stdio:${text}` }],
  }));
  return server;
});
