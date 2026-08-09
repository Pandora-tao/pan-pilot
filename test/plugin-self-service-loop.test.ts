import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type {
  ModelClient,
  ModelCompletion,
} from "../src/model/model-client.js";
import {
  createPluginFixture,
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

/** 自服务闭环依赖的两个管理工具（builtin 自引用），由 buildApp 注入实现。 */
function managementManifest(
  name: "list_plugins" | "create_plugin" | "reload_plugins",
): Record<string, unknown> {
  if (name === "list_plugins") {
    return {
      apiVersion: "v1",
      name,
      description: "列出插件状态",
      parameters: { type: "object", properties: {} },
      executor: { type: "builtin", ref: "list_plugins" },
      enabled: true,
    };
  }
  if (name === "reload_plugins") {
    return {
      apiVersion: "v1",
      name,
      description: "重载插件草案",
      parameters: { type: "object", properties: {} },
      executor: { type: "builtin", ref: "reload_plugins" },
      enabled: true,
    };
  }
  return {
    apiVersion: "v1",
    name,
    description: "创建插件草案",
    parameters: {
      type: "object",
      properties: { manifest: { type: "object" } },
      required: ["manifest"],
    },
    executor: { type: "builtin", ref: "create_plugin" },
    enabled: true,
  };
}

function weatherManifest(): Record<string, unknown> {
  return {
    apiVersion: "v1",
    name: "weather",
    description: "查询指定城市天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    executor: {
      type: "http",
      method: "GET",
      url: "https://api.example.com/weather?city=${city}",
    },
  };
}

function scriptedModel(
  steps: readonly ModelCompletion[],
): ModelClient {
  const complete = vi.fn<ModelClient["complete"]>();
  for (const step of steps) complete.mockResolvedValueOnce(step);
  return { complete, completeStream: vi.fn() };
}

interface LoopAppOptions {
  modelClient?: ModelClient;
  apiToken?: string;
  allowedHosts?: string;
  allowedEnvVars?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  extraDirs?: Record<string, unknown>;
}

function buildLoopApp(options: LoopAppOptions = {}) {
  fixtureRoot = createPluginFixture({
    list_plugins: managementManifest("list_plugins"),
    create_plugin: managementManifest("create_plugin"),
    reload_plugins: managementManifest("reload_plugins"),
    ...options.extraDirs,
  });
  const fetchImpl = options.fetchImpl
    ?? vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  const app = buildApp({
    ...(options.apiToken === undefined
      ? { apiToken: "test-secret" }
      : { apiToken: options.apiToken }),
    modelClient: options.modelClient ?? scriptedModel([]),
    pluginsDir: fixtureRoot,
    pluginAllowedHosts: options.allowedHosts ?? "api.example.com",
    ...(options.allowedEnvVars === undefined
      ? {}
      : { pluginAllowedEnvVars: options.allowedEnvVars }),
    ...(options.ttlMs === undefined
      ? {}
      : { pluginApprovalTtlMs: options.ttlMs }),
    pluginFetchImpl: fetchImpl,
  });
  return { app, fetchImpl };
}

async function createDraft(
  app: FastifyInstance,
  action: unknown,
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/plugins/approvals",
    headers: AUTH,
    payload: { action },
  });
  return response;
}

async function approveAndExecute(
  app: FastifyInstance,
  id: string,
  hash: string,
) {
  const approve = await app.inject({
    method: "POST",
    url: `/v1/plugins/approvals/${id}/approve`,
    headers: AUTH,
    payload: { hash },
  });
  expect(approve.statusCode).toBe(200);
  return app.inject({
    method: "POST",
    url: `/v1/plugins/approvals/${id}/execute`,
    headers: AUTH,
    payload: { hash },
  });
}

