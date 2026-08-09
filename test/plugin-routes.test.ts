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
  if (fixtureRoot) {
    removePluginFixture(fixtureRoot);
    fixtureRoot = "";
  }
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

function fakeModelClient(
  complete: ModelClient["complete"],
): ModelClient {
  return { complete, completeStream: vi.fn() };
}

/** 不真正走聊天路径的用例只需要一个不会构造真实模型的替身。 */
function dummyModelClient(): ModelClient {
  return { complete: vi.fn(), completeStream: vi.fn() } as ModelClient;
}

/** 审批三步走：用已创建的 approvalId 完成 approve + execute。 */
async function approveAndExecute(
  app: ReturnType<typeof buildApp>,
  approvalId: string,
  hash?: string,
) {
  const approve = await app.inject({
    method: "POST",
    url: `/v1/plugins/approvals/${approvalId}/approve`,
    headers: AUTH,
    payload: hash === undefined ? {} : { hash },
  });
  expect(approve.statusCode).toBe(200);
  const execute = await app.inject({
    method: "POST",
    url: `/v1/plugins/approvals/${approvalId}/execute`,
    headers: AUTH,
    payload: hash === undefined ? {} : { hash },
  });
  return execute;
}

describe("/v1/plugins", () => {
  it("requires the bearer token", async () => {
    fixtureRoot = createPluginFixture({
      ping: httpManifest("ping", "https://api.example.com/ping"),
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
    });

    const response = await app.inject({ method: "GET", url: "/v1/plugins" });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lists plugin statuses with per-plugin errors", async () => {
    fixtureRoot = createPluginFixture({
      ping: httpManifest("ping", "https://api.example.com/ping"),
      broken: "{ 不是 JSON",
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
      pluginAllowedHosts: "api.example.com",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plugins: [
        expect.objectContaining({ name: "broken", state: "error" }),
        expect.objectContaining({ name: "ping", state: "loaded" }),
      ],
    });
    await app.close();
  });

  it("reload goes through approval and applies atomically after execute", async () => {
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
      JSON.stringify(
        builtinAliasManifest("calc_alias", "calculator"),
        null,
        2,
      ),
    );

    // 旧接口不再直接生效：返回待审批草案。
    const draft = await app.inject({
      method: "POST",
      url: "/v1/plugins/reload",
      headers: AUTH,
    });
    expect(draft.statusCode).toBe(201);
    const approval = draft.json().approval;
    expect(approval).toMatchObject({
      type: "reload_plugins",
      status: "pending",
    });

    // 未批准前重载没有生效。
    const before = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(before.json().plugins.map((p: { name: string }) => p.name))
      .toEqual(["ping"]);

    const execute = await approveAndExecute(app, approval.id, approval.hash);

    expect(execute.statusCode).toBe(200);
    expect(execute.json()).toMatchObject({
      result: {
        applied: true,
        plugins: [
          expect.objectContaining({ name: "calc_alias", state: "loaded" }),
          expect.objectContaining({ name: "ping", state: "loaded" }),
        ],
      },
    });

    const after = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(after.json().plugins.map((p: { name: string }) => p.name))
      .toEqual(expect.arrayContaining(["calc_alias", "ping"]));
    await app.close();
  });

  it("keeps the old registry when an approved reload has a failing plugin", async () => {
    fixtureRoot = createPluginFixture({
      ping: httpManifest("ping", "https://api.example.com/ping"),
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
      pluginAllowedHosts: "api.example.com",
    });

    mkdirSync(path.join(fixtureRoot, "broken"));
    writeFileSync(path.join(fixtureRoot, "broken", "manifest.json"), "{ oops");

    const draft = await app.inject({
      method: "POST",
      url: "/v1/plugins/reload",
      headers: AUTH,
    });
    const execute = await approveAndExecute(
      app,
      draft.json().approval.id,
      draft.json().approval.hash,
    );

    expect(execute.statusCode).toBe(500);
    expect(execute.json()).toMatchObject({
      error: "PLUGIN_APPLY_FAILED",
      details: {
        statuses: expect.arrayContaining([
          expect.objectContaining({ name: "broken", state: "error" }),
          expect.objectContaining({ name: "ping", state: "loaded" }),
        ]),
      },
    });

    // 旧注册表仍在生效：ping 仍可用，新坏插件没有混入。
    const status = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(status.json().plugins.map((p: { name: string }) => p.name))
      .toEqual(["ping"]);
    await app.close();
  });

  it("disable/enable go through approval and change the chat loop after execute", async () => {
    fixtureRoot = createPluginFixture({
      calc_alias: builtinAliasManifest("calc_alias", "calculator"),
    });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "c1", name: "calc_alias", arguments: {} }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "完成",
        toolCalls: [],
        model: "test-model",
      });
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      apiToken: "test-secret",
      pluginsDir: fixtureRoot,
    });

    const disabled = await app.inject({
      method: "POST",
      url: "/v1/plugins/calc_alias/disable",
      headers: AUTH,
    });
    expect(disabled.statusCode).toBe(201);
    expect(disabled.json().approval).toMatchObject({
      type: "set_plugin_enabled",
      status: "pending",
      preview: { summary: "禁用插件 calc_alias" },
    });

    const disableExec = await approveAndExecute(
      app,
      disabled.json().approval.id,
      disabled.json().approval.hash,
    );
    expect(disableExec.json().result).toMatchObject({
      plugin: { name: "calc_alias", state: "disabled" },
    });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "算一下" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      message: "完成",
      execution: {
        toolExecutions: [{ id: "c1", name: "calc_alias", status: "error" }],
      },
    });

    const enabled = await app.inject({
      method: "POST",
      url: "/v1/plugins/calc_alias/enable",
      headers: AUTH,
    });
    const enableExec = await approveAndExecute(
      app,
      enabled.json().approval.id,
      enabled.json().approval.hash,
    );
    expect(enableExec.json().result).toMatchObject({
      plugin: { name: "calc_alias", state: "loaded" },
    });
    await app.close();
  });

  it("returns 404 for unknown or malformed plugin names", async () => {
    fixtureRoot = createPluginFixture({
      ping: httpManifest("ping", "https://api.example.com/ping"),
    });
    const app = buildApp({
      apiToken: "test-secret",
      modelClient: dummyModelClient(),
      pluginsDir: fixtureRoot,
      pluginAllowedHosts: "api.example.com",
    });

    for (const url of [
      "/v1/plugins/missing/enable",
      "/v1/plugins/Bad-Name/disable",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: AUTH,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "PLUGIN_NOT_FOUND" });
    }
    await app.close();
  });
});
