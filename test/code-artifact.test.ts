import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore, MAX_ARTIFACT_BYTES } from "../src/artifacts/artifact-store.js";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";
import {
  createCodeArtifactTool,
  MAX_CODE_ARTIFACT_TOOL_CHARS,
} from "../src/tools/create-code-artifact.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { downloadFileName } from "../web/src/download-name.js";

describe("controlled code artifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("atomically stores and strictly restores a versioned UTF-8 artifact", async () => {
    const dir = await tempDir("panpilot-artifact-");
    const store = new ArtifactStore(dir);
    const saved = await store.save({
      name: "推箱子.html",
      format: "html",
      content: "<!doctype html><title>推箱子</title>",
    });

    expect(saved).toMatchObject({
      version: 1,
      name: "推箱子.html",
      format: "html",
      sizeBytes: Buffer.byteLength(saved.content, "utf8"),
    });
    await expect(new ArtifactStore(dir).read(saved.id)).resolves.toEqual(saved);
    const entries = await readdir(dir);
    expect(entries).toEqual([`${saved.id}.json`]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, entries[0]!))).mode & 0o777).toBe(0o600);
  });

  it("rejects corrupted, oversized, and path-like artifact input", async () => {
    const dir = await tempDir("panpilot-artifact-invalid-");
    const store = new ArtifactStore(dir);
    await writeFile(path.join(dir, "corrupted.json"), '{"version":2}', "utf8");

    await expect(store.read("corrupted")).resolves.toBeUndefined();
    await expect(store.read("../secret")).resolves.toBeUndefined();
    await expect(store.save({
      name: "../secret",
      format: "text",
      content: "secret",
    })).rejects.toThrow("不能包含路径");
    await expect(store.save({
      name: "too-large",
      format: "text",
      content: "x".repeat(MAX_ARTIFACT_BYTES + 1),
    })).rejects.toThrow("不超过");
  });

  it("creates a downloadable artifact without returning its source", async () => {
    const dir = await tempDir("panpilot-artifact-tool-");
    const store = new ArtifactStore(dir);
    const registry = new ToolRegistry([createCodeArtifactTool(store)]);

    const result = await registry.execute("create_code_artifact", {
      name: "sokoban game",
      format: "html",
      content: "<!doctype html><script>console.log('ok')</script>",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      name: "sokoban game.html",
      format: "html",
      sizeBytes: expect.any(Number),
      downloadUrl: expect.stringMatching(/^\/v1\/artifacts\/[a-zA-Z0-9-]+$/),
    });
    expect(result).not.toHaveProperty("content");
    await expect(registry.execute("create_code_artifact", {
      name: "too-long",
      format: "text",
      content: "x".repeat(MAX_CODE_ARTIFACT_TOOL_CHARS + 1),
    })).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
  });

  it("downloads artifacts with auth and attachment-only security headers", async () => {
    const root = await tempDir("panpilot-artifact-route-");
    const artifactsDir = path.join(root, "artifacts");
    const store = new ArtifactStore(artifactsDir);
    const saved = await store.save({
      name: "sokoban",
      format: "html",
      content: "<!doctype html><title>Sokoban</title>",
    });
    const app = buildApp({
      modelClient: unusedModelClient(),
      apiToken: "test-token",
      artifactsDir,
      scheduledTasksDir: path.join(root, "scheduled"),
      sessionsDir: path.join(root, "sessions"),
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${saved.id}`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${saved.id}`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(saved.content);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe("sandbox");
    await app.close();
  });

  it("serves HEAD artifact headers (filename) without a body", async () => {
    const root = await tempDir("panpilot-artifact-head-");
    const artifactsDir = path.join(root, "artifacts");
    const store = new ArtifactStore(artifactsDir);
    const saved = await store.save({
      name: "推箱子",
      format: "html",
      content: "<!doctype html><title>Sokoban</title>",
    });
    const app = buildApp({
      modelClient: unusedModelClient(),
      apiToken: "test-token",
      artifactsDir,
      scheduledTasksDir: path.join(root, "scheduled"),
      sessionsDir: path.join(root, "sessions"),
    });

    const response = await app.inject({
      method: "HEAD",
      url: `/v1/artifacts/${saved.id}`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    // Fastify 的 head 请求不带 body。
    expect(response.body).toBe("");
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-disposition"]).toContain("attachment");
    // RFC 5987 文件名应可被前端解析为真实中文名。
    expect(response.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("推箱子.html")}`,
    );
    const headResponse = new Response("", {
      headers: { "content-disposition": String(response.headers["content-disposition"]) },
    });
    expect(downloadFileName(headResponse, "fallback.txt")).toBe("推箱子.html");
    expect(Number(response.headers["content-length"])).toBe(
      Buffer.byteLength(saved.content, "utf8"),
    );
    await app.close();
  });

  it("extracts an RFC 5987 download name without accepting path components", () => {
    const named = new Response("", {
      headers: {
        "content-disposition":
          "attachment; filename=\"fallback.html\"; filename*=UTF-8''%E6%8E%A8%E7%AE%B1%E5%AD%90.html",
      },
    });
    const pathLike = new Response("", {
      headers: { "content-disposition": "attachment; filename=\"../unsafe.html\"" },
    });

    expect(downloadFileName(named, "fallback.txt")).toBe("推箱子.html");
    expect(downloadFileName(pathLike, "fallback.txt")).toBe("unsafe.html");
    expect(downloadFileName(new Response(""), "fallback.txt")).toBe("fallback.txt");
  });

  it("runs create_code_artifact through the real ChatAgent tool loop", async () => {
    const root = await tempDir("panpilot-artifact-agent-");
    const artifactsDir = path.join(root, "artifacts");
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "call-artifact",
          name: "create_code_artifact",
          arguments: {
            name: "sokoban",
            format: "html",
            content: "<!doctype html><title>Sokoban</title>",
          },
        }],
        model: "test-model",
      })
      .mockImplementationOnce(async (request) => {
        const toolMessage = request.messages.find((message) => message.role === "tool");
        const toolResult = JSON.parse(toolMessage?.content ?? "{}") as { downloadUrl?: string };
        return {
          content: `游戏已生成：${toolResult.downloadUrl}`,
          toolCalls: [],
          model: "test-model",
        };
      });
    const app = buildApp({
      modelClient: { complete, completeStream: vi.fn<ModelClient["completeStream"]>() },
      artifactsDir,
      scheduledTasksDir: path.join(root, "scheduled"),
      sessionsDir: path.join(root, "sessions"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "帮我开发一个推箱子小游戏", stream: false },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      message: string;
      execution: { toolExecutions: Array<{ name: string; status: string }> };
    }>();
    expect(payload.execution.toolExecutions).toEqual([
      expect.objectContaining({ name: "create_code_artifact", status: "success" }),
    ]);
    expect(payload.message).toMatch(/\/v1\/artifacts\/[a-zA-Z0-9-]+/);
    expect(complete.mock.calls[0]![0].tools.map((tool) => tool.name))
      .toContain("create_code_artifact");
    await app.close();
  });
});

function unusedModelClient(): ModelClient {
  return {
    complete: vi.fn<ModelClient["complete"]>(),
    completeStream: vi.fn<ModelClient["completeStream"]>(),
  };
}
