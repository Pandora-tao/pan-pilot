import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

/*
 * 这些测试通过 Fastify inject 在进程内走完整 HTTP 生命周期，
 * 同时用 ModelClient 假实现隔离真实 DeepSeek、API Key 和外部网络。
 */
describe("POST /v1/chat", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    // 主动关闭每个 Fastify 实例，避免 hook、logger 或资源句柄泄漏到下一条用例。
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("returns the agent response", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "你好",
      toolCalls: [],
      model: "test-model",
      totalTokens: 12,
    });
    const app = buildApp({ modelClient: fakeModelClient(complete) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "介绍一下你自己" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      message: "你好",
      model: "test-model",
      usage: { totalTokens: 12 },
      execution: { mode: "chat", toolExecutions: [] },
    });
    expect(complete).toHaveBeenCalledWith({
      messages: [
        {
          role: "system",
          content:
            "你是 PanPilot，一个简洁、准确的 AI 助手。"
            + "当工具返回下载地址时，把完整的 /v1/files/xxx 地址写在回复末尾。",
        },
        {
          role: "user",
          content: "介绍一下你自己",
        },
      ],
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "calculator" }),
        expect.objectContaining({ name: "get_current_time" }),
      ]),
    });
  });

  it("forwards complete message history without replacing caller context", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "知道了",
      toolCalls: [],
      model: "test-model",
    });
    const app = buildApp({ modelClient: fakeModelClient(complete) });
    apps.push(app);
    const messages = [
      { role: "system" as const, content: "完整的人设提示词" },
      { role: "assistant" as const, content: "之前的回复" },
      { role: "user" as const, content: "继续" },
    ];

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { messages, stream: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      message: "知道了",
      model: "test-model",
      usage: null,
    });
    expect(complete).toHaveBeenCalledWith({
      messages,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "calculator" }),
        expect.objectContaining({ name: "get_current_time" }),
      ]),
    });
  });

  it("runs the tool loop and returns only sanitized execution summaries", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "calculator",
          arguments: { operation: "add", left: 1, right: 2 },
        }],
        model: "test-model",
        totalTokens: 10,
      })
      .mockResolvedValueOnce({
        content: "结果是 3",
        toolCalls: [],
        model: "test-model",
        totalTokens: 5,
      });
    const app = buildApp({ modelClient: fakeModelClient(complete) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "1 + 2 = ?" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      message: "结果是 3",
      model: "test-model",
      usage: { totalTokens: 15 },
      execution: {
        mode: "chat",
        toolExecutions: [{
          id: "call_1",
          name: "calculator",
          status: "success",
        }],
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);

    // 原始参数和工具结果只回填给模型，不进入 HTTP 响应。
    const secondCallMessages = complete.mock.calls[1]![0].messages;
    expect(secondCallMessages).toContainEqual({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call_1",
        name: "calculator",
        arguments: { operation: "add", left: 1, right: 2 },
      }],
    });
    expect(secondCallMessages).toContainEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "calculator",
      content: '{"operation":"add","left":1,"right":2,"result":3}',
    });
  });

  it("records tool failures as summaries without leaking details", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "calculator",
          arguments: { operation: "divide", left: 1, right: 0 },
        }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "0 不能作为除数",
        toolCalls: [],
        model: "test-model",
      });
    const app = buildApp({ modelClient: fakeModelClient(complete) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "1 / 0 = ?" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      message: "0 不能作为除数",
      model: "test-model",
      usage: null,
      execution: {
        mode: "chat",
        toolExecutions: [{
          id: "call_1",
          name: "calculator",
          status: "error",
        }],
      },
    });
    expect(complete.mock.calls[1]![0].messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call_1",
        name: "calculator",
        content: expect.stringContaining("工具 calculator 执行失败"),
      }),
    );
  });

  it("logs complete prompts and replies when content logging is enabled", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "日志中的完整回复",
      toolCalls: [],
      model: "test-model",
      totalTokens: 18,
    });
    const info = vi.fn();
    const warn = vi.fn();
    const logger = testLogger({ info, warn });
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      logChatContent: true,
      loggerInstance: logger,
    });
    apps.push(app);
    const messages = [
      { role: "system" as const, content: "需要记录的人设" },
      { role: "user" as const, content: "需要记录的问题" },
    ];

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { messages },
    });

    expect(response.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      { event: "pan_pilot.chat.content_logging_enabled" },
      expect.stringContaining("private data"),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pan_pilot.chat.prompt",
        messageCount: 2,
        messages,
      }),
      "PanPilot chat prompt",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pan_pilot.chat.reply",
        reply: "日志中的完整回复",
        model: "test-model",
        totalTokens: 18,
        durationMs: expect.any(Number),
      }),
      "PanPilot chat reply",
    );
  });

  it("does not log prompts or replies when content logging is disabled", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "不应记录的回复",
      toolCalls: [],
      model: "test-model",
    });
    const info = vi.fn();
    const logger = testLogger({ info });
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      logChatContent: false,
      loggerInstance: logger,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "不应记录的问题" },
    });

    expect(response.statusCode).toBe(200);
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "pan_pilot.chat.prompt" }),
      expect.anything(),
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "pan_pilot.chat.reply" }),
      expect.anything(),
    );
  });

  it("streams chat responses as SSE events", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "你" };
        yield { type: "content", content: "好" };
        yield {
          type: "completion",
          completion: {
            content: "你好",
            toolCalls: [],
            model: "test-model",
            totalTokens: 7,
          },
        };
      });
    const app = buildApp({ modelClient: fakeModelClient(vi.fn(), completeStream) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { messages: [{ role: "user", content: "你好" }], stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(parseSse(response.body)).toEqual([
      { type: "content", content: "你" },
      { type: "content", content: "好" },
      {
        type: "done",
        result: {
          content: "你好",
          model: "test-model",
          totalTokens: 7,
          steps: 1,
          toolExecutions: [],
        },
      },
    ]);
    expect(completeStream).toHaveBeenCalledTimes(1);
    expect(completeStream.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "你好" },
    ]);
  });

  it("streams only sanitized tool execution summaries", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementationOnce(async function* () {
        yield {
          type: "completion",
          completion: {
            content: "",
            toolCalls: [{
              id: "call_1",
              name: "calculator",
              arguments: { operation: "add", left: 1, right: 2 },
            }],
            model: "test-model",
            totalTokens: 10,
          },
        };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "content", content: "结果是 3" };
        yield {
          type: "completion",
          completion: {
            content: "结果是 3",
            toolCalls: [],
            model: "test-model",
            totalTokens: 5,
          },
        };
      });
    const app = buildApp({ modelClient: fakeModelClient(vi.fn(), completeStream) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "1 + 2 = ?", stream: true },
    });

    const events = parseSse(response.body) as Array<Record<string, unknown>>;
    expect(events).toEqual([
      {
        type: "tool_execution",
        execution: { id: "call_1", name: "calculator", status: "success" },
      },
      { type: "content", content: "结果是 3" },
      {
        type: "done",
        result: expect.objectContaining({
          steps: 2,
          toolExecutions: [{
            id: "call_1",
            name: "calculator",
            status: "success",
          }],
        }),
      },
    ]);
    // 原始参数和工具结果只回填给模型，不进入 SSE 事件。
    expect(JSON.stringify(events)).not.toContain("operation");
    expect(JSON.stringify(events)).not.toContain("arguments");
  });

  it("sends an SSE error event when the agent fails", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        throw new Error("模型挂了");
      });
    const app = buildApp({ modelClient: fakeModelClient(vi.fn(), completeStream) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好", stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(parseSse(response.body)).toEqual([
      { type: "error", error: "CHAT_FAILED", message: "Agent 调用失败" },
    ]);
  });

  it("protects versioned APIs when an internal token is configured", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "你好",
      toolCalls: [],
      model: "test-model",
    });
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      apiToken: "internal-secret",
    });
    apps.push(app);

    const unauthorized = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
    });
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { authorization: "Bearer internal-secret" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({
      apiVersion: "v1",
      capabilities: {
        chat: { status: "available", streaming: true },
        tools: { status: "available" },
        search: { status: "available" },
        memory: { status: "reserved" },
        planning: { status: "reserved" },
      },
    });
  });

  it("rejects an empty message", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    const app = buildApp({ modelClient: fakeModelClient(complete) });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_REQUEST" });
    expect(complete).not.toHaveBeenCalled();
  });
});

function testLogger(
  overrides: { info?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn> },
): FastifyBaseLogger {
  // Fastify 要求完整 logger 接口；这里只替换用例关心的方法，其余方法使用空 mock 补齐。
  const logger = {
    level: "info",
    fatal: vi.fn(),
    error: vi.fn(),
    warn: overrides.warn ?? vi.fn(),
    info: overrides.info ?? vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as FastifyBaseLogger;
}

/** 构造满足 ModelClient 接口的假实现；不传 completeStream 时提供不会被调用的桩。 */
function fakeModelClient(
  complete: ModelClient["complete"] = vi.fn(),
  completeStream: ModelClient["completeStream"] = vi.fn(),
): ModelClient {
  return { complete, completeStream };
}

/** 把 SSE 响应体按 `data: {json}` 行解析为事件数组。 */
function parseSse(body: string): unknown[] {
  return body.split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as unknown);
}
