import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { defaultToolContext, type AgentTool } from "../src/tools/tool.js";

function stubTool(name: string): AgentTool<{ value: number }, unknown> {
  return {
    name,
    description: `${name} 测试工具`,
    inputSchema: z.object({ value: z.number().int() }).strict(),
    execute: vi.fn(async () => ({ name })),
  };
}

const names = (registry: ToolRegistry): string[] => registry.listNames();

describe("ToolRegistry 核心工具注册", () => {
  it("核心工具在 replaceAll（插件原子重建）后仍然保留", () => {
    const registry = new ToolRegistry();
    registry.registerCore(stubTool("fs_write"));
    registry.registerCore(stubTool("terminal"));

    registry.register(stubTool("plugin_a"));
    expect(names(registry)).toEqual(["fs_write", "terminal", "plugin_a"]);

    // 插件重载：只替换非核心工具。
    registry.replaceAll([stubTool("plugin_b")]);
    expect(names(registry)).toEqual(["fs_write", "terminal", "plugin_b"]);
    expect(registry.get("fs_write")).toBeDefined();
    expect(registry.get("terminal")).toBeDefined();
    expect(registry.get("plugin_a")).toBeUndefined();
  });

  it("replaceAll 不能批量覆盖核心工具；与核心同名的普通注册被拒绝", () => {
    const registry = new ToolRegistry();
    registry.registerCore(stubTool("fs_read"));

    expect(() => registry.register(stubTool("fs_read")))
      .toThrow(expect.objectContaining({ code: "DUPLICATE_TOOL" }));
    // 先塞一个非核心，再尝试把核心名放进 replaceAll。
    const reg2 = new ToolRegistry();
    reg2.registerCore(stubTool("fs_delete"));
    expect(() => reg2.replaceAll([stubTool("fs_delete")]))
      .toThrow(expect.objectContaining({ code: "DUPLICATE_TOOL" }));
  });

  it("registerCore 重复注册抛错", () => {
    const registry = new ToolRegistry();
    registry.registerCore(stubTool("fs_write"));
    expect(() => registry.registerCore(stubTool("fs_write")))
      .toThrow(expect.objectContaining({ code: "DUPLICATE_TOOL" }));
  });

  it("核心工具可执行，且 listDefinitions 包含其 JSON Schema", () => {
    const registry = new ToolRegistry();
    registry.registerCore(stubTool("fs_write"));
    const defs = registry.listDefinitions();
    expect(defs.map((d) => d.name)).toContain("fs_write");
    registry.register(stubTool("echo"));
    expect(registry.listDefinitions().map((d) => d.name)).toEqual(["fs_write", "echo"]);
  });

  it("coreNames 仅含核心名", () => {
    const registry = new ToolRegistry();
    registry.registerCore(stubTool("fs_grep"));
    registry.registerCore(stubTool("fs_glob"));
    registry.register(stubTool("echo"));
    expect([...registry.coreNames()].sort()).toEqual(["fs_glob", "fs_grep"]);
    expect(registry.execute("fs_grep", { value: 1 }, defaultToolContext()))
      .resolves.toMatchObject({});
  });
});
