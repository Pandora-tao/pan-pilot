import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHostFilesystemService } from "../src/tools/host-filesystem.js";
import { createHostTerminalService } from "../src/tools/host-terminal.js";
import { DEFAULT_SANDBOX_LIMITS, emptyPermissions, mergePermissions } from "../src/extension/types.js";
import type { ResolvedPermissions, SandboxLimits } from "../src/extension/types.js";
import { runSandboxCall } from "../src/extension/sandbox/worker-runner.js";
import type { SandboxHostDeps } from "../src/extension/sandbox/host-bridge.js";
import { allowContext } from "./helpers/tool-ctx.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pan-pilot-sandbox-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function deps(hostCwd: string, caps: ResolvedPermissions, limits = DEFAULT_SANDBOX_LIMITS): {
  caps: ResolvedPermissions;
  limits: SandboxLimits;
  build: (ctx?: ReturnType<typeof allowContext>) => SandboxHostDeps;
} {
  return {
    caps,
    limits,
    build: (ctx = allowContext()) => ({
      defaultCwd: hostCwd,
      limits,
      caps,
      meta: { name: "testpkg", version: "1.0.0" },
      fsService: createHostFilesystemService({ hostCwd, adminRoots: [] }),
      terminalService: createHostTerminalService({ defaultCwd: hostCwd }),
      storage: {
        read: async () => ({}),
        write: async () => {},
      },
      credentials: new Map(),
    }) as SandboxHostDeps,
  };
}

function bundle(sourceFn: string, iife = true): string {
  if (!iife) return sourceFn;
  return `globalThis.__panpilot = (function () { ${sourceFn}; return { tools: globalThis.__panpilotTools }; })();`;
}

const SIMPLE_TOOLS = `
  globalThis.__panpilotTools = [{
    name: "hello",
    description: "问候",
    parameters: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
    run: function (input) { return { greeting: "hi " + (input && input.name || "?"), length: String((input && input.name || "")).length }; },
  }];
`;

describe("QuickJS 沙箱：纯计算工具", () => {
  it("调用工具并返回结构化结果", async () => {
    const hostCwd = await tempDir();
    const d = deps(hostCwd, emptyPermissions());
    const result = await runSandboxCall({
      bundleSource: bundle(SIMPLE_TOOLS),
      toolName: "hello",
      input: { name: "PanPilot" },
      meta: { name: "testpkg", version: "1.0.0" },
      caps: d.caps,
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ greeting: "hi PanPilot", length: 8 });
  });

  it("discover 模式枚举工具声明", async () => {
    const hostCwd = await tempDir();
    const d = deps(hostCwd, emptyPermissions());
    const result = await runSandboxCall({
      bundleSource: bundle(SIMPLE_TOOLS),
      toolName: "__discover__",
      input: null,
      meta: { name: "testpkg", version: "1.0.0" },
      caps: d.caps,
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([{
      name: "hello",
      description: "问候",
      parameters: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
    }]);
  });

  it("无限循环被中断（沙箱不挂死宿主）", async () => {
    const hostCwd = await tempDir();
    const d = deps(hostCwd, emptyPermissions(), { ...DEFAULT_SANDBOX_LIMITS, cpuLimitMs: 300 });
    const result = await runSandboxCall({
      bundleSource: `globalThis.__panpilotTools = [{ name: "spin", description: "d", parameters: {}, run: function () { let x = 0; for (;;) { x += 1; } } }]; globalThis.__panpilot = { tools: globalThis.__panpilotTools };`,
      toolName: "spin",
      input: {},
      meta: { name: "testpkg", version: "1.0.0" },
      caps: d.caps,
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(false);
  });

  it("沙箱内无法访问 process / require / fetch", async () => {
    const hostCwd = await tempDir();
    const d = deps(hostCwd, emptyPermissions());
    const probeBundle = [
      "globalThis.__panpilot = { tools: [{",
      "  name: 'probe', description: 'd', parameters: {},",
      "  run: function () { return { hasProcess: typeof process, hasRequire: typeof require, hasFetch: typeof fetch }; },",
      "}] };",
    ].join("\n");
    const result = await runSandboxCall({
      bundleSource: probeBundle,
      toolName: "probe",
      input: {},
      meta: { name: "testpkg", version: "1.0.0" },
      caps: d.caps,
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ hasProcess: "undefined", hasRequire: "undefined", hasFetch: "undefined" });
  });
});

describe("QuickJS 沙箱：宿主桥", () => {
  it("fs 读文件经宿主桥与授权闭环返回内容", async () => {
    const hostCwd = await tempDir();
    const target = path.join(hostCwd, "data.txt");
    await writeFile(target, "sandbox content");
    const caps = mergePermissions({ files: ["**"] });
    const d = deps(hostCwd, caps);
    const fsBundle = [
      "globalThis.__panpilot = { tools: [{",
      "  name: 'readit', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },",
      "  run: async function (input) { const r = await globalThis.panpilot.fs.read({ path: input.path, limit: 1000, offset: 0 }); return { content: r.content, hasMore: !!r.hasMore }; },",
      "}] };",
    ].join("\n");
    const result = await runSandboxCall({
      bundleSource: fsBundle,
      toolName: "readit",
      input: { path: "data.txt" },
      meta: { name: "testpkg", version: "1.0.0" },
      caps,
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ content: "sandbox content", hasMore: false });
  });

  it("未声明文件权限时拒绝 fs 操作", async () => {
    const hostCwd = await tempDir();
    const d = deps(hostCwd, emptyPermissions());
    const fsBundle = [
      "globalThis.__panpilot = { tools: [{",
      "  name: 'readit', description: 'd', parameters: {},",
      "  run: async function () { try { await globalThis.panpilot.fs.read({ path: 'data.txt' }); return { denied: false }; } catch (e) { return { denied: true, message: String(e.message) }; } },",
      "}] };",
    ].join("\n");
    const result = await runSandboxCall({
      bundleSource: fsBundle,
      toolName: "readit",
      input: {},
      meta: { name: "testpkg", version: "1.0.0" },
      caps: emptyPermissions(),
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ denied: true });
  });

  it("最高宿主调用次数上限生效", async () => {
    const hostCwd = await tempDir();
    const d = deps(hostCwd, emptyPermissions(), { ...DEFAULT_SANDBOX_LIMITS, maxHostCalls: 5 });
    const clockBundle = [
      "globalThis.__panpilot = { tools: [{",
      "  name: 'tick', description: 'd', parameters: {},",
      "  run: async function () { let count = 0; for (let i = 0; i < 50; i += 1) { try { await globalThis.panpilot.clock.now(); count += 1; } catch (e) { break; } } return { count }; },",
      "}] };",
    ].join("\n");
    const result = await runSandboxCall({
      bundleSource: clockBundle,
      toolName: "tick",
      input: {},
      meta: { name: "testpkg", version: "1.0.0" },
      caps: emptyPermissions(),
      limits: d.limits,
      deps: d.build(),
      ctx: allowContext(),
    });
    expect(result.ok).toBe(true);
    // 前 5 次成功，第 6 次起被拒绝。
    expect((result.value as { count: number }).count).toBe(5);
  });
});
