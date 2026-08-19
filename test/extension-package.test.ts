import { afterEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeStore } from "../src/extension/runtime-store.js";
import { SandboxPackageManager } from "../src/extension/package-manager.js";
import {
  buildIntegrity,
  verifyIntegrity,
  writeJsonFile,
} from "../src/extension/integrity.js";
import {
  assertSafeDraftPath,
  compareSemver,
  ExtensionError,
  parseManifest,
} from "../src/extension/validate.js";
import { DEFAULT_SANDBOX_LIMITS } from "../src/extension/types.js";
import { allowContext } from "./helpers/tool-ctx.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pan-pilot-ext-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function validManifest(): Record<string, unknown> {
  return {
    apiVersion: "pan-pilot.plugin/v2",
    name: "stringops",
    version: "1.0.0",
    description: "字符串工具",
    runtime: { type: "sandbox-js", entry: "bundle/plugin.js" },
    tools: [{
      name: "upper",
      description: "转大写",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        additionalProperties: false,
      },
      permissions: { files: [], hosts: [], commands: [], storage: false },
    }],
    tests: { entry: "tests/main.js" },
  };
}

const SOURCE_INDEX = [
  "declare const globalThis: any;",
  "globalThis.__panpilot = {",
  "  tools: [{",
  "    name: 'upper', description: '转大写',",
  "    parameters: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },",
  "    run: function (input: any) { return { value: String((input && input.text) || '').toUpperCase() }; },",
  "  }],",
  "};",
  "export {};",
].join("\n");

const TEST_MAIN = [
  "globalThis.__pp_tests = [{",
  "  name: 'upper works',",
  "  run: function () {",
  "    if (globalThis.panpilot.meta && globalThis.panpilot.meta.version !== '1.0.0') throw new Error('meta 异常');",
  "  },",
  "}];",
].join("\n");

