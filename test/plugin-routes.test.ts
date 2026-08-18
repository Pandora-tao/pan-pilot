import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";
import {
  createPluginFixture,
  httpManifest,
  removePluginFixture,
} from "./helpers/plugin-fixture.js";

const AUTH = { authorization: "Bearer test-secret" };
let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot) removePluginFixture(fixtureRoot);
  fixtureRoot = "";
});

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

function dummyModelClient(): ModelClient {
  return { complete: vi.fn(), completeStream: vi.fn() } as ModelClient;
}

function fakeModelClient(complete: ModelClient["complete"]): ModelClient {
  return { complete, completeStream: vi.fn() };
}

describe("/v1/plugins direct user management", () => {
  it("requires the bearer token when configured", async () => {
    fixtureRoot = createPluginFixture({});
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
    });

    const response = await app.inject({ method: "GET", url: "/v1/plugins" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("installs a valid manifest directly and exposes the plugin", async () => {
    fixtureRoot = createPluginFixture({});
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
    });

    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins/install",
      headers: AUTH,
      payload: { manifest: builtinAliasManifest("calc_alias", "calculator") },
    });

    expect(install.statusCode).toBe(201);
    expect(install.json().result).toMatchObject({
      applied: true,
      plugins: [expect.objectContaining({ name: "calc_alias", state: "loaded" })],
    });
    const list = await app.inject({ method: "GET", url: "/v1/plugins", headers: AUTH });
    expect(list.json().plugins).toEqual([
      expect.objectContaining({
        name: "calc_alias",
        enabled: true,
        description: "calc_alias 测试工具",
        executorType: "builtin",
      }),
    ]);
    await app.close();
  });

  it("rejects invalid or conflicting installs without replacing the registry", async () => {
    fixtureRoot = createPluginFixture({
      ping: httpManifest("ping", "https://api.example.com/ping"),
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
      pluginAllowedHosts: "api.example.com",
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/plugins/install",
      headers: AUTH,
      payload: { manifest: httpManifest("ping", "https://api.example.com/other") },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "PLUGIN_CONFLICT" });

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/plugins/install",
      headers: AUTH,
      payload: { manifest: httpManifest("bad", "http://api.example.com/insecure") },
    });
    expect(invalid.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", url: "/v1/plugins", headers: AUTH });
    expect(list.json().plugins.map((item: { name: string }) => item.name)).toEqual(["ping"]);
    await app.close();
  });

  it("reloads directly and atomically keeps the old registry on failure", async () => {
    fixtureRoot = createPluginFixture({
      ping: httpManifest("ping", "https://api.example.com/ping"),
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
      pluginAllowedHosts: "api.example.com",
    });

    mkdirSync(path.join(fixtureRoot, "calc_alias"));
    writeFileSync(
      path.join(fixtureRoot, "calc_alias", "manifest.json"),
      JSON.stringify(builtinAliasManifest("calc_alias", "calculator")),
    );
    const reload = await app.inject({
      method: "POST",
      url: "/v1/plugins/reload",
      headers: AUTH,
    });
    expect(reload.statusCode).toBe(200);
    expect(reload.json().result.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "calc_alias" }),
      expect.objectContaining({ name: "ping" }),
    ]));

    mkdirSync(path.join(fixtureRoot, "broken"));
    writeFileSync(path.join(fixtureRoot, "broken", "manifest.json"), "{ oops");
    const failed = await app.inject({
      method: "POST",
      url: "/v1/plugins/reload",
      headers: AUTH,
    });
    expect(failed.statusCode).toBe(500);
    const list = await app.inject({ method: "GET", url: "/v1/plugins", headers: AUTH });
    expect(list.json().plugins.map((item: { name: string }) => item.name))
      .toEqual(["calc_alias", "ping"]);
    await app.close();
  });

  it("enables and disables installed plugins directly", async () => {
    fixtureRoot = createPluginFixture({
      calc_alias: builtinAliasManifest("calc_alias", "calculator"),
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
    });

    const disabled = await app.inject({
      method: "POST",
      url: "/v1/plugins/calc_alias/disable",
      headers: AUTH,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().plugin).toMatchObject({ state: "disabled", enabled: false });

    // 模拟进程重启重新装配：disabled 已写回 manifest，不能恢复为默认启用。
    await app.close();
    const restarted = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
    });
    const afterRestart = await restarted.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(afterRestart.json().plugins).toEqual([
      expect.objectContaining({ name: "calc_alias", state: "disabled", enabled: false }),
    ]);

    const enabled = await restarted.inject({
      method: "POST",
      url: "/v1/plugins/calc_alias/enable",
      headers: AUTH,
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().plugin).toMatchObject({ state: "loaded", enabled: true });
    await restarted.close();
  });

  it("installs or dismisses Agent suggestions selected by the user", async () => {
    const suggestedManifest = builtinAliasManifest("calc_alias", "calculator");
    fixtureRoot = createPluginFixture({
      suggest_plugin: {
        apiVersion: "v1",
        name: "suggest_plugin",
        description: "推荐插件",
        parameters: {
          type: "object",
          properties: { manifest: { type: "object" } },
          required: ["manifest"],
          additionalProperties: false,
        },
        executor: { type: "builtin", ref: "suggest_plugin" },
      },
    });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "suggest-1",
          name: "suggest_plugin",
          arguments: { manifest: suggestedManifest },
        }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "已把插件加入待安装列表，请由你决定是否安装。",
        toolCalls: [],
        model: "test-model",
      });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: fakeModelClient(complete),
      pluginsDir: fixtureRoot,
    });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "推荐一个计算插件" },
    });
    expect(chat.statusCode).toBe(200);

    const suggestions = await app.inject({
      method: "GET",
      url: "/v1/plugins/suggestions",
      headers: AUTH,
    });
    expect(suggestions.statusCode).toBe(200);
    const suggestion = suggestions.json().suggestions[0];
    expect(suggestion).toMatchObject({
      preview: { pluginName: "calc_alias", executorType: "builtin" },
    });

    const installed = await app.inject({
      method: "POST",
      url: `/v1/plugins/suggestions/${suggestion.id}/install`,
      headers: AUTH,
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json().result.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "calc_alias", state: "loaded" }),
    ]));
    await app.close();
  });

  it("allows plugin mutations without a token when auth is not configured", async () => {
    fixtureRoot = createPluginFixture({});
    const app = buildApp({
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
    });

    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins/install",
      payload: { manifest: builtinAliasManifest("calc_alias", "calculator") },
    });
    expect(install.statusCode).toBe(201);
    expect(install.json().result).toMatchObject({ applied: true });

    const reload = await app.inject({ method: "POST", url: "/v1/plugins/reload" });
    expect(reload.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/plugins" });
    expect(list.json().plugins).toEqual([
      expect.objectContaining({ name: "calc_alias", state: "loaded" }),
    ]);
    await app.close();
  });
});
