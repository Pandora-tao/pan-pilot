import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InMemoryApprovalStore,
  type ApprovalRecord,
  type ApprovalStore,
} from "../src/plugins/approval-store.js";
import type { PluginManifest } from "../src/plugins/manifest-schema.js";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import { PluginApprovalError } from "../src/plugins/plugin-approval-error.js";
import { PluginApprovalService } from "../src/plugins/plugin-approval-service.js";
import type { AnyAgentTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  createPluginFixture,
  createTestEchoTool,
  removePluginFixture,
} from "./helpers/plugin-fixture.js";

let fixtureRoot = "";
let fakeNow = Date.now();

afterEach(() => {
  if (fixtureRoot) {
    removePluginFixture(fixtureRoot);
    fixtureRoot = "";
  }
});

function httpManifestFor(name: string, url: string): PluginManifest {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 测试插件`,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    executor: { type: "http", method: "GET", url },
  };
}

function builtinAlias(name: string, ref: string): PluginManifest {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 别名`,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    executor: { type: "builtin", ref },
  };
}

/** 与 app.ts 相同的三个管理工具名，保证两个边界使用同一 builtin 集合。 */
function managementTool(name: string): AnyAgentTool {
  return {
    name,
    description: `${name} 管理工具`,
    inputSchema: z.object({}).strict(),
    async execute() {
      return {};
    },
  };
}

function allBuiltinTools(): AnyAgentTool[] {
  return [
    createTestEchoTool(),
    managementTool("list_plugins"),
    managementTool("create_plugin"),
    managementTool("reload_plugins"),
  ];
}

function createService() {
  const builtinTools = allBuiltinTools();
  const registry = new ToolRegistry();
  const manager = new PluginManager({
    pluginsDir: fixtureRoot,
    builtinTools,
    registry,
    allowedHosts: ["api.example.com"],
    allowedEnvVars: ["PLUGIN_TEST_TOKEN"],
  });
  manager.loadInitial();
  const store = new InMemoryApprovalStore({ now: () => fakeNow });
  const service = new PluginApprovalService({
    store,
    manager,
    builtinTools,
    allowedHosts: ["api.example.com"],
    allowedEnvVars: ["PLUGIN_TEST_TOKEN"],
    ttlMs: 60_000,
    now: () => fakeNow,
  });
  return { registry, manager, store, service };
}

/**
 * 模拟「泄露内部引用」的坏存储实现：create/get/list 返回同一个可变对象。
 * 用于验证服务在批准/执行前重新哈希冻结动作，不依赖存储实现是否守规矩。
 */
class LeakyApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  create(record: ApprovalRecord): ApprovalRecord {
    this.records.set(record.id, record);
    return record;
  }

  get(id: string): ApprovalRecord | undefined {
    return this.records.get(id);
  }

  list(): ApprovalRecord[] {
    return [...this.records.values()];
  }

  updateStatus(
    id: string,
    status: ApprovalRecord["status"],
    lastError?: string,
  ): ApprovalRecord | undefined {
    const record = this.records.get(id);
    if (record === undefined) return undefined;
    record.status = status;
    if (lastError === undefined) {
      delete record.lastError;
    } else {
      record.lastError = lastError;
    }
    return record;
  }
}

function expectApprovalError(
  fn: () => unknown,
  code: PluginApprovalError["code"],
): PluginApprovalError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginApprovalError);
  const err = caught as PluginApprovalError;
  expect(err.code).toBe(code);
  return err;
}

function registeredNames(registry: ToolRegistry): string[] {
  return registry.listDefinitions().map((definition) => definition.name);
}

