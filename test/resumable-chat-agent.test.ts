import { describe, expect, it, vi } from "vitest";
import { ResumableChatAgent } from "../src/agent/resumable-chat-agent.js";
import type { ModelClient } from "../src/model/model-client.js";
import { calculatorTool } from "../src/tools/calculator.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("ResumableChatAgent", () => {
  it("pauses after a completed tool and resumes without executing it twice", async () => {
    let pause = false;
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "call-1",
          name: "calculator",
          arguments: { operation: "add", left: 1, right: 2 },
        }],
        model: "test",
        totalTokens: 3,
      })
      .mockResolvedValueOnce({
        content: "结果是 3",
        toolCalls: [],
        model: "test",
        totalTokens: 2,
      });
    let checkpoint;
    const registry = new ToolRegistry([calculatorTool]);
    const first = new ResumableChatAgent(client(complete), registry, {
      shouldPause: () => pause,
      onActivity(activity) {
        if (activity.phase === "tool") pause = true;
      },
      onCheckpoint(value) {
        checkpoint = value;
      },
    });

    const paused = await first.run([{ role: "user", content: "1+2" }]);
    expect(paused.type).toBe("paused");
    expect(checkpoint).toMatchObject({
      steps: 1,
      nextToolCallIndex: 1,
      toolExecutions: [{ name: "calculator", status: "success" }],
    });

    const resumed = await new ResumableChatAgent(client(complete), registry)
      .run([{ role: "user", content: "ignored" }], checkpoint);
    expect(resumed).toMatchObject({
      type: "completed",
      result: { content: "结果是 3", steps: 2, totalTokens: 5 },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

function client(complete: ModelClient["complete"]): ModelClient {
  return { complete, async *completeStream() { throw new Error("unused"); } };
}
