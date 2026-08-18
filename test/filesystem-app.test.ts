import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import type { ModelClient, ModelStreamEvent } from "../src/model/model-client.js";

/**
 * 文件系统工具的 app 级接线：默认启用、根目录回退 ./workspace、
 * 显式关闭时不注册。通过 /v1/capabilities 的能力声明验证（能力声明优先约定）。
 */
describe("文件系统工具默认启用接线", () => {
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

  async function filesystemCapability(app: ReturnType<typeof buildApp>) {
    const response = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    return response.json().capabilities.filesystem as {
      status: string;
      roots: string[];
    };
  }

  it("默认启用：不传任何 fs 配置也注册工具并回退到 ./workspace", async () => {
    const app = buildApp({ modelClient: fakeModelClient() });
    apps.push(app);

    const capability = await filesystemCapability(app);
    expect(capability.status).toBe("available");
    expect(capability.roots).toEqual([path.resolve("./workspace")]);

    // 默认工作目录被自动创建，打开即可读写。
    const stats = await stat(path.resolve("./workspace"));
    expect(stats.isDirectory()).toBe(true);
  });

  it("注入 filesystemRoots 时按给定根目录声明，且根目录可实际使用", async () => {
    const root = await tempDir();
    const app = buildApp({
      modelClient: fakeModelClient(),
      filesystemRoots: [root],
    });
    apps.push(app);

    const capability = await filesystemCapability(app);
    expect(capability.status).toBe("available");
    expect(capability.roots).toEqual([path.resolve(root)]);
  });

  it("filesystemEnabled:false 显式关闭时不注册工具", async () => {
    const app = buildApp({
      modelClient: fakeModelClient(),
      filesystemEnabled: false,
      filesystemRoots: [await tempDir()],
    });
    apps.push(app);

    const capability = await filesystemCapability(app);
    expect(capability.status).toBe("reserved");
  });
});