describe("PluginApprovalService", () => {
  it("creates a pending draft with preview and zero side effects", () => {
    fixtureRoot = createPluginFixture({});
    fakeNow = 1_000_000;
    const { registry, service } = createService();
    const manifest = httpManifestFor(
      "weather",
      "https://api.example.com/weather?city=${city}",
    );

    const approval = service.createDraft({
      type: "create_plugin",
      manifest,
    });

    expect(approval).toMatchObject({
      type: "create_plugin",
      status: "pending",
      createdAt: "1970-01-01T00:16:40.000Z",
      expiresAt: "1970-01-01T00:17:40.000Z",
      preview: {
        pluginName: "weather",
        executorType: "http",
        targetHost: "api.example.com",
        httpMethod: "GET",
        envVarNames: [],
      },
    });
    expect(approval.preview.changes).toEqual(expect.arrayContaining([
      "新建 plugins/weather/manifest.json",
      "重载注册表并启用新工具",
      expect.stringContaining("绑定插件目录快照"),
    ]));
    expect(approval.hash).toMatch(/^[0-9a-f]{64}$/);
    // 草案不落盘、不进入注册表。
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    expect(registeredNames(registry)).toEqual([]);
    // 对外快照绝不包含 manifest 原文。
    expect("manifest" in approval).toBe(false);
  });

  it("accepts builtin-alias drafts with a builtin preview", () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();

    const approval = service.createDraft({
      type: "create_plugin",
      manifest: builtinAlias("echo_alias", "echo"),
    });

    expect(approval.preview).toMatchObject({
      pluginName: "echo_alias",
      executorType: "builtin",
      summary: "创建插件 echo_alias（builtin 引用 echo）",
    });
  });

  it("rejects invalid manifests, missing builtin refs and bad names", () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();

    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: { ...httpManifestFor("x", "https://api.example.com/x"), apiVersion: "v2" },
      }),
      "PLUGIN_VALIDATION_FAILED",
    );
    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: builtinAlias("echo_alias", "missing"),
      }),
      "PLUGIN_VALIDATION_FAILED",
    );
    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: { ...httpManifestFor("Bad-Name", "https://api.example.com/x") },
      }),
      "PLUGIN_VALIDATION_FAILED",
    );
  });

  it("rejects names that conflict with builtins, disk or known statuses", () => {
    fixtureRoot = createPluginFixture({
      existing: httpManifestFor("existing", "https://api.example.com/x"),
      broken_dir: "{ 不是 JSON",
    });
    const { service } = createService();

    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: builtinAlias("echo", "echo"),
      }),
      "PLUGIN_CONFLICT",
    );
    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: httpManifestFor("existing", "https://api.example.com/x"),
      }),
      "PLUGIN_CONFLICT",
    );
    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: httpManifestFor("broken_dir", "https://api.example.com/x"),
      }),
      "PLUGIN_CONFLICT",
    );
  });

  it("applies host and env allowlists at draft time (default deny)", () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();

    // host 不在白名单。
    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: httpManifestFor("evil", "https://evil.example.com/x"),
      }),
      "PLUGIN_VALIDATION_FAILED",
    );

    // env 引用不在白名单。
    const withEnv = httpManifestFor("env_tool", "https://api.example.com/x");
    withEnv.executor = {
      ...withEnv.executor,
      type: "http",
      url: "https://api.example.com/x",
      headers: { Authorization: "Bearer ${env:SECRET_TOKEN}" },
    };
    expectApprovalError(
      () => service.createDraft({ type: "create_plugin", manifest: withEnv }),
      "PLUGIN_VALIDATION_FAILED",
    );
  });

  it("approves once, rejects replay and enforces the hash binding", () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });

    // 篡改：用错误哈希批准。
    expectApprovalError(
      () => service.approve(approval.id, "deadbeef"),
      "APPROVAL_HASH_MISMATCH",
    );
    expectApprovalError(
      () => service.approve("missing-id", "deadbeef"),
      "APPROVAL_NOT_FOUND",
    );

    const approved = service.approve(approval.id, approval.hash);
    expect(approved.status).toBe("approved");
    expectApprovalError(
      () => service.approve(approval.id, approval.hash),
      "APPROVAL_ALREADY_USED",
    );
  });

  it("rejects approval that expired and allows rejecting pending drafts", async () => {
    fixtureRoot = createPluginFixture({});
    fakeNow = 1_000_000;
    const { service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });

    const rejected = service.reject(approval.id);
    expect(rejected.status).toBe("rejected");
    await expect(service.execute(approval.id, approval.hash)).rejects.toMatchObject({
      code: "APPROVAL_REJECTED",
    });

    const second = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    // 过期边界：now >= expiresAt 即过期。
    fakeNow += 60_000;
    expect(service.listApprovals().find((a) => a.id === second.id))
      .toMatchObject({ status: "expired" });
    expectApprovalError(
      () => service.approve(second.id, second.hash),
      "APPROVAL_EXPIRED",
    );
    await expect(service.execute(second.id, second.hash)).rejects.toMatchObject({
      code: "APPROVAL_EXPIRED",
    });
  });

  it("executes only approved actions and blocks replay", async () => {
    fixtureRoot = createPluginFixture({});
    const { registry, service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });

    // 未批准不可执行。
    await expect(service.execute(approval.id, approval.hash)).rejects.toMatchObject({
      code: "APPROVAL_NOT_APPROVED",
    });

    service.approve(approval.id, approval.hash);
    // 执行时篡改哈希同样被拒。
    await expect(service.execute(approval.id, "deadbeef")).rejects
      .toMatchObject({ code: "APPROVAL_HASH_MISMATCH" });

    const outcome = await service.execute(approval.id, approval.hash);
    expect(outcome.result).toMatchObject({ applied: true });
    expect(existsSync(path.join(fixtureRoot, "weather", "manifest.json")))
      .toBe(true);
    expect(registeredNames(registry)).toEqual(["weather"]);
    expect(outcome.approval.status).toBe("executed");

    // 重放被拒。
    await expect(service.execute(approval.id, approval.hash)).rejects.toMatchObject({
      code: "APPROVAL_ALREADY_USED",
    });
  });

  it("cannot execute an approved action after it expires", async () => {
    fixtureRoot = createPluginFixture({});
    fakeNow = 1_000_000;
    const { service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    service.approve(approval.id, approval.hash);

    fakeNow += 60_000;

    await expect(service.execute(approval.id, approval.hash)).rejects.toMatchObject({
      code: "APPROVAL_EXPIRED",
    });
  });

  it("two approved drafts for the same name: only the first can apply", async () => {
    fixtureRoot = createPluginFixture({});
    const { registry, service } = createService();
    const first = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    const second = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    service.approve(first.id, first.hash);
    service.approve(second.id, second.hash);

    const outcome = await service.execute(first.id, first.hash);
    expect(outcome.result).toMatchObject({ applied: true });

    // 第二个草案执行前发现目录快照已变化（第一个插件已落盘），拒绝执行，
    // 绝不覆盖第一个插件（写入层还有 create-only 双保险）。
    await expect(service.execute(second.id, second.hash)).rejects.toMatchObject({
      code: "PLUGIN_DIR_CHANGED",
    });
    expect(registeredNames(registry)).toEqual(["weather"]);
  });

  it("rejects enable/disable drafts for plugins in error state", () => {
    fixtureRoot = createPluginFixture({
      broken_dir: "{ 不是 JSON",
    });
    const { service } = createService();

    expectApprovalError(
      () => service.createDraft({
        type: "set_plugin_enabled",
        plugin: "broken_dir",
        enabled: true,
      }),
      "PLUGIN_VALIDATION_FAILED",
    );
  });

  it("rolls back the written file when reload fails and keeps the old registry", async () => {
    fixtureRoot = createPluginFixture({
      broken_dir: "{ 不是 JSON",
    });
    const { registry, service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    service.approve(approval.id, approval.hash);

    await expect(service.execute(approval.id, approval.hash)).rejects.toMatchObject({
      code: "PLUGIN_APPLY_FAILED",
    });

    // 新文件被回滚、注册表保持旧状态、审批保持 approved 可重试或拒绝。
    expect(existsSync(path.join(fixtureRoot, "weather"))).toBe(false);
    expect(registeredNames(registry)).toEqual([]);
    expect(service.listApprovals().find((a) => a.id === approval.id))
      .toMatchObject({ status: "approved" });
  });

  it("rejects execution when the directory changed between draft and execute", async () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    service.approve(approval.id, approval.hash);

    // 模拟 TOCTOU：草案通过后、执行前，有人抢先创建了同名目录。
    // 目录快照校验在写入前直接拒绝（写入层还有 create-only 双保险）。
    mkdirSync(path.join(fixtureRoot, "weather"));
    writeFileSync(
      path.join(fixtureRoot, "weather", "manifest.json"),
      JSON.stringify(httpManifestFor("weather", "https://evil.example.com/x")),
    );

    await expect(service.execute(approval.id, approval.hash)).rejects.toMatchObject({
      code: "PLUGIN_DIR_CHANGED",
    });
  });

  it("disable/enable via approval only touches runtime memory state", async () => {
    fixtureRoot = createPluginFixture({
      echo_alias: builtinAlias("echo_alias", "echo"),
    });
    const { registry, service } = createService();
    expect(registeredNames(registry)).toEqual(["echo_alias"]);

    const draft = service.createDraft({
      type: "set_plugin_enabled",
      plugin: "echo_alias",
      enabled: false,
    });
    expect(draft.preview).toMatchObject({
      summary: "禁用插件 echo_alias",
    });

    service.approve(draft.id, draft.hash);
    const outcome = await service.execute(draft.id, draft.hash);
    expect(outcome.result).toMatchObject({
      plugin: { name: "echo_alias", state: "disabled" },
    });
    expect(registeredNames(registry)).toEqual([]);
    // 磁盘上的 manifest 原样保留。
    const onDisk = JSON.parse(
      readFileSync(
        path.join(fixtureRoot, "echo_alias", "manifest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(onDisk.name).toBe("echo_alias");
    expect("enabled" in onDisk).toBe(false);
  });

  it("rejects unknown plugins for enable/disable drafts", () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();

    expectApprovalError(
      () => service.createDraft({
        type: "set_plugin_enabled",
        plugin: "nope",
        enabled: true,
      }),
      "PLUGIN_NOT_FOUND",
    );
  });

  it("re-hashes the frozen action before approve and execute (leaky store)", async () => {
    fixtureRoot = createPluginFixture({});
    const manager = new PluginManager({
      pluginsDir: fixtureRoot,
      builtinTools: allBuiltinTools(),
      registry: new ToolRegistry(),
      allowedHosts: ["api.example.com"],
    });
    manager.loadInitial();
    const store = new LeakyApprovalStore();
    const service = new PluginApprovalService({
      store,
      manager,
      builtinTools: allBuiltinTools(),
      allowedHosts: ["api.example.com"],
      ttlMs: 60_000,
    });

    // 篡改内部记录后，即使提交原 hash，批准也必须失败。
    const first = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });
    const leaked = store.get(first.id)!;
    if (leaked.action.type !== "create_plugin") throw new Error("预期 create 动作");
    leaked.action.manifest.executor = {
      type: "http",
      method: "GET",
      url: "https://evil.example.com/x",
    };
    expectApprovalError(
      () => service.approve(first.id, first.hash),
      "APPROVAL_HASH_MISMATCH",
    );

    // 先批准、后篡改：执行前重新哈希同样拒绝。
    const second = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather2", "https://api.example.com/weather2"),
    });
    service.approve(second.id, second.hash);
    const leakedSecond = store.get(second.id)!;
    if (leakedSecond.action.type !== "create_plugin") {
      throw new Error("预期 create 动作");
    }
    leakedSecond.action.manifest.executor = {
      type: "http",
      method: "GET",
      url: "https://evil.example.com/weather2",
    };
    await expect(service.execute(second.id, second.hash)).rejects
      .toMatchObject({ code: "APPROVAL_HASH_MISMATCH" });
    // 篡改后的动作没有落盘。
    expect(existsSync(path.join(fixtureRoot, "weather2"))).toBe(false);
  });

  it("mutating a store-returned copy cannot change the executed action", async () => {
    fixtureRoot = createPluginFixture({});
    const { store, service } = createService();
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("weather", "https://api.example.com/weather"),
    });

    // 篡改存储返回的副本（真实存储下这不会影响内部记录，
    // 重新哈希仍会校验调用方看到的动作是冻结的那一份）。
    const leaked = store.get(approval.id)!;
    if (leaked.action.type !== "create_plugin") throw new Error("预期 create 动作");
    leaked.action.manifest.executor = {
      type: "http",
      method: "GET",
      url: "https://evil.example.com/x",
    };
    // 深拷贝隔离：篡改副本不影响内部冻结动作，批准并执行的是原始动作。
    const approved = service.approve(approval.id, approval.hash);
    expect(approved.status).toBe("approved");
    await service.execute(approval.id, approval.hash);
    const onDisk = JSON.parse(
      readFileSync(
        path.join(fixtureRoot, "weather", "manifest.json"),
        "utf8",
      ),
    ) as { executor: { url: string } };
    expect(onDisk.executor.url).toBe("https://api.example.com/weather");
  });

  it("binds reload approval to the plugin directory snapshot", async () => {
    fixtureRoot = createPluginFixture({
      alpha: builtinAlias("alpha", "echo"),
    });
    const { service } = createService();
    const draft = service.createDraft({ type: "reload_plugins" });
    service.approve(draft.id, draft.hash);

    // 批准后目录内容变化（新增插件）→ 执行前拒绝。
    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify(builtinAlias("beta", "echo")),
    );

    await expect(service.execute(draft.id, draft.hash)).rejects.toMatchObject({
      code: "PLUGIN_DIR_CHANGED",
    });

    // 恢复目录后同一审批可执行（快照重新匹配）。
    rmSync(path.join(fixtureRoot, "beta"), { recursive: true, force: true });
    const outcome = await service.execute(draft.id, draft.hash);
    expect(outcome.result).toMatchObject({ applied: true });
  });

  it("applies a reload approval when the directory is unchanged", async () => {
    fixtureRoot = createPluginFixture({
      alpha: builtinAlias("alpha", "echo"),
    });
    const { registry, service } = createService();
    const draft = service.createDraft({ type: "reload_plugins" });
    service.approve(draft.id, draft.hash);

    const outcome = await service.execute(draft.id, draft.hash);

    expect(outcome.result).toMatchObject({ applied: true });
    expect(registeredNames(registry)).toEqual(["alpha"]);
  });

  it("rejects enable/disable when the plugin manifest changed after approval", async () => {
    fixtureRoot = createPluginFixture({
      echo_alias: builtinAlias("echo_alias", "echo"),
    });
    const { registry, service } = createService();
    const draft = service.createDraft({
      type: "set_plugin_enabled",
      plugin: "echo_alias",
      enabled: false,
    });
    service.approve(draft.id, draft.hash);

    // 同名插件内容被替换（描述变化）→ 指纹不符，拒绝执行。
    writeFileSync(
      path.join(fixtureRoot, "echo_alias", "manifest.json"),
      JSON.stringify({
        ...builtinAlias("echo_alias", "echo"),
        description: "被替换的版本",
      }),
    );

    await expect(service.execute(draft.id, draft.hash)).rejects.toMatchObject({
      code: "PLUGIN_DIR_CHANGED",
    });
    // 运行时状态未被改动。
    expect(registeredNames(registry)).toEqual(["echo_alias"]);
  });

  it("uses the same builtin set as the loader for drafts", () => {
    fixtureRoot = createPluginFixture({});
    const { service } = createService();

    // 管理工具名同样是内置名：草案不能与之冲突（与 reload 时一致）。
    expectApprovalError(
      () => service.createDraft({
        type: "create_plugin",
        manifest: builtinAlias("list_plugins", "echo"),
      }),
      "PLUGIN_CONFLICT",
    );
    // builtin 引用可以指向管理工具（与 PluginManager 的解析集合一致）。
    const approval = service.createDraft({
      type: "create_plugin",
      manifest: builtinAlias("reload_alias", "reload_plugins"),
    });
    expect(approval.preview).toMatchObject({ executorType: "builtin" });
  });

  it("binds create approval to the plugin directory snapshot", async () => {
    fixtureRoot = createPluginFixture({});
    const { registry, service } = createService();
    const draft = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("alpha", "https://api.example.com/alpha"),
    });
    service.approve(draft.id, draft.hash);

    // 批准后、执行前：目录里被放入另一个有效插件 B。
    mkdirSync(path.join(fixtureRoot, "beta"));
    writeFileSync(
      path.join(fixtureRoot, "beta", "manifest.json"),
      JSON.stringify(builtinAlias("beta", "echo")),
    );

    await expect(service.execute(draft.id, draft.hash)).rejects.toMatchObject({
      code: "PLUGIN_DIR_CHANGED",
    });
    // A 未落盘，B 未进入注册表（没有发生顺带加载）。
    expect(existsSync(path.join(fixtureRoot, "alpha"))).toBe(false);
    expect(registeredNames(registry)).toEqual([]);

    // 目录恢复原状后，同一审批可以执行。
    rmSync(path.join(fixtureRoot, "beta"), { recursive: true, force: true });
    const outcome = await service.execute(draft.id, draft.hash);
    expect(outcome.result).toMatchObject({ applied: true });
    expect(registeredNames(registry)).toEqual(["alpha"]);
  });

  it("serializes different approvals through the global mutation mutex", async () => {
    fixtureRoot = createPluginFixture({});
    const { registry, service } = createService();
    const alpha = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("alpha", "https://api.example.com/alpha"),
    });
    const beta = service.createDraft({
      type: "create_plugin",
      manifest: httpManifestFor("beta", "https://api.example.com/beta"),
    });
    service.approve(alpha.id, alpha.hash);
    service.approve(beta.id, beta.hash);

    const [first, second] = await Promise.all([
      service.execute(alpha.id, alpha.hash),
      service.execute(beta.id, beta.hash).catch((error) => error),
    ]);

    // 恰好一个进入临界区，另一个被全局互斥锁拒绝。
    const success = [first, second].find(
      (outcome) => !(outcome instanceof PluginApprovalError),
    );
    const blocked = [first, second].find(
      (outcome) => outcome instanceof PluginApprovalError,
    ) as PluginApprovalError | undefined;
    expect(success).toBeDefined();
    expect(blocked?.code).toBe("APPROVAL_CONCURRENT");

    // 只加载了赢得互斥锁的那个插件，另一个没有落盘。
    const names = registeredNames(registry);
    expect(names.length).toBe(1);
    const loaded = names[0]!;
    expect(existsSync(path.join(fixtureRoot, loaded, "manifest.json")))
      .toBe(true);
    const blockedName = loaded === "alpha" ? "beta" : "alpha";
    expect(existsSync(path.join(fixtureRoot, blockedName))).toBe(false);
  });
});
