import { CronExpressionParser } from "cron-parser";
import type { TaskSchedule } from "./types.js";

export class TaskScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskScheduleError";
  }
}

export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function nextRunAt(
  schedule: TaskSchedule,
  after: Date,
  options: { requireFutureOnce?: boolean } = {},
): Date | null {
  if (schedule.type === "once") {
    const date = parseLocalDateTime(schedule.at);
    if (options.requireFutureOnce && date.getTime() <= after.getTime()) {
      throw new TaskScheduleError("一次性任务时间必须晚于服务器当前时间");
    }
    return date.getTime() > after.getTime() ? date : null;
  }
  const expression = toCronExpression(schedule);
  try {
    return CronExpressionParser.parse(expression, {
      currentDate: after,
      tz: serverTimeZone(),
    }).next().toDate();
  } catch (error) {
    throw new TaskScheduleError(`时间规则不合法: ${messageOf(error)}`);
  }
}

export function validateSchedule(schedule: TaskSchedule, now: Date): void {
  if (schedule.type === "cron") validateFiveFieldCron(schedule.expression);
  nextRunAt(schedule, now, { requireFutureOnce: schedule.type === "once" });
}

export function scheduleLabel(schedule: TaskSchedule): string {
  if (schedule.type === "once") return `单次 ${schedule.at}`;
  if (schedule.type === "daily") return `每天 ${schedule.time}`;
  if (schedule.type === "weekly") return `每周${weekdayLabel(schedule.weekday)} ${schedule.time}`;
  return `Cron ${schedule.expression}`;
}

function toCronExpression(schedule: Exclude<TaskSchedule, { type: "once" }>): string {
  if (schedule.type === "cron") {
    validateFiveFieldCron(schedule.expression);
    return schedule.expression.trim();
  }
  const [hour, minute] = schedule.time.split(":");
  if (hour === undefined || minute === undefined) {
    throw new TaskScheduleError("时间格式不正确");
  }
  return schedule.type === "daily"
    ? `${Number(minute)} ${Number(hour)} * * *`
    : `${Number(minute)} ${Number(hour)} * * ${schedule.weekday}`;
}

function validateFiveFieldCron(expression: string): void {
  const normalized = expression.trim();
  if (normalized.startsWith("@") || normalized.split(/\s+/).length !== 5) {
    throw new TaskScheduleError("Cron 必须是五字段：分 时 日 月 周");
  }
  try {
    CronExpressionParser.parse(normalized, {
      currentDate: new Date(),
      tz: serverTimeZone(),
    }).next();
  } catch (error) {
    throw new TaskScheduleError(`Cron 表达式不合法: ${messageOf(error)}`);
  }
}

function parseLocalDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TaskScheduleError("一次性任务时间格式必须为 YYYY-MM-DDTHH:mm");
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) {
    throw new TaskScheduleError("一次性任务时间不是服务器时区中的有效时间");
  }
  return date;
}

function weekdayLabel(weekday: number): string {
  return ["日", "一", "二", "三", "四", "五", "六"][weekday] ?? String(weekday);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
