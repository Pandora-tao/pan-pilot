import { describe, expect, it } from "vitest";
import { nextRunAt, serverTimeZone, TaskScheduleError, validateSchedule } from "../src/scheduled-tasks/schedule-time.js";

describe("scheduled task time rules", () => {
  it("parses once, daily, weekly, and five-field cron in server local time", () => {
    const now = new Date(2026, 7, 13, 8, 30, 0, 0);
    expect(serverTimeZone()).toBeTruthy();
    expect(nextRunAt({ type: "once", at: "2026-08-13T09:15" }, now)?.getHours()).toBe(9);
    expect(nextRunAt({ type: "daily", time: "09:00" }, now)?.getHours()).toBe(9);
    const weekly = nextRunAt({ type: "weekly", weekday: 1, time: "10:00" }, now);
    expect(weekly?.getDay()).toBe(1);
    expect(nextRunAt({ type: "cron", expression: "30 11 * * *" }, now)?.getHours()).toBe(11);
  });

  it("rejects past once rules, six fields, aliases, and invalid dates", () => {
    const now = new Date(2026, 7, 13, 10, 0, 0, 0);
    expect(() => validateSchedule({ type: "once", at: "2026-08-13T09:00" }, now))
      .toThrow(TaskScheduleError);
    expect(() => validateSchedule({ type: "cron", expression: "0 0 9 * * *" }, now))
      .toThrow(/五字段/);
    expect(() => validateSchedule({ type: "cron", expression: "@daily" }, now))
      .toThrow(/五字段/);
    expect(() => validateSchedule({ type: "once", at: "2026-02-30T09:00" }, now))
      .toThrow(/有效时间/);
  });
});
