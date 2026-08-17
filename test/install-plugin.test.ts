import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";
import {
  createPluginFixture,
  httpManifest,
  removePluginFixture,
} from "./helpers/plugin-fixture.js";

let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot) removePluginFixture(fixtureRoot);
  fixtureRoot = "";
});

/** install_plugin 的 builtin 自引用 manifest：工具经插件注册表暴露给 Agent。 */
function installPluginManifest(): Record<string, unknown> {
  return {
    apiVersion: "v1",
    name: "install_plugin",
    description: "Agent 自主安装工具",
    parameters: {
      type: "object",
      properties: { manifest: { type: "object" } },
      required: ["manifest"],
      additionalProperties: false,
    },
    executor: { type: "builtin", ref: "install_plugin" },
  };
}

function builtinAliasManifest(name: string, ref: string): Record<string, unknown> {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 测试工具`,
    parameters: {
      type: "object",
      properties: { operation: { type: "string" } },
      required: ["operation"],
      additionalProperties: false,
    },
    executor: { type: "builtin", ref },
  };
}

function fakeModelClient(complete: ModelClient["complete"]): ModelClient {
  return { complete, completeStream: vi.fn() };
}

describe("Agent self-install (install_plugin)", () => {
  it("exposes the tool but rejects calls when auto-install is off", async () => {
    fixtureRoot = createPluginFixture({ install_plugin: installPluginManifest() });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "install-1",
          name: "install_plugin",
          arguments: { manifest: builtinAliasManifest("calc_alias", "calculator") },
        }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "自主安装未启用，请管理员开启后重试。",
        toolCalls: [],
        model: "test-model",
      });
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      pluginsDir: fixtureRoot,
    });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "帮我安装一个计算插件" },
    });
    expect(chat.statusCode).toBe(200);

    // 工具始终对模型可见（自引用插件已加载）。
    expect(complete.mock.calls[0]![0].tools.map((tool) => tool.name))
      .toContain("install_plugin");
    // 调用被拒绝：摘要为 error，错误原因回填模型。
    const payload = chat.json<{
      execution: { toolExecutions: Array<{ name: string; status: string }> };
    }>();
    expect(payload.execution.toolExecutions).toEqual([
      expect.objectContaining({ name: "install_plugin", status: "error" }),
    ]);
    const toolMessage = complete.mock.calls[1]![0].messages
      .find((message) => message.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain("PAN_PILOT_PLUGIN_AUTO_INSTALL");
    // 没有任何落盘副作用。
    const list = await app.inject({ method: "GET", url: "/v1/plugins" });
    expect(list.json().plugins.map((item: { name: string }) => item.name))
      .toEqual(["install_plugin"]);
    await app.close();
  });

  it("installs a valid manifest when auto-install is enabled", async () => {
    fixtureRoot = createPluginFixture({ install_plugin: installPluginManifest() });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "install-1",
          name: "install_plugin",
          arguments: { manifest: builtinAliasManifest("calc_alias", "calculator") },
        }],
        model: "test-model",
      })
      .mockImplementationOnce(async (request) => {
        const toolMessage = request.messages.find((message) => message.role === "tool");
        const result = JSON.parse(toolMessage?.content ?? "{}") as {
          installed?: { name: string; state: string; enabled: boolean };
        };
        return {
          content: `已安装 ${result.installed?.name}（${result.installed?.state}）`,
          toolCalls: [],
          model: "test-model",
        };
      });
    const app = buildApp({
      pluginAutoInstall: true,
      modelClient: fakeModelClient(complete),
      pluginsDir: fixtureRoot,
    });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "帮我安装一个计算插件" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().message).toBe("已安装 calc_alias（loaded）");
    expect(chat.json().execution.toolExecutions).toEqual([
      expect.objectContaining({ name: "install_plugin", status: "success" }),
    ]);

    const list = await app.inject({ method: "GET", url: "/v1/plugins" });
    expect(list.json().plugins).toEqual([
      expect.objectContaining({ name: "calc_alias", state: "loaded", enabled: true }),
      expect.objectContaining({ name: "install_plugin", state: "loaded" }),
    ]);
    await app.close();
  });

  it("fails conflicting installs and keeps the registry unchanged", async () => {
    fixtureRoot = createPluginFixture({
      install_plugin: installPluginManifest(),
      ping: httpManifest("ping", "https://api.example.com/ping"),
    });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "install-1",
          name: "install_plugin",
          arguments: { manifest: httpManifest("ping", "https://api.example.com/other") },
        }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "安装失败，同名插件已存在。",
        toolCalls: [],
        model: "test-model",
      });
    const app = buildApp({
      pluginAutoInstall: true,
      modelClient: fakeModelClient(complete),
      pluginsDir: fixtureRoot,
      pluginAllowedHosts: "api.example.com",
    });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "安装一个冲突插件" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().execution.toolExecutions).toEqual([
      expect.objectContaining({ name: "install_plugin", status: "error" }),
    ]);
    const toolMessage = complete.mock.calls[1]![0].messages
      .find((message) => message.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain("同名插件 ping 已安装");

    // 原插件未被替换，注册表保持原状。
    const list = await app.inject({ method: "GET", url: "/v1/plugins" });
    expect(list.json().plugins.map((item: { name: string }) => item.name).sort())
      .toEqual(["install_plugin", "ping"]);
    expect(list.json().plugins.find((item: { name: string }) => item.name === "ping"))
      .toMatchObject({ state: "loaded", toolNames: ["ping"] });
    await app.close();
  });

  it("declares agentInstall capability per switch", async () => {
    fixtureRoot = createPluginFixture({});
    const off = buildApp({
      modelClient: fakeModelClient(vi.fn<ModelClient["complete"]>()),
      pluginsDir: fixtureRoot,
    });
    const offResponse = await off.inject({ method: "GET", url: "/v1/capabilities" });
    expect(offResponse.json().capabilities.plugins.agentInstall)
      .toEqual({ status: "reserved" });

    const on = buildApp({
      pluginAutoInstall: true,
      modelClient: fakeModelClient(vi.fn<ModelClient["complete"]>()),
      pluginsDir: fixtureRoot,
    });
    const onResponse = await on.inject({ method: "GET", url: "/v1/capabilities" });
    expect(onResponse.json().capabilities.plugins.agentInstall)
      .toEqual({ status: "available" });

    await off.close();
    await on.close();
  });
});
