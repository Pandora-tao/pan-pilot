import { z } from "zod";
import type { AgentTool } from "./tool.js";

const lengthUnitSchema = z.enum(["mm", "cm", "m", "km", "in", "ft", "yd", "mi"]);
const massUnitSchema = z.enum(["mg", "g", "kg", "oz", "lb"]);
const temperatureUnitSchema = z.enum(["celsius", "fahrenheit", "kelvin"]);
const volumeUnitSchema = z.enum(["ml", "l", "tsp", "tbsp", "cup", "fl_oz", "gal"]);

const unitConverterInputSchema = z.discriminatedUnion("category", [
  conversionSchema("length", lengthUnitSchema),
  conversionSchema("mass", massUnitSchema),
  conversionSchema("temperature", temperatureUnitSchema),
  conversionSchema("volume", volumeUnitSchema),
]);

function conversionSchema<TCategory extends string, TUnit extends z.ZodType>(
  category: TCategory,
  unitSchema: TUnit,
) {
  return z.object({
    category: z.literal(category),
    value: z.number().finite(),
    from: unitSchema,
    to: unitSchema,
  }).strict();
}

export type UnitConverterInput = z.infer<typeof unitConverterInputSchema>;

export interface UnitConverterOutput {
  category: UnitConverterInput["category"];
  value: number;
  from: string;
  to: string;
  result: number;
}

const LENGTH_TO_METERS: Readonly<Record<string, number>> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
};

const MASS_TO_GRAMS: Readonly<Record<string, number>> = {
  mg: 0.001,
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

// 容量单位采用美制：1 cup = 236.5882365 ml，1 gal = 3.785411784 l。
const VOLUME_TO_MILLILITERS: Readonly<Record<string, number>> = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375,
  tbsp: 14.78676478125,
  cup: 236.5882365,
  fl_oz: 29.5735295625,
  gal: 3785.411784,
};

/** 只开放明确枚举的常用单位，不解析自由文本表达式。 */
export const unitConverterTool: AgentTool<
  UnitConverterInput,
  UnitConverterOutput
> = {
  name: "unit_converter",
  description:
    "换算常用长度、重量、温度和容量单位；容量中的 cup、fl_oz、gal 使用美制。",
  inputSchema: unitConverterInputSchema,
  async execute(input, signal) {
    signal?.throwIfAborted();

    let result: number;
    switch (input.category) {
      case "length":
        result = convertByFactor(input.value, input.from, input.to, LENGTH_TO_METERS);
        break;
      case "mass":
        result = convertByFactor(input.value, input.from, input.to, MASS_TO_GRAMS);
        break;
      case "volume":
        result = convertByFactor(
          input.value,
          input.from,
          input.to,
          VOLUME_TO_MILLILITERS,
        );
        break;
      case "temperature":
        result = convertTemperature(input.value, input.from, input.to);
        break;
    }

    if (!Number.isFinite(result)) throw new Error("换算结果不是有限数值");
    return { ...input, result };
  },
};

function convertByFactor(
  value: number,
  from: string,
  to: string,
  factors: Readonly<Record<string, number>>,
): number {
  const fromFactor = factors[from];
  const toFactor = factors[to];
  if (fromFactor === undefined || toFactor === undefined) {
    throw new Error("不支持的换算单位");
  }
  return value * fromFactor / toFactor;
}

function convertTemperature(
  value: number,
  from: "celsius" | "fahrenheit" | "kelvin",
  to: "celsius" | "fahrenheit" | "kelvin",
): number {
  const celsius = from === "celsius"
    ? value
    : from === "fahrenheit"
      ? (value - 32) * 5 / 9
      : value - 273.15;
  if (celsius < -273.15) throw new Error("温度不能低于绝对零度");
  return to === "celsius"
    ? celsius
    : to === "fahrenheit"
      ? celsius * 9 / 5 + 32
      : celsius + 273.15;
}
