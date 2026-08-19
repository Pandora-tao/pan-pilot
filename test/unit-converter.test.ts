import { describe, expect, it } from "vitest";
import { unitConverterTool } from "../src/tools/unit-converter.js";
import { defaultToolContext } from "../src/tools/tool.js";

describe("unit_converter", () => {
  it.each([
    [{ category: "length", value: 1, from: "mi", to: "km" }, 1.609344],
    [{ category: "mass", value: 1, from: "lb", to: "kg" }, 0.45359237],
    [{ category: "volume", value: 1, from: "gal", to: "l" }, 3.785411784],
    [{ category: "temperature", value: 32, from: "fahrenheit", to: "celsius" }, 0],
  ] as const)("converts common units", async (input, expected) => {
    const result = await unitConverterTool.execute(input, defaultToolContext());
    expect(result.result).toBeCloseTo(expected, 9);
  });

  it("supports conversions to Kelvin", async () => {
    const result = await unitConverterTool.execute({
      category: "temperature",
      value: 100,
      from: "celsius",
      to: "kelvin",
    }, defaultToolContext());
    expect(result.result).toBeCloseTo(373.15, 10);
  });

  it("rejects units from another category and extra fields", () => {
    expect(unitConverterTool.inputSchema.safeParse({
      category: "length",
      value: 1,
      from: "kg",
      to: "m",
    }).success).toBe(false);
    expect(unitConverterTool.inputSchema.safeParse({
      category: "mass",
      value: 1,
      from: "kg",
      to: "g",
      precision: 2,
    }).success).toBe(false);
  });

  it("rejects temperatures below absolute zero", async () => {
    await expect(unitConverterTool.execute({
      category: "temperature",
      value: -274,
      from: "celsius",
      to: "kelvin",
    }, defaultToolContext())).rejects.toThrow("温度不能低于绝对零度");
  });
});
