import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { buildApp } from "../src/app.js";
import { MediaStore } from "../src/media/media-store.js";
import type { MultimodalClient } from "../src/model/multimodal-client.js";
import type { ModelClient } from "../src/model/model-client.js";
import {
  ChatModelRegistry,
  DEFAULT_CHAT_MODEL_ID,
  DEEPSEEK_OFFICIAL_V4_FLASH,
  VOLCENGINE_DEEPSEEK_V4_FLASH,
} from "../src/model/model-registry.js";
import { pngBytes } from "./helpers/media-fixture.js";

/*
 * 这些测试通过 Fastify inject 在进程内走完整 HTTP 生命周期，
 * 同时用 ModelClient 假实现隔离真实 DeepSeek、API Key 和外部网络。
 */
describe("POST /v1/chat", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    // 主动关闭每个 Fastify 实例，避免 hook、logger 或资源句柄泄漏到下一条用例。
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
      modelId: DEFAULT_CHAT_MODEL_ID,
      model: "test-model",
      usage: { totalTokens: 12 },
      execution: { mode: "chat", toolExecutions: [] },
    });
    expect(complete).toHaveBeenCalledWith({
      messages: [
        {
          role: "system",
          content: expect.stringContaining("你是运行在宿主机上的 PanPilot Agent"),
        },
        {
          role: "user",
          content: "介绍一下你自己",
        },
      ],
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "calculator" }),
        expect.objectContaining({ name: "get_current_time" }),
        expect.objectContaining({ name: "date_calculator" }),
        expect.objectContaining({ name: "unit_converter" }),
        expect.objectContaining({ name: "text_stats" }),
        expect.objectContaining({ name: "create_code_artifact" }),
      ]),
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
    });
  });

  it("routes an explicit stable model id to the selected provider only", async () => {
    const volcengineComplete = vi.fn<ModelClient["complete"]>();
    const deepseekComplete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "official-call",
          name: "calculator",
          arguments: { operation: "multiply", left: 2, right: 3 },
        }],
        model: "deepseek-v4-flash",
      })
      .mockResolvedValueOnce({
        content: "官方线路回复：6",
        toolCalls: [],
        model: "deepseek-v4-flash",
      });
    const registry = dualRegistry(
      fakeModelClient(volcengineComplete),
      fakeModelClient(deepseekComplete),
    );
    const app = buildApp({ modelRegistry: registry });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: {
        message: "你好",
        model: DEEPSEEK_OFFICIAL_V4_FLASH,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      message: "官方线路回复：6",
      modelId: DEEPSEEK_OFFICIAL_V4_FLASH,
      model: "deepseek-v4-flash",
    });
    expect(deepseekComplete).toHaveBeenCalledTimes(2);
    expect(volcengineComplete).not.toHaveBeenCalled();
  });

  it("rejects unknown and unavailable model ids before calling any provider", async () => {
    const availableComplete = vi.fn<ModelClient["complete"]>();
    const registry = new ChatModelRegistry([
      modelEntry(VOLCENGINE_DEEPSEEK_V4_FLASH, "volcengine", fakeModelClient(availableComplete)),
      modelEntry(DEEPSEEK_OFFICIAL_V4_FLASH, "deepseek"),
    ], VOLCENGINE_DEEPSEEK_V4_FLASH);
    const app = buildApp({ modelRegistry: registry });
    apps.push(app);

    const unknown = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好", model: "unknown/model" },
    });
    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好", model: DEEPSEEK_OFFICIAL_V4_FLASH },
    });

    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: "UNSUPPORTED_MODEL",
      modelId: "unknown/model",
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      error: "MODEL_UNAVAILABLE",
      modelId: DEEPSEEK_OFFICIAL_V4_FLASH,
    });
    expect(availableComplete).not.toHaveBeenCalled();
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
      modelId: DEFAULT_CHAT_MODEL_ID,
      model: "test-model",
      usage: { totalTokens: 15 },
      execution: {
        mode: "chat",
        toolExecutions: [{
          id: "call_1",
          name: "calculator",
          status: "success",
          durationMs: expect.any(Number),
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
      modelId: DEFAULT_CHAT_MODEL_ID,
      model: "test-model",
      usage: null,
      execution: {
        mode: "chat",
        toolExecutions: [{
          id: "call_1",
          name: "calculator",
          status: "error",
          durationMs: expect.any(Number),
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
      { type: "status", stage: "accepted", elapsedMs: 0 },
      { type: "status", stage: "model", step: 1 },
      { type: "content", content: "你" },
      { type: "content", content: "好" },
      {
        type: "done",
        result: {
          content: "你好",
          modelId: DEFAULT_CHAT_MODEL_ID,
          model: "test-model",
          totalTokens: 7,
          steps: 1,
          toolExecutions: [],
        },
      },
    ]);
    expect(completeStream).toHaveBeenCalledTimes(1);
    expect(completeStream.mock.calls[0]![0].messages).toEqual([
      { role: "system", content: expect.stringContaining("PanPilot Agent") },
      { role: "user", content: "你好" },
    ]);
    expect(completeStream.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
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
      { type: "status", stage: "accepted", elapsedMs: 0 },
      { type: "status", stage: "model", step: 1 },
      { type: "status", stage: "tool", step: 1 },
      { type: "tool_start", id: "call_1", name: "calculator", step: 1 },
      {
        type: "tool_execution",
        execution: {
          id: "call_1",
          name: "calculator",
          status: "success",
          durationMs: expect.any(Number),
        },
      },
      { type: "status", stage: "model", step: 2 },
      { type: "content", content: "结果是 3" },
      {
        type: "done",
        result: expect.objectContaining({
          steps: 2,
          toolExecutions: [{
            id: "call_1",
            name: "calculator",
            status: "success",
            durationMs: expect.any(Number),
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
      { type: "status", stage: "accepted", elapsedMs: 0 },
      { type: "status", stage: "model", step: 1 },
      {
        type: "error",
        error: "CHAT_FAILED",
        message: "Agent 调用失败",
        elapsedMs: expect.any(Number),
      },
    ]);
  });

  it("reports a streaming model timeout as a distinct SSE error event", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "开头" };
        await new Promise(() => {});
      });
    const app = buildApp({
      modelClient: fakeModelClient(vi.fn(), completeStream),
      modelTimeoutMs: 30,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好", stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(parseSse(response.body)).toEqual([
      { type: "status", stage: "accepted", elapsedMs: 0 },
      { type: "status", stage: "model", step: 1 },
      { type: "content", content: "开头" },
      {
        type: "error",
        error: "MODEL_TIMEOUT",
        message: "模型响应超时，已取消",
        elapsedMs: expect.any(Number),
      },
    ]);
  });

  it("returns 504 with MODEL_TIMEOUT for a non-streaming model timeout", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockImplementation(() => new Promise(() => {}));
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      modelTimeoutMs: 30,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好" },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({
      error: "MODEL_TIMEOUT",
      message: "模型响应超时，已取消",
    });
  });

  it("reports a tool timeout even when the tool ignores its abort signal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panpilot-chat-route-"));
    tempDirs.push(root);
    const store = new MediaStore(root);
    const { mediaId } = await store.save(pngBytes(), "a.png");
    const analyze = vi.fn<MultimodalClient["analyze"]>()
      .mockImplementation(() => new Promise(() => {}));
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield {
          type: "completion",
          completion: {
            content: "",
            toolCalls: [{
              id: "call_1",
              name: "analyze_image",
              arguments: { mediaId },
            }],
            model: "test-model",
          },
        };
      });
    const app = buildApp({
      modelClient: fakeModelClient(vi.fn(), completeStream),
      mediaStore: store,
      multimodalClient: { analyze },
      toolTimeoutMs: 30,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "看看图", stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(parseSse(response.body)).toEqual([
      { type: "status", stage: "accepted", elapsedMs: 0 },
      { type: "status", stage: "model", step: 1 },
      { type: "status", stage: "tool", step: 1 },
      { type: "tool_start", id: "call_1", name: "analyze_image", step: 1 },
      {
        type: "error",
        error: "TOOL_TIMEOUT",
        message: "工具执行超时，已取消",
        elapsedMs: expect.any(Number),
      },
    ]);
  });

  it("reports an overall request timeout as REQUEST_TIMEOUT", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "开头" };
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield {
          type: "completion",
          completion: {
            content: "不会到达",
            toolCalls: [],
            model: "test-model",
          },
        };
      });
    const app = buildApp({
      modelClient: fakeModelClient(vi.fn(), completeStream),
      chatTimeoutMs: 30,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "你好", stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(parseSse(response.body)).toEqual([
      { type: "status", stage: "accepted", elapsedMs: 0 },
      { type: "status", stage: "model", step: 1 },
      { type: "content", content: "开头" },
      {
        type: "error",
        error: "REQUEST_TIMEOUT",
        message: "整体请求超时，已取消",
        elapsedMs: expect.any(Number),
      },
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
        scheduledTasks: { status: "available" },
        mcp: {
          status: "available",
          transports: ["stdio", "streamableHttp"],
          tools: true,
        },
        memory: { status: "reserved" },
        planning: { status: "reserved" },
      },
    });
  });

  it("returns an authenticated and redacted model catalog", async () => {
    const registry = dualRegistry(fakeModelClient(), fakeModelClient());
    const app = buildApp({
      modelRegistry: registry,
      apiToken: "internal-secret",
    });
    apps.push(app);

    const unauthorized = await app.inject({ method: "GET", url: "/v1/models" });
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer internal-secret" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({
      defaultModelId: VOLCENGINE_DEEPSEEK_V4_FLASH,
      models: [
        expect.objectContaining({
          id: VOLCENGINE_DEEPSEEK_V4_FLASH,
          provider: "volcengine",
          status: "available",
        }),
        expect.objectContaining({
          id: DEEPSEEK_OFFICIAL_V4_FLASH,
          provider: "deepseek",
          status: "available",
        }),
      ],
    });
    expect(authorized.body).not.toContain("secret");
    expect(authorized.body).not.toContain("baseURL");
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

  it("compacts long caller history and returns a safe continuation state", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "- 用户在准备发布说明\n- 保留约束：中文",
        toolCalls: [],
        model: "test-model",
        totalTokens: 11,
      })
      .mockResolvedValueOnce({
        content: "继续完成发布说明",
        toolCalls: [],
        model: "test-model",
        totalTokens: 5,
      });
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      contextOptions: {
        maxInputTokens: 100_000,
        targetInputTokens: 80_000,
        recentInputTokens: 10_000,
        summaryMaxTokens: 128,
        maxMessages: 8,
      },
    });
    apps.push(app);
    const messages = [
      { role: "system" as const, content: "始终用中文" },
      ...Array.from({ length: 11 }, (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `历史消息 ${index}`,
      })),
    ];

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { messages },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      message: "继续完成发布说明",
      usage: { totalTokens: 16 },
      execution: {
        context: { compactions: 1, summarizedMessages: 3 },
        contextMessages: expect.arrayContaining([
          { role: "system", content: "始终用中文" },
          { role: "system", content: expect.stringContaining("context summary v1") },
        ]),
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("toolCalls");
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ tools: [], maxOutputTokens: 128 });
    expect(complete.mock.calls[1]?.[0].messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("用户在准备发布说明"),
    });
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

function dualRegistry(volcengine: ModelClient, deepseek: ModelClient): ChatModelRegistry {
  return new ChatModelRegistry([
    modelEntry(VOLCENGINE_DEEPSEEK_V4_FLASH, "volcengine", volcengine),
    modelEntry(DEEPSEEK_OFFICIAL_V4_FLASH, "deepseek", deepseek),
  ], VOLCENGINE_DEEPSEEK_V4_FLASH);
}

function modelEntry(
  id: string,
  provider: "volcengine" | "deepseek",
  client?: ModelClient,
) {
  return {
    descriptor: {
      id,
      provider,
      label: id,
      upstreamModel: "deepseek-v4-flash",
      status: client ? "available" as const : "unavailable" as const,
      ...(client ? {} : { reason: "missing_api_key" as const }),
    },
    ...(client ? { client } : {}),
  };
}

/** 把 SSE 响应体按 `data: {json}` 行解析为事件数组。 */
function parseSse(body: string): unknown[] {
  return body.split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as unknown);
}