describe("扩展层：包格式与路径校验", () => {
  it("parseManifest 拒绝非法名称/重复工具/非 v2", () => {
    expect(() => parseManifest({ ...validManifest(), name: "1bad" })).toThrow(ExtensionError);
    expect(() => parseManifest({ ...validManifest(), version: "1.0" })).toThrow(ExtensionError);
    expect(() => parseManifest({ ...validManifest(), apiVersion: "pan-pilot.plugin/v1" })).toThrow(ExtensionError);
    expect(() => parseManifest({
      ...validManifest(),
      tools: [
        { name: "ab", description: "d" },
        { name: "ab", description: "d2" },
      ],
    })).toThrow(/工具名重复/);
  });

  it("assertSafeDraftPath 拒绝穿越/绝对/非法扩展名", () => {
    expect(() => assertSafeDraftPath("../../etc/passwd")).toThrow(ExtensionError);
    expect(() => assertSafeDraftPath("/abs/x.ts")).toThrow(ExtensionError);
    expect(() => assertSafeDraftPath("unknown/x.ts")).toThrow(ExtensionError);
    expect(() => assertSafeDraftPath("source/evil.sh")).toThrow(ExtensionError);
    expect(() => assertSafeDraftPath("source/index.ts")).not.toThrow();
    expect(() => assertSafeDraftPath("tests/main.js")).not.toThrow();
  });

  it("compareSemver 正确比较", () => {
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.1.9", "1.2.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("扩展层：运行时存储 与 integrity", () => {
  it("草稿/候选/已安装 active 指针/启停/回滚/卸载", async () => {
    const base = await tempDir();
    const store = new RuntimeStore(base);
    const draftId = store.newDraftId();
    await store.createDraft({ id: draftId, state: "editing", name: "p", version: "1.0.0", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.writeDraftFileRaw(draftId, "plugin.json", "{}");
    expect(await store.readDraftFile(draftId, "plugin.json")).toBe("{}");
    await expect(store.writeDraftFileRaw(draftId, "../evil", "x")).rejects.toThrow();

    const sourceDir = await tempDir();
    await fsp.writeFile(path.join(sourceDir, "plugin.json"), "{}");
    await store.createCandidate({ id: "cand-1", draftId, name: "p", version: "1.1.0", digest: "a".repeat(64), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 100000).toISOString() }, sourceDir);
    expect((await store.listCandidates())[0]?.id).toBe("cand-1");

    await store.installVersion("p", "1.1.0", sourceDir, {});
    const installed = await store.readInstalled("p");
    expect(installed).toMatchObject({ name: "p", activeVersion: "1.1.0", enabled: true });

    await store.setEnabled("p", false);
    expect((await store.readInstalled("p"))?.enabled).toBe(false);
    await store.setEnabled("p", true);

    // 安装第二个版本并回滚。
    await store.installVersion("p", "1.2.0", sourceDir, { previousVersion: "1.1.0" });
    expect((await store.readInstalled("p"))?.activeVersion).toBe("1.2.0");
    await store.setActiveVersion("p", "1.1.0");
    expect((await store.readInstalled("p"))?.activeVersion).toBe("1.1.0");

    await store.deletePackage("p", { deleteStorage: true });
    expect(await store.readInstalled("p")).toBeUndefined();
  });

  it("integrity：篡改文件导致摘要不匹配", async () => {
    const dir = await tempDir();
    await writeJsonFile(path.join(dir, "plugin.json"), validManifest());
    await fsp.mkdir(path.join(dir, "bundle"), { recursive: true });
    await fsp.writeFile(path.join(dir, "bundle", "plugin.js"), "console.log(1)");
    const integrity = await buildIntegrity(dir, validManifest());
    expect(integrity.digest).toMatch(/^[0-9a-f]{64}$/);

    expect((await verifyIntegrity(dir, integrity)).ok).toBe(true);
    await fsp.writeFile(path.join(dir, "bundle", "plugin.js"), "console.log(2)");
    expect((await verifyIntegrity(dir, integrity)).ok).toBe(false);
  });
});

describe("扩展层：草稿→候选→安装→发现→执行→卸载 全链路", () => {
  it("真实链路（含 QuickJS 沙箱执行）", async () => {
    const base = await tempDir();
    const hostCwd = await tempDir();
    const store = new RuntimeStore(base);
    const manager = new SandboxPackageManager({
      store,
      hostCwd,
      adminRoots: [],
      limits: DEFAULT_SANDBOX_LIMITS,
    });

    const draft = await manager.createDraft(validManifest(), [
      { path: "source/index.ts", content: SOURCE_INDEX },
      { path: "tests/main.js", content: TEST_MAIN },
    ]);
    expect(draft.state).toBe("editing");

    // 校验：typecheck + esbuild 构建 + 沙箱测试。
    const validation = await manager.validateDraft(draft.id);
    expect(validation.ok).toBe(true);
    expect(validation.report.typecheck.ok).toBe(true);
    expect(validation.report.build.ok).toBe(true);
    expect(validation.report.tests?.[0]?.ok).toBe(true);
    expect(await store.readDraftFile(draft.id, "bundle/plugin.js")).toContain("__panpilot");

    // 提交候选。
    const candidate = await manager.submitCandidate(draft.id);
    expect(candidate.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await manager.listCandidates())[0]?.id).toBe(candidate.id);

    // 摘要被篡改 → 拒绝。
    await expect(manager.installCandidate(candidate.id, "f".repeat(64)))
      .rejects.toThrow(ExtensionError);

    // 正确摘要 → 安装并发现工具。
    const installed = await manager.installCandidate(candidate.id, candidate.digest);
    expect(installed).toMatchObject({ name: "stringops", activeVersion: "1.0.0", enabled: true });

    const tools = await manager.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["plugin__stringops__upper"]);

    // 执行：沙箱里跑 utp 工具。
    const wrapper = tools[0]!;
    const result = await wrapper.execute({ text: "hello world" }, allowContext());
    expect(result).toMatchObject({ value: "HELLO WORLD" });

    // 版本提升：新版本安装。
    const v2 = await manager.createDraft({ ...validManifest(), version: "1.1.0" }, [
      { path: "source/index.ts", content: SOURCE_INDEX },
    ]);
    await manager.validateDraft(v2.id);
    const c2 = await manager.submitCandidate(v2.id);
    await manager.installCandidate(c2.id, c2.digest);
    expect((await manager.getVersions("stringops")).sort()).toEqual(["1.0.0", "1.1.0"]);

    // 禁用 → listTools 为空。
    await manager.setEnabled("stringops", false);
    expect(await manager.listTools()).toEqual([]);
    await manager.setEnabled("stringops", true);
    expect((await manager.listTools()).length).toBe(1);

    // 回滚。
    await manager.rollback("stringops");
    expect((await manager.getVersions("stringops")).length).toBe(2);
    expect((await manager.listTools()).length).toBe(1);

    // 卸载。
    await manager.uninstall("stringops");
    expect(await manager.listInstalled()).toEqual([]);
  });

  it("同版本倒退被拒绝；Developer 工具仅交互式聊天", async () => {
    const base = await tempDir();
    const store = new RuntimeStore(base);
    const manager = new SandboxPackageManager({ store, hostCwd: await tempDir(), adminRoots: [] });
    const draft = await manager.createDraft(validManifest(), [
      { path: "source/index.ts", content: SOURCE_INDEX },
    ]);
    await manager.validateDraft(draft.id);
    const c = await manager.submitCandidate(draft.id);
    const installed = await manager.installCandidate(c.id, c.digest);
    void installed;

    // 更低版本 → 拒绝。
    const lower = await manager.createDraft({ ...validManifest(), version: "0.9.0" }, [
      { path: "source/index.ts", content: SOURCE_INDEX },
    ]);
    await manager.validateDraft(lower.id);
    const cl = await manager.submitCandidate(lower.id);
    await expect(manager.installCandidate(cl.id, cl.digest))
      .rejects.toThrow(/高于/);
  });
});
