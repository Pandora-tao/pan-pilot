import { z } from "zod";
import type { AgentTool } from "./tool.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const dateSchema = z.string()
  .regex(DATE_PATTERN, "日期必须使用 YYYY-MM-DD 格式")
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    return year >= 1 && year <= 9999;
  }, "年份必须在 0001 到 9999 之间")
  .refine((value) => parseDate(value) !== undefined, "日期无效");

const dateCalculatorInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("add_days"),
    date: dateSchema,
    days: z.number().int().min(-36_600).max(36_600),
  }).strict(),
  z.object({
    operation: z.literal("days_between"),
    startDate: dateSchema,
    endDate: dateSchema,
  }).strict(),
  z.object({
    operation: z.literal("day_of_week"),
    date: dateSchema,
  }).strict(),
]);

export type DateCalculatorInput = z.infer<typeof dateCalculatorInputSchema>;

export type DateCalculatorOutput =
  | { operation: "add_days"; date: string; days: number; resultDate: string }
  | {
      operation: "days_between";
      startDate: string;
      endDate: string;
      days: number;
    }
  | {
      operation: "day_of_week";
      date: string;
      dayOfWeek: number;
      weekday: string;
    };

const WEEKDAYS = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
] as const;

/** 以 UTC 日历日运算，避免夏令时导致加一天或日期差出现 23/25 小时偏差。 */
export const dateCalculatorTool: AgentTool<
  DateCalculatorInput,
  DateCalculatorOutput
> = {
  name: "date_calculator",
  description:
    "进行日期加减、计算两个日期相差天数或查询星期；日期使用 YYYY-MM-DD，不处理具体时刻。",
  inputSchema: dateCalculatorInputSchema,
  async execute(input, ctx) {
    ctx.signal?.throwIfAborted();

    switch (input.operation) {
      case "add_days": {
        const date = requireDate(input.date);
        date.setUTCDate(date.getUTCDate() + input.days);
        if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
          throw new Error("计算结果超出 0001-01-01 到 9999-12-31");
        }
        return {
          ...input,
          resultDate: formatDate(date),
        };
      }
      case "days_between": {
        const start = requireDate(input.startDate);
        const end = requireDate(input.endDate);
        return {
          ...input,
          days: (end.getTime() - start.getTime()) / DAY_MS,
        };
      }
      case "day_of_week": {
        const date = requireDate(input.date);
        const dayOfWeek = date.getUTCDay();
        const weekday = WEEKDAYS[dayOfWeek];
        if (weekday === undefined) throw new Error("无法确定星期");
        return {
          ...input,
          dayOfWeek,
          weekday,
        };
      }
    }
  },
};

function parseDate(value: string): Date | undefined {
  if (!DATE_PATTERN.test(value)) return undefined;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function requireDate(value: string): Date {
  const date = parseDate(value);
  if (date === undefined) throw new Error(`无效日期: ${value}`);
  return date;
}

function formatDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
