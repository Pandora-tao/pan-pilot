import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentMaxStepsError,
  AgentTimeoutError,
  ChatAgent,
  findAgentTimeout,
  type AgentRunResult,
  type AgentStreamEvent,
} from "../src/agent/chat-agent.js";
import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
} from "../src/model/model-client.js";
import type { AgentTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

/*
 * ChatAgent 单元测试：用内存中的假 ModelClient 和假工具隔离真实模型与网络，
 * 覆盖工具循环、失败回填、取消信号和最大轮次控制。
 */
describe("ChatAgent", () => {
  it("returns the final text in a single step when no tools are requested", async () => {
    const client = createModelClient([{
      content: "你好",
      toolCalls: [],
      model: "test-model",
      totalTokens: 12,
    }]);
    const agent = new ChatAgent(client, new ToolRegistry());

    const result = await agent.chat([{ role: "user", content: "hi" }]);

    expect(result).toEqual({
      content: "你好",
      model: "test-model",
      totalTokens: 12,
      steps: 1,
      toolExecutions: [],
    });
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(client.complete).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: expect.any(AbortSignal),
    });
    expect(client.completeStream).not.toHaveBeenCalled();
  });

  it("executes tool calls, feeds results back, and loops until the final text", async () => {
    const tool = createEchoTool();
    const client = createModelClient([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 7 } }],
        model: "test-model",
        totalTokens: 4,
      },
      {
        content: "完成",
        toolCalls: [],
        model: "test-model",
        totalTokens: 6,
      },
    ]);
    const agent = new ChatAgent(client, new ToolRegistry([tool]));

    const result = await agent.chat([{ role: "user", content: "echo 7" }]);

    expect(result).toMatchObject({
      content: "完成",
      model: "test-model",
      totalTokens: 10,
      steps: 2,
    });
    expect(result.toolExecutions).toEqual([
      { id: "call_1", name: "echo", status: "success", durationMs: expect.any(Number) },
    ]);
    // 摘要只含 id/name/status/durationMs，不携带原始参数或工具结果。
    expect(Object.keys(result.toolExecutions[0] ?? {})).toEqual([
      "id",
      "name",
      "status",
      "durationMs",
    ]);
    // 第二个参数为 ToolExecutionContext（含 signal），不再直接传 AbortSignal。
    const callArgs = tool.execute.mock.calls[0] as unknown[];
    expect(callArgs[0]).toEqual({ value: 7 });
    expect(callArgs[1]).toMatchObject({ origin: "chat", callId: "call_1" });
    expect((callArgs[1] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    expect(client.complete).toHaveBeenCalledTimes(2);
    expect(client.complete.mock.calls[1]![0].messages).toContainEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 7 } }],
    });
    expect(client.complete.mock.calls[1]![0].messages).toContainEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "echo",
      content: '{"value":7}',
    });
  });

  it("records tool failures and lets the model recover with the error message", async () => {
    const tool = createEchoTool(
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    const client = createModelClient([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
        model: "test-model",
      },
      {
        content: "抱歉，刚才出错了",
        toolCalls: [],
        model: "test-model",
      },
    ]);
    const agent = new ChatAgent(client, new ToolRegistry([tool]));

    const result = await agent.chat([{ role: "user", content: "echo 1" }]);

    expect(result.toolExecutions).toEqual([
      { id: "call_1", name: "echo", status: "error", durationMs: expect.any(Number) },
    ]);
    expect(client.complete.mock.calls[1]![0].messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call_1",
        content: "工具 echo 执行失败：boom",
      }),
    );
  });

  it("does not call the model when the signal is already aborted", async () => {
    const client = createModelClient([{
      content: "不应调用",
      toolCalls: [],
      model: "test-model",
    }]);
    const agent = new ChatAgent(client, new ToolRegistry());
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));

    await expect(agent.chat([{ role: "user", content: "hi" }], controller.signal))
      .rejects.toThrow("用户取消");
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("propagates an abort raised during tool execution as control flow", async () => {
    const controller = new AbortController();
    const tool = createEchoTool(
      vi.fn(async () => {
        controller.abort(new Error("用户取消"));
        throw new Error("被中断");
      }),
    );
    const client = createModelClient([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
        model: "test-model",
      },
    ]);
    const agent = new ChatAgent(client, new ToolRegistry([tool]));

    await expect(
      agent.chat([{ role: "user", content: "echo 1" }], controller.signal),
    ).rejects.toThrow("用户取消");
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("stops with an explicit error when maxSteps is exhausted", async () => {
    const client = createModelClient([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
        model: "test-model",
      },
      {
        content: "",
        toolCalls: [{ id: "call_2", name: "echo", arguments: { value: 2 } }],
        model: "test-model",
      },
    ]);
    const agent = new ChatAgent(
      client,
      new ToolRegistry([createEchoTool()]),
      { maxSteps: 2 },
    );

    await expect(agent.chat([{ role: "user", content: "echo 1" }]))
      .rejects.toMatchObject({
        name: "AgentMaxStepsError",
        steps: 2,
      });
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid maxSteps values", () => {
    const client = createModelClient([]);
    const registry = new ToolRegistry();

    expect(() => new ChatAgent(client, registry, { maxSteps: 0 }))
      .toThrow("maxSteps");
    expect(() => new ChatAgent(client, registry, { maxSteps: 1.5 }))
      .toThrow("maxSteps");
  });

  it("streams content deltas and finishes with the full result", async () => {
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
            totalTokens: 3,
          },
        };
      });
    const complete = vi.fn<ModelClient["complete"]>();
    const agent = new ChatAgent({ complete, completeStream }, new ToolRegistry());

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.chatStream([{ role: "user", content: "hi" }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", stage: "model", step: 1 },
      { type: "content", content: "你" },
      { type: "content", content: "好" },
      {
        type: "done",
        result: {
          content: "你好",
          model: "test-model",
          totalTokens: 3,
          steps: 1,
          toolExecutions: [],
        },
      },
    ]);
    expect(completeStream).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: expect.any(AbortSignal),
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("streams tool execution summaries and loops until done", async () => {
    const tool = createEchoTool();
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementationOnce(async function* () {
        yield {
          type: "completion",
          completion: {
            content: "",
            toolCalls: [{
              id: "call_1",
              name: "echo",
              arguments: { value: 7 },
            }],
            model: "test-model",
            totalTokens: 4,
          },
        };
      })
      .mockImplementationOnce(async function* () {
        yield { type: "content", content: "完成" };
        yield {
          type: "completion",
          completion: {
            content: "完成",
            toolCalls: [],
            model: "test-model",
            totalTokens: 6,
          },
        };
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry([tool]),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.chatStream([{ role: "user", content: "echo 7" }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", stage: "model", step: 1 },
      { type: "status", stage: "tool", step: 1 },
      { type: "tool_start", id: "call_1", name: "echo", step: 1 },
      {
        type: "tool_execution",
        execution: {
          id: "call_1",
          name: "echo",
          status: "success",
          durationMs: expect.any(Number),
        },
      },
      { type: "status", stage: "model", step: 2 },
      { type: "content", content: "完成" },
      {
        type: "done",
        result: {
          content: "完成",
          model: "test-model",
          totalTokens: 10,
          steps: 2,
          toolExecutions: [{
            id: "call_1",
            name: "echo",
            status: "success",
            durationMs: expect.any(Number),
          }],
        },
      },
    ]);
    expect(completeStream).toHaveBeenCalledTimes(2);
    expect(completeStream.mock.calls[1]![0].messages).toContainEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "echo",
      content: '{"value":7}',
    });
    // 事件只暴露 id/name/status/durationMs，不携带工具参数或内部提示词。
    expect(JSON.stringify(events)).not.toContain("arguments");
    expect(JSON.stringify(events)).not.toContain('"value":7');
  });

  it("keeps single-step results identical between complete and stream modes", async () => {
    await expectModeParity([{
      content: "你好",
      toolCalls: [],
      model: "test-model",
      totalTokens: 3,
    }]);
  });

  it("keeps successful tool results identical between complete and stream modes", async () => {
    await expectModeParity([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 7 } }],
        model: "test-model",
        totalTokens: 4,
      },
      {
        content: "完成",
        toolCalls: [],
        model: "test-model",
        totalTokens: 6,
      },
    ], () => createEchoTool());
  });

  it("keeps failed tool recovery identical between complete and stream modes", async () => {
    await expectModeParity([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
        model: "test-model",
      },
      {
        content: "已处理工具错误",
        toolCalls: [],
        model: "test-model",
      },
    ], () => createEchoTool(vi.fn(async () => {
      throw new Error("boom");
    })));
  });

  it("keeps multi-round tool results identical between complete and stream modes", async () => {
    await expectModeParity([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
        model: "test-model",
        totalTokens: 2,
      },
      {
        content: "",
        toolCalls: [{ id: "call_2", name: "echo", arguments: { value: 2 } }],
        model: "test-model",
        totalTokens: 3,
      },
      {
        content: "两轮完成",
        toolCalls: [],
        model: "test-model",
        totalTokens: 5,
      },
    ], () => createEchoTool());
  });

  it("keeps compacted context results identical between complete and stream modes", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "必须使用中文" },
      ...Array.from({ length: 10 }, (_, index): ModelMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `历史消息 ${index} ${"x".repeat(24)}`,
      })),
    ];
    const context = {
      maxInputTokens: 10_000,
      targetInputTokens: 8_000,
      recentInputTokens: 80,
      summaryMaxTokens: 64,
      maxMessages: 8,
    };
    const summary: ModelCompletion = {
      content: "- 已压缩的历史",
      toolCalls: [],
      model: "summary-model",
      totalTokens: 9,
    };
    const final: ModelCompletion = {
      content: "压缩后完成",
      toolCalls: [],
      model: "test-model",
      totalTokens: 3,
    };

    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce(summary)
      .mockResolvedValueOnce(final);
    const unusedStream = vi.fn<ModelClient["completeStream"]>();
    const completeAgent = new ChatAgent(
      { complete, completeStream: unusedStream },
      new ToolRegistry(),
      { context },
    );

    const summarize = vi.fn<ModelClient["complete"]>().mockResolvedValue(summary);
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: final.content };
        yield { type: "completion", completion: final };
      });
    const streamAgent = new ChatAgent(
      { complete: summarize, completeStream },
      new ToolRegistry(),
      { context },
    );

    const completeResult = await completeAgent.chat(messages);
    const streamResult = await collectDoneResult(streamAgent, messages);

    expect(streamResult).toEqual(completeResult);
    expect(completeResult).toMatchObject({
      content: "压缩后完成",
      totalTokens: 12,
      context: { compactions: 1, summarizedMessages: 2 },
      contextMessages: expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("[PanPilot context summary v1]"),
        }),
      ]),
    });
    expect(unusedStream).not.toHaveBeenCalled();
    // 流式主调用只走 completeStream；complete 仅供 ContextManager 生成摘要。
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(completeStream).toHaveBeenCalledTimes(1);
  });

  it("does not start streaming when the signal is already aborted", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>();
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
    );
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));

    await expect(
      agent.chatStream([{ role: "user", content: "hi" }], controller.signal).next(),
    ).rejects.toThrow("用户取消");
    expect(completeStream).not.toHaveBeenCalled();
  });

  it("propagates an abort raised mid-stream", async () => {
    const controller = new AbortController();
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "部分" };
        controller.abort(new Error("用户取消"));
        throw new Error("用户取消");
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
    );

    const events: AgentStreamEvent[] = [];
    await expect(async () => {
      for await (const event of agent.chatStream(
        [{ role: "user", content: "hi" }],
        controller.signal,
      )) {
        events.push(event);
      }
    }).rejects.toThrow("用户取消");
    expect(events).toEqual([
      { type: "status", stage: "model", step: 1 },
      { type: "content", content: "部分" },
    ]);
  });

  it("stops streaming at maxSteps with an explicit error", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield {
          type: "completion",
          completion: {
            content: "",
            toolCalls: [{
              id: "call_1",
              name: "echo",
              arguments: { value: 1 },
            }],
            model: "test-model",
          },
        };
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry([createEchoTool()]),
      { maxSteps: 2 },
    );

    await expect(async () => {
      for await (const _ of agent.chatStream([{ role: "user", content: "echo 1" }])) {
        // 一直有工具请求，循环会消耗完 maxSteps。
      }
    }).rejects.toMatchObject({
      name: "AgentMaxStepsError",
      steps: 2,
    });
    expect(completeStream).toHaveBeenCalledTimes(2);
  });

  it("rejects a model stream that ends without a completion event", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "只有增量" };
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
    );

    await expect(async () => {
      for await (const _ of agent.chatStream([{ role: "user", content: "hi" }])) {
        // 没有 completion 事件。
      }
    }).rejects.toThrow("Model stream ended without a completion event");
  });

  it("emits status before waiting for the model and before executing tools", async () => {
    const tool = createEchoTool();
    const order: string[] = [];
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementationOnce(async function* () {
        order.push("model-call-1");
        yield {
          type: "completion",
          completion: {
            content: "",
            toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
            model: "test-model",
          },
        };
      })
      .mockImplementationOnce(async function* () {
        order.push("model-call-2");
        yield {
          type: "completion",
          completion: {
            content: "完成",
            toolCalls: [],
            model: "test-model",
          },
        };
      });
    tool.execute.mockImplementation(async () => {
      order.push("tool-call-1");
      return { value: 1 };
    });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry([tool]),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.chatStream([{ role: "user", content: "echo 1" }])) {
      if (event.type === "status") {
        order.push(`status-${event.stage}-${event.step}`);
      }
      if (event.type === "tool_start") {
        order.push(`tool-start-${event.name}`);
      }
      events.push(event);
    }

    // 每个等待模型的阶段前都先发 status(model)，每个工具执行前先发 status(tool)/tool_start。
    expect(order).toEqual([
      "status-model-1",
      "model-call-1",
      "status-tool-1",
      "tool-start-echo",
      "tool-call-1",
      "status-model-2",
      "model-call-2",
    ]);
    expect(events.filter((event) => event.type === "status")).toHaveLength(3);
  });

  it("times out a non-streaming model call with a model timeout", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockImplementation(() => new Promise(() => {}));
    const agent = new ChatAgent(
      { complete, completeStream: vi.fn<ModelClient["completeStream"]>() },
      new ToolRegistry(),
      { modelTimeoutMs: 30 },
    );

    await expect(agent.chat([{ role: "user", content: "hi" }]))
      .rejects.toMatchObject({ name: "AgentTimeoutError", kind: "model" });
  });

  it("times out an idle streaming model call with a model timeout", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "开头" };
        await new Promise(() => {});
        yield { type: "content", content: "不会到达" };
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
      { modelTimeoutMs: 30 },
    );

    await expect(async () => {
      for await (const _ of agent.chatStream([{ role: "user", content: "hi" }])) {
        // 空闲超过 modelTimeoutMs 应抛出模型超时。
      }
    }).rejects.toMatchObject({ name: "AgentTimeoutError", kind: "model" });
  });

  it("keeps a stream alive with internal activity without exposing it", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        for (let index = 0; index < 4; index += 1) {
          await sleep(20);
          yield { type: "activity" };
        }
        yield { type: "content", content: "完成" };
        yield {
          type: "completion",
          completion: {
            content: "完成",
            toolCalls: [],
            model: "test-model",
          },
        };
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
      { modelTimeoutMs: 35, timeoutMs: 500 },
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.chatStream([{ role: "user", content: "hi" }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", stage: "model", step: 1 },
      { type: "content", content: "完成" },
      {
        type: "done",
        result: {
          content: "完成",
          model: "test-model",
          steps: 1,
          toolExecutions: [],
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("activity");
  });

  it("times out a tool that ignores the abort signal", async () => {
    const tool = createEchoTool(vi.fn(() => new Promise(() => {})));
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
        model: "test-model",
      });
    const agent = new ChatAgent(
      { complete, completeStream: vi.fn<ModelClient["completeStream"]>() },
      new ToolRegistry([tool]),
      { toolTimeoutMs: 30 },
    );

    await expect(agent.chat([{ role: "user", content: "echo 1" }]))
      .rejects.toMatchObject({ name: "AgentTimeoutError", kind: "tool" });
  });

  it("enforces the overall request timeout even when steps keep making progress", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockImplementation(async () => {
        await sleep(40);
        return {
          content: "",
          toolCalls: [{ id: "call_1", name: "echo", arguments: { value: 1 } }],
          model: "test-model",
        };
      });
    const agent = new ChatAgent(
      { complete, completeStream: vi.fn<ModelClient["completeStream"]>() },
      new ToolRegistry([createEchoTool()]),
      { timeoutMs: 50 },
    );

    await expect(agent.chat([{ role: "user", content: "echo 1" }]))
      .rejects.toMatchObject({ name: "AgentTimeoutError", kind: "request" });
  });

  it("enforces the overall request timeout on an endlessly active stream", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        while (true) {
          await sleep(10);
          yield { type: "activity" };
        }
      });
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
      { modelTimeoutMs: 30, timeoutMs: 55 },
    );

    await expect(async () => {
      for await (const _ of agent.chatStream([{ role: "user", content: "hi" }])) {
        // activity 会刷新模型空闲超时，但不能突破整体请求截止时间。
      }
    }).rejects.toMatchObject({ name: "AgentTimeoutError", kind: "request" });
  });

  it("rejects invalid timeout options", () => {
    const client = createModelClient([]);
    const registry = new ToolRegistry();

    expect(() => new ChatAgent(client, registry, { modelTimeoutMs: 0 }))
      .toThrow("modelTimeoutMs");
    expect(() => new ChatAgent(client, registry, { toolTimeoutMs: -1 }))
      .toThrow("toolTimeoutMs");
    expect(() => new ChatAgent(client, registry, { timeoutMs: 1.5 }))
      .toThrow("timeoutMs");
  });

  it("classifies timeout errors nested in an abort cause chain", () => {
    const timeout = new AgentTimeoutError("tool", 10);
    const abort = new DOMException("aborted", "AbortError");
    (abort as { reason?: unknown }).reason = timeout;

    expect(findAgentTimeout(abort)).toBe(timeout);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createModelClient(completions: readonly ModelCompletion[]) {
  const complete = vi.fn<ModelClient["complete"]>();
  for (const completion of completions) {
    complete.mockResolvedValueOnce(completion);
  }
  // chat() 不走 completeStream，这里只补一个满足接口的桩。
  return {
    complete,
    completeStream: vi.fn<ModelClient["completeStream"]>(),
  } satisfies ModelClient;
}

function createStreamingModelClient(completions: readonly ModelCompletion[]) {
  const complete = vi.fn<ModelClient["complete"]>();
  const completeStream = vi.fn<ModelClient["completeStream"]>();
  for (const completion of completions) {
    completeStream.mockImplementationOnce(async function* () {
      if (completion.content !== "") {
        yield { type: "content", content: completion.content };
      }
      yield { type: "completion", completion };
    });
  }
  return { complete, completeStream } satisfies ModelClient;
}

async function collectDoneResult(
  agent: ChatAgent,
  messages: readonly ModelMessage[],
): Promise<AgentRunResult> {
  let result: AgentRunResult | undefined;
  for await (const event of agent.chatStream(messages)) {
    if (event.type === "done") result = event.result;
  }
  if (result === undefined) throw new Error("测试流没有 done 事件");
  return result;
}

async function expectModeParity(
  completions: readonly ModelCompletion[],
  toolFactory?: () => ReturnType<typeof createEchoTool>,
): Promise<void> {
  const completeClient = createModelClient(completions);
  const streamClient = createStreamingModelClient(completions);
  const completeAgent = new ChatAgent(
    completeClient,
    new ToolRegistry(toolFactory === undefined ? [] : [toolFactory()]),
  );
  const streamAgent = new ChatAgent(
    streamClient,
    new ToolRegistry(toolFactory === undefined ? [] : [toolFactory()]),
  );
  const messages: ModelMessage[] = [{ role: "user", content: "执行测试" }];

  const completeResult = await completeAgent.chat(messages);
  const streamResult = await collectDoneResult(streamAgent, messages);

  expect(normalizeDurations(streamResult)).toEqual(normalizeDurations(completeResult));
  expect(completeClient.completeStream).not.toHaveBeenCalled();
  expect(streamClient.complete).not.toHaveBeenCalled();
}

function normalizeDurations(result: AgentRunResult): AgentRunResult {
  return {
    ...result,
    toolExecutions: result.toolExecutions.map((execution) => ({
      ...execution,
      durationMs: 0,
    })),
  };
}

const echoInputSchema = z.object({ value: z.number() }).strict();
type EchoInput = z.infer<typeof echoInputSchema>;

function createEchoTool(
  execute = vi.fn(async (input: EchoInput) => ({ value: input.value })),
) {
  return {
    name: "echo",
    description: "返回输入内容",
    inputSchema: echoInputSchema,
    execute,
  } satisfies AgentTool<EchoInput, { value: number }>;
}
