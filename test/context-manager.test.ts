import { describe, expect, it, vi } from "vitest";
import { ContextManager, estimateTextTokens } from "../src/agent/context-manager.js";
import type { ModelClient, ModelMessage } from "../src/model/model-client.js";

describe("ContextManager", () => {
  it("preserves system instructions and complete recent tool-call groups", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "- 旧目标：完成报告\n- 工具结果：42",
      toolCalls: [],
      model: "summary-model",
      totalTokens: 9,
    });
    const history: ModelMessage[] = [
      { role: "system", content: "必须使用中文" },
      ...Array.from({ length: 10 }, (_, index): ModelMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `较早消息 ${index} ${"x".repeat(24)}`,
      })),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "calculator", arguments: { value: 42 } }],
      },
      { role: "tool", toolCallId: "call-1", name: "calculator", content: "42" },
      { role: "user", content: "继续完成" },
    ];
    const manager = new ContextManager(client(complete), {
      maxInputTokens: 10_000,
      targetInputTokens: 8_000,
      recentInputTokens: 80,
      summaryMaxTokens: 64,
      maxMessages: 8,
    });

    const result = await manager.prepare(history, []);

    expect(result).toMatchObject({
      compacted: true,
      totalTokens: 9,
      usage: { compactions: 1, summarizedMessages: expect.any(Number) },
    });
    expect(history[0]).toEqual({ role: "system", content: "必须使用中文" });
    expect(history[1]?.content).toContain("[PanPilot context summary v1]");
    expect(history).toContainEqual(expect.objectContaining({
      role: "assistant",
      toolCalls: [expect.objectContaining({ id: "call-1" })],
    }));
    expect(history).toContainEqual(expect.objectContaining({
      role: "tool",
      toolCallId: "call-1",
    }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      tools: [],
      maxOutputTokens: 64,
    }));
  });

  it("reuses an existing rolling summary instead of accumulating summaries", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "合并后的唯一摘要",
      toolCalls: [],
      model: "summary-model",
    });
    const history: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "system", content: "[PanPilot context summary v1]\n旧摘要" },
      ...Array.from({ length: 12 }, (_, index): ModelMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `消息 ${index}`,
      })),
    ];
    await new ContextManager(client(complete), {
      maxInputTokens: 10_000,
      targetInputTokens: 8_000,
      recentInputTokens: 50,
      summaryMaxTokens: 64,
      maxMessages: 8,
    }).prepare(history, []);

    expect(history.filter((message) => message.content.includes("context summary v1")))
      .toHaveLength(1);
    expect(history[1]?.content).toContain("合并后的唯一摘要");
  });

  it("summarizes oversized old content in bounded chunks before merging", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "分块摘要",
      toolCalls: [],
      model: "summary-model",
      totalTokens: 2,
    });
    const history: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "旧".repeat(2_500) },
      ...Array.from({ length: 10 }, (_, index): ModelMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `近期 ${index}`,
      })),
    ];
    const result = await new ContextManager(client(complete), {
      maxInputTokens: 1_000,
      targetInputTokens: 700,
      recentInputTokens: 100,
      summaryMaxTokens: 100,
      maxMessages: 8,
    }).prepare(history, []);

    expect(complete.mock.calls.length).toBeGreaterThan(1);
    expect(result.totalTokens).toBe(complete.mock.calls.length * 2);
    for (const [request] of complete.mock.calls) {
      expect(estimateTextTokens(request.messages[1]?.content ?? "")).toBeLessThanOrEqual(420);
    }
  });

  it("estimates CJK more densely than ASCII", () => {
    expect(estimateTextTokens("测试文本")).toBe(4);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
  });
});

function client(complete: ModelClient["complete"]): ModelClient {
  return { complete, async *completeStream() { throw new Error("unused"); } };
}
