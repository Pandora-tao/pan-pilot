import { describe, expect, it } from "vitest";
import { dateCalculatorTool } from "../src/tools/date-calculator.js";
import { defaultToolContext } from "../src/tools/tool.js";

describe("date_calculator", () => {
  it("adds calendar days across leap day", async () => {
    await expect(dateCalculatorTool.execute({
      operation: "add_days",
      date: "2024-02-28",
      days: 2,
    }, defaultToolContext())).resolves.toEqual({
      operation: "add_days",
      date: "2024-02-28",
      days: 2,
      resultDate: "2024-03-01",
    });
  });

  it("returns signed calendar-day differences", async () => {
    await expect(dateCalculatorTool.execute({
      operation: "days_between",
      startDate: "2026-08-13",
      endDate: "2026-08-01",
    }, defaultToolContext())).resolves.toMatchObject({ days: -12 });
  });

  it("returns the weekday", async () => {
    await expect(dateCalculatorTool.execute({
      operation: "day_of_week",
      date: "2026-08-13",
    }, defaultToolContext())).resolves.toEqual({
      operation: "day_of_week",
      date: "2026-08-13",
      dayOfWeek: 4,
      weekday: "星期四",
    });
  });

  it("rejects impossible dates, irrelevant fields and excessive offsets", () => {
    expect(dateCalculatorTool.inputSchema.safeParse({
      operation: "day_of_week",
      date: "2025-02-29",
    }).success).toBe(false);
    expect(dateCalculatorTool.inputSchema.safeParse({
      operation: "day_of_week",
      date: "2026-08-13",
      days: 1,
    }).success).toBe(false);
    expect(dateCalculatorTool.inputSchema.safeParse({
      operation: "add_days",
      date: "2026-08-13",
      days: 36_601,
    }).success).toBe(false);
    expect(dateCalculatorTool.inputSchema.safeParse({
      operation: "day_of_week",
      date: "0000-01-01",
    }).success).toBe(false);
  });

  it("rejects results outside the supported four-digit year range", async () => {
    await expect(dateCalculatorTool.execute({
      operation: "add_days",
      date: "9999-12-31",
      days: 1,
    }, defaultToolContext())).rejects.toThrow("计算结果超出");
  });
});
