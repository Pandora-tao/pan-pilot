import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import type { ModelClient, ModelStreamEvent } from "../src/model/model-client.js";

/**
 * HostRuntime 核心能力的 app 级接线：文件系统与 Terminal 默认启用、
 * hostCwd 默认进程启动目录、adminRoots 默认为空（整机可访问）、
 * 显式关闭时不注册。通过 /v1/capabilities 的能力声明验证（能力声明优先约定）。
 */
describe("HostRuntime 能力默认启用接线", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const tempDirs: string[] = [];

  function fakeModelClient(): ModelClient {
    return {
      complete: async () => ({
        content: "ok",
        toolCalls: [],
        model: "test-model",
      }),
      completeStream: async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "completion",
          completion: { content: "", toolCalls: [], model: "test-model" },
        };
      },
    };
  }

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pan-pilot-fs-app-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function capability(app: ReturnType<typeof buildApp>) {
    const response = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    const capabilities = response.json().capabilities as {
      filesystem: { status: string; roots: string[] };
      terminal: { status: string };
      hostRuntime: {
        status: string;
        filesystem: { enabled: boolean };
        terminal: { enabled: boolean };
        permission: { mode: string };
        defaultCwd: string;
        adminRoots: string[];
      };
    };
    return capabilities;
  }

  it("默认启用：整机可访问（adminRoots 空）、hostCwd 为进程启动目录", async () => {
    const app = buildApp({ modelClient: fakeModelClient() });
    apps.push(app);

    const capabilities = await capability(app);
    expect(capabilities.filesystem.status).toBe("available");
    expect(capabilities.filesystem.roots).toEqual([]);
    expect(capabilities.terminal.status).toBe("available");
    expect(capabilities.hostRuntime.status).toBe("available");
    expect(capabilities.hostRuntime.filesystem.enabled).toBe(true);
    expect(capabilities.hostRuntime.terminal.enabled).toBe(true);
    expect(capabilities.hostRuntime.permission.mode).toBe("permissioned");
    expect(capabilities.hostRuntime.defaultCwd).toBe(path.resolve(process.cwd()));
    expect(capabilities.hostRuntime.adminRoots).toEqual([]);
  });

  it("注入 filesystemRoots 时作为管理员级限制声明", async () => {
    const root = await tempDir();
    const app = buildApp({
      modelClient: fakeModelClient(),
      filesystemRoots: [root],
    });
    apps.push(app);

    const capabilities = await capability(app);
    expect(capabilities.filesystem.status).toBe("available");
    expect(capabilities.filesystem.roots).toEqual([path.resolve(root)]);
    expect(capabilities.hostRuntime.adminRoots).toEqual([path.resolve(root)]);
  });

  it("filesystemEnabled:false 关闭 fs 工具，但 terminal 仍独立启用", async () => {
    const app = buildApp({
      modelClient: fakeModelClient(),
      filesystemEnabled: false,
      filesystemRoots: [await tempDir()],
    });
    apps.push(app);

    const capabilities = await capability(app);
    expect(capabilities.filesystem.status).toBe("reserved");
    expect(capabilities.terminal.status).toBe("available");
    expect(capabilities.hostRuntime.filesystem.enabled).toBe(false);
  });

  it("terminalEnabled:false 显式关闭 terminal 工具", async () => {
    const app = buildApp({
      modelClient: fakeModelClient(),
      terminalEnabled: false,
    });
    apps.push(app);

    const capabilities = await capability(app);
    expect(capabilities.terminal.status).toBe("reserved");
    expect(capabilities.hostRuntime.terminal.enabled).toBe(false);
  });
});
