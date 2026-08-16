import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

/*
 * 长任务执行过程反馈的端到端 SSE 测试：
 * 用真实监听端口（app.listen）+ fetch 按块读取流，验证 accepted 立即 flush、
 * 路由侧心跳、慢响应 warning、心跳清理与客户端断开的中止传播。
 */
describe("/v1/chat SSE execution feedback", () => {
  const apps: TestApp[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(tempListenDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("flushes the accepted status as the first event before any model progress", async () => {
    const release = deferred<void>();
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        await release.promise;
        yield { type: "activity" };
        yield {
          type: "completion",
          completion: { content: "完成", toolCalls: [], model: "test-model" },
        };
      });
    const app = await listen({ modelClient: fakeModelClient(completeStream) });
    apps.push(app);

    const response = await postChat(app, { message: "你好", stream: true });
    const reader = response.body!.getReader();

    // 模型尚未产出任何事件时，accepted 已经可以读到。
    const first = await readEventsUntil(
      reader,
      (events) => events.length >= 1,
      2000,
    );
    expect(first[0]).toEqual({ type: "status", stage: "accepted", elapsedMs: 0 });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    release.resolve();
    const rest = await readAllEvents(reader, 2000);
    expect(rest.some((event) => event.type === "done")).toBe(true);
    expect(rest.some((event) => event.type === "activity")).toBe(false);
  });

  it("sends route-side heartbeats and a slow-response warning while the model is quiet", async () => {
    const release = deferred<void>();
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "开始" };
        await release.promise;
        yield {
          type: "completion",
          completion: { content: "开始", toolCalls: [], model: "test-model" },
        };
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const app = await listen({
      modelClient: fakeModelClient(completeStream),
      heartbeatIntervalMs: 30,
      slowWarningMs: 60,
    });
    apps.push(app);

    const response = await postChat(app, { message: "你好", stream: true });
    const reader = response.body!.getReader();
    const events = await readEventsUntil(reader, (current) => (
      current.some((event) => event.type === "warning")
    ), 3000);

    const heartbeat = events.find((event) => event.type === "heartbeat");
    const warning = events.find((event) => event.type === "warning");
    expect(heartbeat).toEqual(expect.objectContaining({
      type: "heartbeat",
      stage: "model",
      elapsedMs: expect.any(Number),
    }));
    expect(warning).toEqual(expect.objectContaining({
      type: "warning",
      code: "SLOW_RESPONSE",
      message: "等待模型响应时间较长，请耐心等待",
      elapsedMs: expect.any(Number),
    }));

    release.resolve();
    const rest = await readAllEvents(reader, 3000);
    const doneIndex = rest.findIndex((event) => event.type === "done");
    expect(doneIndex).toBeGreaterThan(-1);
    // 完成后不得再有心跳写入，且间隔已被清理。
    expect(rest.slice(doneIndex + 1).some((event) => event.type === "heartbeat")).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it("propagates a client disconnect to the agent and clears the heartbeat", async () => {
    let streamSignal: AbortSignal | undefined;
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* (request) {
        streamSignal = request.signal;
        yield { type: "content", content: "部分" };
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(request.signal?.reason ?? new Error("aborted"));
          }, { once: true });
        });
        yield {
          type: "completion",
          completion: { content: "部分", toolCalls: [], model: "test-model" },
        };
      });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const app = await listen({
      modelClient: fakeModelClient(completeStream),
      heartbeatIntervalMs: 30,
    });
    apps.push(app);

    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl(app)}/v1/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "你好", stream: true }),
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    await readEventsUntil(
      reader,
      (events) => events.some((event) => event.type === "content"),
      2000,
    );

    controller.abort();

    // 断开后：Agent 侧信号中止，心跳定时器被清理，流最终关闭。
    await vi.waitFor(() => {
      expect(streamSignal?.aborted).toBe(true);
    }, { timeout: 2000 });
    await vi.waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalled();
    }, { timeout: 2000 });
    await expect(readAllEvents(reader, 2000)).resolves.toBeDefined();
    clearIntervalSpy.mockRestore();
  });
});

function fakeModelClient(
  completeStream: ModelClient["completeStream"],
): ModelClient {
  return { complete: vi.fn<ModelClient["complete"]>(), completeStream };
}

/** 用一次性状态目录构建并监听应用，避免读写工作区真实状态文件。 */
async function listen(
  options: Parameters<typeof buildApp>[0],
): Promise<TestApp> {
  const scheduledTasksDir = await mkdtemp(path.join(tmpdir(), "panpilot-feedback-tasks-"));
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "panpilot-feedback-sessions-"));
  tempListenDirs.push(scheduledTasksDir, sessionsDir);
  const app = buildApp({ ...options, scheduledTasksDir, sessionsDir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

const tempListenDirs: string[] = [];

function postChat(
  app: TestApp,
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl(app)}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

type TestApp = Awaited<ReturnType<typeof buildApp>>;

function baseUrl(app: TestApp): string {
  const address = app.server.address();
  if (address !== null && typeof address === "object") {
    return `http://127.0.0.1:${address.port}`;
  }
  return address ?? "http://127.0.0.1";
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function readEventsUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (events: Array<Record<string, unknown>>) => boolean,
  timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("等待 SSE 事件超时")), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([
    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      while (!until(events)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const line = block.split("\n").find((entry) => entry.startsWith("data:"));
          if (line !== undefined) {
            events.push(JSON.parse(line.slice("data:".length).trimStart()) as Record<string, unknown>);
          }
          separator = buffer.indexOf("\n\n");
        }
      }
      return events;
    })(),
    deadline,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function readAllEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
  return readEventsUntil(reader, () => false, timeoutMs).catch(async (error) => {
    // 谓词永远不满足时，EOF 结束或超时都会到达这里；只有真正超时才向外抛错。
    if (error instanceof Error && error.message === "等待 SSE 事件超时") throw error;
    return [] as Array<Record<string, unknown>>;
  });
}
