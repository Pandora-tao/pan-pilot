import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import { PluginService } from "../src/plugins/plugin-service.js";
import { PluginOperationError } from "../src/plugins/plugin-operation-error.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  createPluginFixture,
  createTestEchoTool,
  httpManifest,
  removePluginFixture,
} from "./helpers/plugin-fixture.js";

let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot) {
    removePluginFixture(fixtureRoot);
    fixtureRoot = "";
  }
});

const reservedNames = new Set(["fs_write", "fs_read", "terminal"]);

function builtinManifest(name: string, ref = "echo"): Record<string, unknown> {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 测试工具`,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    executor: { type: "builtin", ref },
  };
}

describe("核心 HostRuntime 工具名保护", () => {
  it("插件加载拒绝名为 fs_*/terminal 的插件（不可遮蔽核心工具）", () => {
    fixtureRoot = createPluginFixture({
      terminal: builtinManifest("terminal"),
      fs_write: httpManifest("fs_write", "https://api.example.com/w"),
      ok_plugin: builtinManifest("ok_plugin"),
    });
    const registry = new ToolRegistry();
    const manager = new PluginManager({
      pluginsDir: fixtureRoot,
      builtinTools: [createTestEchoTool()],
      registry,
      reservedNames,
    });
    manager.loadInitial();

    const statuses = manager.listStatuses();
    expect(statuses.find((s) => s.name === "terminal")).toMatchObject({
      state: "error",
      error: expect.stringContaining("核心 HostRuntime 工具冲突"),
    });
    expect(statuses.find((s) => s.name === "fs_write")).toMatchObject({
      state: "error",
      error: expect.stringContaining("核心 HostRuntime 工具冲突"),
    });
    expect(statuses.find((s) => s.name === "ok_plugin")).toMatchObject({
      state: "loaded",
    });
  });

  it("插件安装拒绝使用核心工具名", async () => {
    fixtureRoot = createPluginFixture({});
    const registry = new ToolRegistry();
    const manager = new PluginManager({
      pluginsDir: fixtureRoot,
      builtinTools: [createTestEchoTool()],
      registry,
      reservedNames,
    });
    manager.loadInitial();
    const service = new PluginService({
      manager,
      builtinTools: [createTestEchoTool()],
      reservedNames,
    });

    expect(() => service.suggest(builtinManifest("terminal")))
      .toThrow(PluginOperationError);
    expect(() => service.install(builtinManifest("fs_read")))
      .toThrow(PluginOperationError);
    expect(() => service.install(builtinManifest("normal_plugin")))
      .not.toThrow();
  });

  it("禁用/重载插件不会影响核心注册表内容", () => {
    fixtureRoot = createPluginFixture({
      alpha: builtinManifest("alpha"),
    });
    const registry = new ToolRegistry();
    // 核心 HostRuntime 工具被系统以 registerCore 注册（此处用 echo 充当）。
    registry.registerCore(createTestEchoTool());
    const manager = new PluginManager({
      pluginsDir: fixtureRoot,
      builtinTools: [createTestEchoTool()],
      registry,
      reservedNames,
    });
    manager.loadInitial();
    expect(registry.listNames()).toContain("echo");

    manager.setEnabled("alpha", false);
    expect(registry.listNames()).toContain("echo");
    manager.reload();
    expect(registry.listNames()).toContain("echo");
  });
});
