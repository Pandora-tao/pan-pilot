import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("ToolRegistry", () => {
  it("lists serializable tool definitions", () => {
    const registry = new ToolRegistry([createEchoTool()]);

    expect(registry.listDefinitions()).toEqual([
      {
        name: "echo",
        description: "返回输入内容",
        parameters: expect.objectContaining({
          type: "object",
          required: ["value"],
          additionalProperties: false,
        }),
      },
    ]);
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolRegistry([createEchoTool(), createEchoTool()]))
      .toThrow(expect.objectContaining({
        code: "DUPLICATE_TOOL",
        toolName: "echo",
      }));
  });

  it("rejects unknown tools", async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute("missing", {})).rejects.toMatchObject({
      code: "UNKNOWN_TOOL",
      toolName: "missing",
    });
  });

  it("validates input before execution", async () => {
    const tool = createEchoTool();
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("echo", { value: 1, extra: true }))
      .rejects.toMatchObject({
        code: "INVALID_TOOL_INPUT",
        toolName: "echo",
        details: expect.any(Array),
      });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("executes valid input and returns a JSON-serializable result", async () => {
    const registry = new ToolRegistry([createEchoTool()]);

    await expect(registry.execute("echo", { value: 7 }))
      .resolves.toEqual({ value: 7 });
  });

  it("wraps tool failures with a stable error code", async () => {
    const failure = new Error("boom");
    const tool = createEchoTool();
    tool.execute.mockRejectedValue(failure);
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("echo", { value: 7 }))
      .rejects.toMatchObject({
        code: "TOOL_EXECUTION_FAILED",
        toolName: "echo",
        cause: failure,
      });
  });

  it("rejects non-serializable tool results", async () => {
    const tool = createEchoTool();
    tool.execute.mockResolvedValue({ value: 1n } as never);
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("echo", { value: 7 }))
      .rejects.toMatchObject({
        code: "INVALID_TOOL_RESULT",
        toolName: "echo",
      });
  });

  it("does not execute when the request is already aborted", async () => {
    const tool = createEchoTool();
    const registry = new ToolRegistry([tool]);
    const controller = new AbortController();
    controller.abort(new Error("停止执行"));

    await expect(registry.execute("echo", { value: 7 }, controller.signal))
      .rejects.toThrow("停止执行");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("replaceAll swaps the whole tool set atomically", async () => {
    const registry = new ToolRegistry([createEchoTool()]);
    const second = createEchoTool();
    second.name = "echo2";

    registry.replaceAll([second]);

    expect(registry.listDefinitions().map((definition) => definition.name))
      .toEqual(["echo2"]);
    await expect(registry.execute("echo", { value: 1 }))
      .rejects.toMatchObject({ code: "UNKNOWN_TOOL", toolName: "echo" });
  });

  it("replaceAll keeps the old set when the new set has duplicates", async () => {
    const original = createEchoTool();
    const registry = new ToolRegistry([original]);

    expect(() => registry.replaceAll([createEchoTool(), createEchoTool()]))
      .toThrow(expect.objectContaining({
        code: "DUPLICATE_TOOL",
        toolName: "echo",
      }));

    expect(registry.listDefinitions().map((definition) => definition.name))
      .toEqual(["echo"]);
    await expect(registry.execute("echo", { value: 1 }))
      .resolves.toEqual({ value: 1 });
  });
});

const echoInputSchema = z.object({ value: z.number() }).strict();
type EchoInput = z.infer<typeof echoInputSchema>;

function createEchoTool() {
  const execute = vi.fn(async (input: EchoInput) => ({ value: input.value }));
  return {
    name: "echo",
    description: "返回输入内容",
    inputSchema: echoInputSchema,
    execute,
  } satisfies AgentTool<EchoInput, { value: number }>;
}
