import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import type { ModelClient, ModelRequest, ModelStreamEvent } from "../src/model/model-client.js";

/**
 * 聊天授权闭环集成测试：/v1/chat SSE 中出现 permission_request，
 * 通过授权接口提交决定后，原工具调用在同一点恢复执行；拒绝则模型收到授权错误。
 */
describe("聊天授权闭环（SSE）", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const tempDirs: string[] = [];

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pan-pilot-sse-perm-"));
    tempDirs.push(dir);
    return dir;
  }

  /** 第一步返回 fs_write 工具调用，第二步返回最终文本；可捕获第二步模型看到的工具消息。 */
  function stepModel(
    target: string,
    onSecondStep?: (toolMessages: Array<{ content: string; name: string }>) => void,
  ): ModelClient {
    let invocations = 0;
    return {
      complete: async () => {
        throw new Error("unused");
      },
      completeStream: async function* (request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
        invocations += 1;
        if (invocations === 1) {
          yield {
            type: "completion",
            completion: {
              content: "",
              toolCalls: [{ id: "call_1", name: "fs_write", arguments: { path: target, content: "sse-hi" } }],
              model: "test-model",
            },
          };
          return;
        }
        const toolMessages = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => ({ content: message.content, name: message.name }));
        onSecondStep?.(toolMessages);
        yield {
          type: "completion",
          completion: { content: "写入完成", toolCalls: [], model: "test-model" },
        };
      },
    };
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function startApp(model: ModelClient, hostCwd: string) {
    const app = buildApp({ modelClient: model, hostCwd, filesystemRoots: [] });
    apps.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** 读取 SSE 流并返回全部事件；遇到 permission_request 时执行 onPermission 回调。 */
  async function consumeSse(
    baseUrl: string,
    onPermission: (request: { id: string }) => Promise<void>,
  ): Promise<Array<Record<string, any>>> {
    const response = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ messages: [{ role: "user", content: "写文件" }], stream: true }),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`chat 请求失败: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: Array<Record<string, any>> = [];
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.search(/\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, index + 1);
        buffer = buffer.slice(index + 2);
        const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        let event: Record<string, any>;
        try {
          event = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }
        events.push(event);
        if (event.type === "permission_request") {
          await onPermission(event.request as { id: string });
        }
        if (event.type === "done") return events;
      }
    }
    return events;
  }

  function decide(baseUrl: string, id: string, action: string) {
    return fetch(`${baseUrl}/v1/permission/requests/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  }

  it("SSE 授权后原工具调用恢复执行，文件写入一次", async () => {
    const hostCwd = await tempDir();
    const target = path.join(hostCwd, "hello.txt");
    const baseUrl = await startApp(stepModel(target), hostCwd);

    const events = await consumeSse(baseUrl, async (request) => {
      expect(request).toMatchObject({
        toolName: "fs_write",
        op: "write",
        origin: "chat",
        callId: "call_1",
      });
      const res = await decide(baseUrl, request.id, "allow_once");
      expect(res.ok).toBe(true);
    });

    const types = events.map((event) => event.type);
    expect(types).toContain("permission_request");
    expect(types).toContain("tool_execution");
    const done = events.find((event) => event.type === "done");
    expect(done?.result.content).toBe("写入完成");
    const writeExecutions = (done?.result.toolExecutions ?? [])
      .filter((execution: { name: string }) => execution.name === "fs_write");
    expect(writeExecutions).toHaveLength(1);
    expect(await readFile(target, "utf8")).toBe("sse-hi");
  });

  it("拒绝授权后模型收到 PERMISSION_DENIED 错误，并正常完成", async () => {
    const hostCwd = await tempDir();
    const target = path.join(hostCwd, "denied.txt");
    const seenToolMessages: Array<{ content: string; name: string }> = [];
    const baseUrl = await startApp(stepModel(target, (messages) => {
      seenToolMessages.push(...messages);
    }), hostCwd);

    const events = await consumeSse(baseUrl, async (request) => {
      const res = await decide(baseUrl, request.id, "reject");
      expect(res.ok).toBe(true);
    });

    const done = events.find((event) => event.type === "done");
    expect(done?.result.content).toBe("写入完成");
    // 文件未被写入。
    expect(await stat(target).catch(() => null)).toBeNull();
    // 第二次模型调用确实在工具消息中看到了授权错误。
    expect(seenToolMessages.length).toBe(1);
    expect(seenToolMessages[0]!.name).toBe("fs_write");
    expect(seenToolMessages[0]!.content).toContain("PERMISSION_DENIED");
  });
});
