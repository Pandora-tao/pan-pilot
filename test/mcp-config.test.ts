import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpConfig, mcpConfigSchema, resolveConfigValue } from "../src/mcp/mcp-config.js";

describe("MCP config", () => {
  it("loads strict versioned stdio and Streamable HTTP config", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "panpilot-mcp-config-"));
    const file = path.join(dir, "mcp.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      servers: {
        local: { transport: "stdio", command: "node", args: ["server.js"] },
        remote: { transport: "streamableHttp", url: "https://mcp.example.com/api" },
      },
    }));
    expect(Object.keys(loadMcpConfig(file).servers)).toEqual(["local", "remote"]);
  });

  it("allows loopback HTTP but rejects insecure remote HTTP and unknown fields", () => {
    expect(mcpConfigSchema.safeParse({ version: 1, servers: { local: { transport: "streamableHttp", url: "http://127.0.0.1:3001/mcp" } } }).success).toBe(true);
    expect(mcpConfigSchema.safeParse({ version: 1, servers: { remote: { transport: "streamableHttp", url: "http://example.com/mcp" } } }).success).toBe(false);
    expect(mcpConfigSchema.safeParse({ version: 1, servers: { remote: { transport: "streamableHttp", url: "https://user:pass@example.com/mcp" } } }).success).toBe(false);
    expect(mcpConfigSchema.safeParse({ version: 1, servers: { remote: { transport: "streamableHttp", url: "https://example.com/mcp", headers: { Host: "other.example.com" } } } }).success).toBe(false);
    expect(mcpConfigSchema.safeParse({ version: 1, servers: {}, extra: true }).success).toBe(false);
  });

  it("resolves only explicit environment references", () => {
    expect(resolveConfigValue("Bearer ${env:TOKEN}", { TOKEN: "secret" })).toBe("Bearer secret");
    expect(() => resolveConfigValue("${env:MISSING}", {})).toThrow(/MISSING/);
  });
});
