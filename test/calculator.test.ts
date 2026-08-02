import { describe, expect, it } from "vitest";
import { calculatorTool } from "../src/tools/calculator.js";

describe("calculator", () => {
  it.each([
    ["add", 8, 2, 10],
    ["subtract", 8, 2, 6],
    ["multiply", 8, 2, 16],
    ["divide", 8, 2, 4],
  ] as const)("executes %s", async (operation, left, right, expected) => {
    await expect(calculatorTool.execute({ operation, left, right }))
      .resolves.toEqual({ operation, left, right, result: expected });
  });

  it("rejects division by zero", async () => {
    await expect(calculatorTool.execute({
      operation: "divide",
      left: 8,
      right: 0,
    })).rejects.toThrow("除数不能为 0");
  });

  it("rejects unsupported operations, non-finite numbers and extra fields", () => {
    expect(calculatorTool.inputSchema.safeParse({
      operation: "power",
      left: 2,
      right: 8,
    }).success).toBe(false);
    expect(calculatorTool.inputSchema.safeParse({
      operation: "add",
      left: Number.POSITIVE_INFINITY,
      right: 1,
    }).success).toBe(false);
    expect(calculatorTool.inputSchema.safeParse({
      operation: "add",
      left: 1,
      right: 2,
      expression: "1 + 2",
    }).success).toBe(false);
  });

  it("rejects non-finite calculation results", async () => {
    await expect(calculatorTool.execute({
      operation: "multiply",
      left: Number.MAX_VALUE,
      right: 2,
    })).rejects.toThrow("计算结果不是有限数值");
  });
});