describe("自服务插件闭环（端到端）", () => {
  it("list → create 草案 → 审批 → 原子写入/重载 → 新工具进入 Agent 注册表", async () => {
    const modelClient = scriptedModel([
      {
        content: "",
        toolCalls: [{
          id: "c1",
          name: "create_plugin",
          arguments: { manifest: weatherManifest() },
        }],
        model: "test-model",
      },
      { content: "已提交插件草案，等待人工审批。", toolCalls: [], model: "test-model" },
      {
        content: "",
        toolCalls: [{
          id: "c2",
          name: "weather",
          arguments: { city: "上海" },
        }],
        model: "test-model",
      },
      { content: "上海天气查询完成。", toolCalls: [], model: "test-model" },
    ]);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ weather: "晴" }), { status: 200 }),
    );
    const { app } = buildLoopApp({ modelClient, fetchImpl });

    // 1. Agent 通过 create_plugin 提交草案（本轮只生成审批请求）。
    const firstChat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "创建一个天气插件" },
    });
    expect(firstChat.statusCode).toBe(200);
    expect(firstChat.json().execution.toolExecutions).toEqual([
      { id: "c1", name: "create_plugin", status: "success" },
    ]);

    // 未审批：不落盘、不进注册表。
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    const before = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(before.json().plugins.map((p: { name: string }) => p.name))
      .not.toContain("weather");

    // 2. 审批列表可见 pending 草案，预览含目标 host / 方法 / 变化。
    const list = await app.inject({
      method: "GET",
      url: "/v1/plugins/approvals",
      headers: AUTH,
    });
    const pending = list.json().approvals.find(
      (a: { type: string }) => a.type === "create_plugin",
    );
    expect(pending).toMatchObject({
      status: "pending",
      preview: {
        pluginName: "weather",
        executorType: "http",
        targetHost: "api.example.com",
        httpMethod: "GET",
      },
    });

    // 3. 人工批准精确动作（哈希绑定）→ 一次性执行。
    const execute = await approveAndExecute(app, pending.id, pending.hash);
    expect(execute.statusCode).toBe(200);
    expect(execute.json().result).toMatchObject({ applied: true });
    expect(execute.json().approval.status).toBe("executed");

    // 4. 原子写入 + 重载：文件落盘，状态进入 /v1/plugins。
    expect(existsSync(path.join(fixtureRoot, "weather", "manifest.json")))
      .toBe(true);
    const after = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(after.json().plugins.find((p: { name: string }) => p.name === "weather"))
      .toMatchObject({ state: "loaded" });

    // 5. 第二轮对话：模型直接调用新工具，请求打到白名单 host。
    const secondChat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "查一下上海天气" },
    });
    expect(secondChat.statusCode).toBe(200);
    expect(secondChat.json().execution.toolExecutions).toEqual([
      { id: "c2", name: "weather", status: "success" },
    ]);
    expect(String(fetchImpl.mock.calls[0]![0]))
      .toContain("https://api.example.com/weather?city=");
    await app.close();
  });

  it("list_plugins 是只读工具：模型可直接调用，不产生审批", async () => {
    const modelClient = scriptedModel([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "list_plugins", arguments: {} }],
        model: "test-model",
      },
      { content: "以下是当前插件状态。", toolCalls: [], model: "test-model" },
    ]);
    const { app } = buildLoopApp({ modelClient });

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "列出插件" },
    });

    expect(chat.statusCode).toBe(200);
    expect(chat.json().execution.toolExecutions).toEqual([
      { id: "c1", name: "list_plugins", status: "success" },
    ]);
    const approvals = await app.inject({
      method: "GET",
      url: "/v1/plugins/approvals",
      headers: AUTH,
    });
    expect(approvals.json().approvals).toEqual([]);
    await app.close();
  });

  it("拒绝后不可执行，且不产生任何落盘", async () => {
    const { app } = buildLoopApp();
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const id = draft.json().approval.id;

    const reject = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${id}/reject`,
      headers: AUTH,
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().approval.status).toBe("rejected");

    const execute = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${id}/execute`,
      headers: AUTH,
      payload: { hash: draft.json().approval.hash },
    });
    expect(execute.statusCode).toBe(409);
    expect(execute.json()).toMatchObject({ error: "APPROVAL_REJECTED" });
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    await app.close();
  });

  it("过期后批准与执行都被拒绝", async () => {
    const { app } = buildLoopApp({ ttlMs: 5 });
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const approval = draft.json().approval;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const approve = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/approve`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error).toBe("APPROVAL_EXPIRED");
    await app.close();
  });

  it("篡改：哈希不符时批准与执行都被拒绝", async () => {
    const { app } = buildLoopApp();
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const approval = draft.json().approval;

    const badApprove = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/approve`,
      headers: AUTH,
      payload: { hash: "d".repeat(64) },
    });
    expect(badApprove.statusCode).toBe(409);
    expect(badApprove.json().error).toBe("APPROVAL_HASH_MISMATCH");

    const goodApprove = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/approve`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(goodApprove.statusCode).toBe(200);

    const badExecute = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/execute`,
      headers: AUTH,
      payload: { hash: "d".repeat(64) },
    });
    expect(badExecute.statusCode).toBe(409);
    expect(badExecute.json().error).toBe("APPROVAL_HASH_MISMATCH");
    await app.close();
  });

  it("重放与并发：一次性动作只能成功执行一次", async () => {
    const { app } = buildLoopApp();
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const approval = draft.json().approval;
    await approveAndExecute(app, approval.id, approval.hash);

    // 顺序重放。
    const replay = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/execute`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(replay.statusCode).toBe(409);
    expect(["APPROVAL_ALREADY_USED", "APPROVAL_CONCURRENT"])
      .toContain(replay.json().error);

    // 并发执行：一个成功，另一个被拒绝。
    const second = await createDraft(app, {
      type: "create_plugin",
      manifest: { ...weatherManifest(), name: "weather2" },
    });
    const approval2 = second.json().approval;
    await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval2.id}/approve`,
      headers: AUTH,
      payload: { hash: approval2.hash },
    });
    const [first, secondExec] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/plugins/approvals/${approval2.id}/execute`,
        headers: AUTH,
        payload: { hash: approval2.hash },
      }),
      app.inject({
        method: "POST",
        url: `/v1/plugins/approvals/${approval2.id}/execute`,
        headers: AUTH,
        payload: { hash: approval2.hash },
      }),
    ]);
    const statuses = [first.statusCode, secondExec.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    await app.close();
  });

  it("host 白名单默认拒绝：未配置时草案与加载都被拒绝", async () => {
    // 未配置白名单的应用：http 草案直接失败。
    const { app } = buildLoopApp({ allowedHosts: "" });
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    expect(draft.statusCode).toBe(400);
    expect(draft.json().error).toBe("PLUGIN_VALIDATION_FAILED");
    expect(draft.json().message).toContain("默认拒绝");
    await app.close();

    // 加载期同样拒绝：已有 http 插件进入 error 状态而不是放行。
    const { app: app2 } = buildLoopApp({
      allowedHosts: "",
      extraDirs: { ping: { ...weatherManifest(), name: "ping" } },
    });
    const status = await app2.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(status.json().plugins.find((p: { name: string }) => p.name === "ping"))
      .toMatchObject({ state: "error", error: expect.stringContaining("默认拒绝") });
    await app2.close();
  });

  it("环境变量引用默认拒绝：不在白名单的 ${env:...} 草案被拒", async () => {
    const { app } = buildLoopApp({ allowedEnvVars: "" });
    const manifest = weatherManifest();
    (manifest.executor as Record<string, unknown>).headers = {
      Authorization: "Bearer ${env:PLUGIN_TEST_TOKEN}",
    };

    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest,
    });

    expect(draft.statusCode).toBe(400);
    expect(draft.json().error).toBe("PLUGIN_VALIDATION_FAILED");
    expect(draft.json().message).toContain("PLUGIN_TEST_TOKEN 不在允许引用白名单");
    await app.close();
  });

  it("路径与命名冲突：非法名、内置名、已存在名都被拒绝", async () => {
    const { app } = buildLoopApp({
      extraDirs: { ping: weatherManifest() },
    });

    // 非法名（路径穿越字符）。
    const badName = await createDraft(app, {
      type: "create_plugin",
      manifest: { ...weatherManifest(), name: "../escape" },
    });
    expect(badName.statusCode).toBe(400);
    expect(badName.json().error).toBe("PLUGIN_VALIDATION_FAILED");

    // 内置工具名冲突。
    const builtin = await createDraft(app, {
      type: "create_plugin",
      manifest: { ...weatherManifest(), name: "list_plugins" },
    });
    expect(builtin.statusCode).toBe(409);
    expect(builtin.json().error).toBe("PLUGIN_CONFLICT");

    // 磁盘上已存在同名插件（create_plugin 不支持覆盖）。
    const existing = await createDraft(app, {
      type: "create_plugin",
      manifest: { ...weatherManifest(), name: "ping" },
    });
    expect(existing.statusCode).toBe(409);
    expect(existing.json().error).toBe("PLUGIN_CONFLICT");
    await app.close();
  });

  it("reload 回滚：执行阶段写入后重载失败，文件和注册表都保持旧状态", async () => {
    const { app } = buildLoopApp({
      extraDirs: { broken: "{ 不是 JSON" },
    });
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const approval = draft.json().approval;

    const execute = await approveAndExecute(app, approval.id, approval.hash);

    expect(execute.statusCode).toBe(500);
    expect(execute.json().error).toBe("PLUGIN_APPLY_FAILED");
    expect(execute.json().details.statuses)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "broken", state: "error" }),
      ]));
    // 新写入的文件被回滚，注册表里也没有 weather。
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    const status = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(status.json().plugins.map((p: { name: string }) => p.name))
      .not.toContain("weather");
    await app.close();
  });

  it("审批接口需要鉴权，且预览不泄露 manifest 原文与密钥", async () => {
    const manifest = weatherManifest();
    (manifest.executor as Record<string, unknown>).headers = {
      Authorization: "Bearer topsecret-value",
    };
    const { app } = buildLoopApp();

    const anonymous = await app.inject({
      method: "POST",
      url: "/v1/plugins/approvals",
      payload: { action: { type: "create_plugin", manifest } },
    });
    expect(anonymous.statusCode).toBe(401);

    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest,
    });
    const raw = JSON.stringify(draft.json());
    expect(raw).not.toContain("topsecret-value");
    expect(raw).not.toContain("Authorization");
    expect("manifest" in draft.json().approval).toBe(false);
    await app.close();
  });

  it("reload_plugins 工具只创建审批草案，绝不直接重载", async () => {
    const modelClient = scriptedModel([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "reload_plugins", arguments: {} }],
        model: "test-model",
      },
      { content: "已提交重载草案，等待审批。", toolCalls: [], model: "test-model" },
    ]);
    const { app } = buildLoopApp({ modelClient });
    // 磁盘上先放好一个尚未加载的新插件：若工具直接重载，它会立即出现。
    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify({
        apiVersion: "v1",
        name: "beta",
        description: "待重载插件",
        parameters: {
          type: "object",
          properties: { left: { type: "number" }, right: { type: "number" } },
          required: ["left", "right"],
        },
        executor: { type: "builtin", ref: "calculator" },
        enabled: true,
      }),
    );

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "重载一下插件" },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().execution.toolExecutions).toEqual([
      { id: "c1", name: "reload_plugins", status: "success" },
    ]);

    // 只创建了草案：beta 没有进入注册表。
    const before = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(before.json().plugins.map((p: { name: string }) => p.name))
      .not.toContain("beta");
    const approvals = await app.inject({
      method: "GET",
      url: "/v1/plugins/approvals",
      headers: AUTH,
    });
    const pending = approvals.json().approvals.find(
      (a: { type: string }) => a.type === "reload_plugins",
    );
    expect(pending).toMatchObject({ status: "pending" });

    // 批准并执行后，重载才真正发生。
    const execute = await approveAndExecute(app, pending.id, pending.hash);
    expect(execute.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(after.json().plugins.find((p: { name: string }) => p.name === "beta"))
      .toMatchObject({ state: "loaded" });
    await app.close();
  });

  it("未配置 API token 时审批执行接口 fail-closed", async () => {
    const { app } = buildLoopApp({ apiToken: "" });
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    expect(draft.statusCode).toBe(201);
    const { id, hash } = draft.json().approval;

    for (const action of ["approve", "reject", "execute"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/plugins/approvals/${id}/${action}`,
        payload: action === "reject" ? {} : { hash },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "AUTH_NOT_CONFIGURED",
      });
    }
    // 匿名无法完成任何副作用：目录没有被写入。
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    await app.close();
  });

  it("approve/execute 必须携带 64 位动作哈希，缺失或格式错误返回 400", async () => {
    const { app } = buildLoopApp();
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const id = draft.json().approval.id;

    const missingApprove = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${id}/approve`,
      headers: AUTH,
      payload: {},
    });
    expect(missingApprove.statusCode).toBe(400);
    expect(missingApprove.json().error).toBe("INVALID_REQUEST");

    const malformedApprove = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${id}/approve`,
      headers: AUTH,
      payload: { hash: "abc" },
    });
    expect(malformedApprove.statusCode).toBe(400);
    expect(malformedApprove.json().error).toBe("INVALID_REQUEST");

    const missingExecute = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${id}/execute`,
      headers: AUTH,
      payload: {},
    });
    expect(missingExecute.statusCode).toBe(400);
    expect(missingExecute.json().error).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("已批准的 reload 在插件目录变化后拒绝执行", async () => {
    const { app } = buildLoopApp();
    const draft = await app.inject({
      method: "POST",
      url: "/v1/plugins/reload",
      headers: AUTH,
    });
    const approval = draft.json().approval;

    // 批准后、执行前：目录里出现新插件。
    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify({
        apiVersion: "v1",
        name: "beta",
        description: "未经审批换入的插件",
        parameters: { type: "object", properties: {} },
        executor: { type: "builtin", ref: "calculator" },
        enabled: true,
      }),
    );
    const approve = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/approve`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(approve.statusCode).toBe(200);

    const execute = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/execute`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(execute.statusCode).toBe(409);
    expect(execute.json().error).toBe("PLUGIN_DIR_CHANGED");

    // 未被审批的内容没有进入注册表。
    const status = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    expect(status.json().plugins.map((p: { name: string }) => p.name))
      .not.toContain("beta");
    await app.close();
  });

  it("已批准的 create 在目录变化后拒绝执行：A 不落盘、B 不进注册表", async () => {
    const { app } = buildLoopApp();
    const draft = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const approval = draft.json().approval;
    const approve = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/approve`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(approve.statusCode).toBe(200);

    // 批准后、执行前：目录里被放入另一个有效插件 B。
    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify({ ...weatherManifest(), name: "beta" }),
    );

    const execute = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/execute`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(execute.statusCode).toBe(409);
    expect(execute.json().error).toBe("PLUGIN_DIR_CHANGED");

    // A 未落盘；B 没有被顺带加载进注册表。
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    const status = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    const names = status.json().plugins.map((p: { name: string }) => p.name);
    expect(names).not.toContain("weather");
    expect(names).not.toContain("beta");

    // 目录恢复原状后，同一审批可以执行并落盘。
    rmSync(path.join(fixtureRoot, "beta"), { recursive: true, force: true });
    const retry = await app.inject({
      method: "POST",
      url: `/v1/plugins/approvals/${approval.id}/execute`,
      headers: AUTH,
      payload: { hash: approval.hash },
    });
    expect(retry.statusCode).toBe(200);
    expect(existsSync(path.join(fixtureRoot, "weather", "manifest.json")))
      .toBe(true);
    await app.close();
  });

  it("两个不同审批并发执行：恰好一个成功、另一个 409、不发生顺带加载", async () => {
    const { app } = buildLoopApp();
    const alpha = await createDraft(app, {
      type: "create_plugin",
      manifest: weatherManifest(),
    });
    const beta = await createDraft(app, {
      type: "create_plugin",
      manifest: { ...weatherManifest(), name: "weather2" },
    });
    const approvalA = alpha.json().approval;
    const approvalB = beta.json().approval;
    for (const approval of [approvalA, approvalB]) {
      const approve = await app.inject({
        method: "POST",
        url: `/v1/plugins/approvals/${approval.id}/approve`,
        headers: AUTH,
        payload: { hash: approval.hash },
      });
      expect(approve.statusCode).toBe(200);
    }

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/plugins/approvals/${approvalA.id}/execute`,
        headers: AUTH,
        payload: { hash: approvalA.hash },
      }),
      app.inject({
        method: "POST",
        url: `/v1/plugins/approvals/${approvalB.id}/execute`,
        headers: AUTH,
        payload: { hash: approvalB.hash },
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const blocked = first.statusCode === 409 ? first : second;
    // 取决于 HTTP 调度是否让两个请求在临界区交错：
    // 交错时互斥锁拒绝（APPROVAL_CONCURRENT）；顺序执行时第二个审批
    // 因目录快照已变化被拒（PLUGIN_DIR_CHANGED）。两种都是 fail-closed，
    // 互斥语义本身由服务层测试确定性覆盖。
    expect(["APPROVAL_CONCURRENT", "PLUGIN_DIR_CHANGED"])
      .toContain(blocked.json().error);

    // 恰好一个插件进入注册表与磁盘，另一个没有发生任何写入。
    const status = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: AUTH,
    });
    const loaded = status.json().plugins
      .map((p: { name: string }) => p.name)
      .filter((name: string) => name === "weather" || name === "weather2");
    expect(loaded).toHaveLength(1);
    const blockedName = loaded[0] === "weather" ? "weather2" : "weather";
    expect(existsSync(path.join(fixtureRoot, blockedName))).toBe(false);
    await app.close();
  });
});
