import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { PluginManager } from "../src/plugins/plugin-manager.js";
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

function createManager(extra = {}) {
  const registry = new ToolRegistry();
  const manager = new PluginManager({
    pluginsDir: fixtureRoot,
    builtinTools: [createTestEchoTool()],
    registry,
    allowedHosts: ["api.example.com"],
    ...extra,
  });
  manager.loadInitial();
  return { registry, manager };
}

function registeredNames(registry: ToolRegistry): string[] {
  return registry.listDefinitions().map((definition) => definition.name);
}

describe("PluginManager", () => {
  it("loads good plugins at startup and reports bad ones as errors", () => {
    fixtureRoot = createPluginFixture({
      alpha: builtinManifest("alpha"),
      brokenjson: "{ 不是 JSON",
      missing_ref: builtinManifest("missing_ref", "nope"),
    });

    const { registry, manager } = createManager();

    expect(registeredNames(registry)).toEqual(["alpha"]);
    expect(manager.listStatuses()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "alpha", state: "loaded", enabled: true }),
      expect.objectContaining({
        name: "brokenjson",
        state: "error",
        error: expect.stringContaining("不是合法 JSON"),
      }),
      expect.objectContaining({
        name: "missing_ref",
        state: "error",
        error: expect.stringContaining("builtin 引用 nope 不存在"),
      }),
    ]));
  });

  it("keeps the old registry when a reload contains any failing plugin", () => {
    fixtureRoot = createPluginFixture({ alpha: builtinManifest("alpha") });
    const { registry, manager } = createManager();
    expect(registeredNames(registry)).toEqual(["alpha"]);

    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify(builtinManifest("beta"), null, 2),
    );
    mkdirSync(path.join(fixtureRoot, "bad-schema"));
    writeFileSync(
      path.join(fixtureRoot, "bad-schema", "manifest.json"),
      "{ 不是 JSON",
    );

    const result = manager.reload();

    expect(result.applied).toBe(false);
    expect(result.statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "beta", state: "loaded" }),
      expect.objectContaining({ name: "bad-schema", state: "error" }),
    ]));
    // 旧注册表保留：只有 alpha 仍然可用。
    expect(registeredNames(registry)).toEqual(["alpha"]);
  });

  it("applies a successful reload and picks up new plugins", () => {
    fixtureRoot = createPluginFixture({ alpha: builtinManifest("alpha") });
    const { registry, manager } = createManager();

    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify(builtinManifest("beta"), null, 2),
    );

    const result = manager.reload();

    expect(result.applied).toBe(true);
    expect(registeredNames(registry)).toEqual(["alpha", "beta"]);
    expect(manager.listStatuses().every((s) => s.state === "loaded")).toBe(true);
  });

  it("disable removes the tool from the model-visible registry and enable restores it", async () => {
    fixtureRoot = createPluginFixture({
      alpha: builtinManifest("alpha"),
      beta: builtinManifest("beta"),
    });
    const { registry, manager } = createManager();

    const disabled = manager.setEnabled("alpha", false);
    expect(disabled).toMatchObject({ name: "alpha", state: "disabled" });
    expect(registeredNames(registry)).toEqual(["beta"]);
    await expect(registry.execute("alpha", { value: "x" }))
      .rejects.toMatchObject({ code: "UNKNOWN_TOOL", toolName: "alpha" });

    const enabled = manager.setEnabled("alpha", true);
    expect(enabled).toMatchObject({ name: "alpha", state: "loaded" });
    expect(registeredNames(registry)).toEqual(["alpha", "beta"]);
  });

  it("rejects duplicate plugin names and shadowing builtin names", () => {
    fixtureRoot = createPluginFixture({
      alpha: builtinManifest("alpha"),
      alpha2: { ...builtinManifest("alpha") },
      echo: httpManifest("echo", "https://api.example.com/x"),
    });
    const { registry, manager } = createManager();

    expect(registeredNames(registry)).toEqual(["alpha"]);
    const statuses = manager.listStatuses();
    expect(statuses.find((s) => s.name === "alpha2")).toMatchObject({
      state: "error",
      error: expect.stringContaining("manifest.name 必须是 alpha2"),
    });
    expect(statuses.find((s) => s.name === "echo")).toMatchObject({
      state: "error",
      error: expect.stringContaining("与内置工具冲突"),
    });
  });

  it("allows the standard builtin self-reference migration shape", () => {
    fixtureRoot = createPluginFixture({
      echo: builtinManifest("echo", "echo"),
    });
    const { registry, manager } = createManager();

    expect(registeredNames(registry)).toEqual(["echo"]);
    expect(manager.listStatuses()[0]).toMatchObject({
      name: "echo",
      state: "loaded",
    });
  });
});
