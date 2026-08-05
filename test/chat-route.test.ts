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
    const app = buildApp({ modelClient: { complete } });
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
      execution: { mode: "chat", toolCalls: [] },
    });
    expect(complete).toHaveBeenCalledWith({
      messages: [
        {
          role: "system",
          content: "你是 PanPilot，一个简洁、准确的 AI 助手。",
        },
        {
          role: "user",
          content: "介绍一下你自己",
        },
      ],
      tools: [],
    });
  });

  it("forwards complete message history without replacing caller context", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "知道了",
      toolCalls: [],
      model: "test-model",
    });
    const app = buildApp({ modelClient: { complete } });
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
    expect(complete).toHaveBeenCalledWith({ messages, tools: [] });
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
      modelClient: { complete },
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
      modelClient: { complete },
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

  it("keeps future streaming on an explicit reserved contract", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    const app = buildApp({ modelClient: { complete } });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好", stream: true },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: "CAPABILITY_NOT_IMPLEMENTED",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("protects versioned APIs when an internal token is configured", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "你好",
      toolCalls: [],
      model: "test-model",
    });
    const app = buildApp({ modelClient: { complete }, apiToken: "internal-secret" });
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
        chat: { status: "available", streaming: false },
        tools: { status: "reserved" },
        memory: { status: "reserved" },
        planning: { status: "reserved" },
      },
    });
  });

  it("rejects an empty message", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    const app = buildApp({ modelClient: { complete } });
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
