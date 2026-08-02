import { z } from "zod";
import type { AgentTool } from "./tool.js";

const calculatorInputSchema = z.object({
  operation: z.enum(["add", "subtract", "multiply", "divide"]),
  left: z.number().finite(),
  right: z.number().finite(),
}).strict();

export type CalculatorInput = z.infer<typeof calculatorInputSchema>;

export interface CalculatorOutput extends CalculatorInput {
  result: number;
}

/** 只开放固定算术操作，不解析表达式，也不使用 eval。 */
export const calculatorTool: AgentTool<CalculatorInput, CalculatorOutput> = {
  name: "calculator",
  description: "对两个有限数字执行加、减、乘、除运算。",
  inputSchema: calculatorInputSchema,
  async execute(input, signal) {
    signal?.throwIfAborted();

    let result: number;
    switch (input.operation) {
      case "add":
        result = input.left + input.right;
        break;
      case "subtract":
        result = input.left - input.right;
        break;
      case "multiply":
        result = input.left * input.right;
        break;
      case "divide":
        if (input.right === 0) throw new Error("除数不能为 0");
        result = input.left / input.right;
        break;
    }

    if (!Number.isFinite(result)) {
      throw new Error("计算结果不是有限数值");
    }

    return { ...input, result };
  },
};
