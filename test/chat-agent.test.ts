import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentMaxStepsError,
  ChatAgent,
  type AgentStreamEvent,
} from "../src/agent/chat-agent.js";
import type {
  ModelClient,
  ModelCompletion,
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
    });
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
      { id: "call_1", name: "echo", status: "success" },
    ]);
    // 摘要只含 id/name/status，不携带原始参数或工具结果。
    expect(Object.keys(result.toolExecutions[0] ?? {})).toEqual([
      "id",
      "name",
      "status",
    ]);
    expect(tool.execute).toHaveBeenCalledWith({ value: 7 }, undefined);
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
      { id: "call_1", name: "echo", status: "error" },
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
    const agent = new ChatAgent(
      { complete: vi.fn(), completeStream },
      new ToolRegistry(),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.chatStream([{ role: "user", content: "hi" }])) {
      events.push(event);
    }

    expect(events).toEqual([
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
    });
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
      {
        type: "tool_execution",
        execution: { id: "call_1", name: "echo", status: "success" },
      },
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
    expect(events).toEqual([{ type: "content", content: "部分" }]);
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
});

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
