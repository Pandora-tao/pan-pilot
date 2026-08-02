import { z } from "zod";
import type { AgentTool } from "./tool.js";

const getCurrentTimeInputSchema = z.object({
  timeZone: z.string()
    .trim()
    .min(1, "timeZone 不能为空")
    .max(100)
    .refine(isValidTimeZone, "timeZone 不是有效的 IANA 时区")
    .optional(),
}).strict();

export type GetCurrentTimeInput = z.infer<typeof getCurrentTimeInputSchema>;

export interface GetCurrentTimeOutput {
  isoTime: string;
  localTime: string;
  timeZone: string;
}

export interface Clock {
  now(): Date;
}

const systemClock: Clock = {
  now: () => new Date(),
};

/** 创建时允许注入时钟，使时间相关测试不依赖真实当前时间。 */
export function createGetCurrentTimeTool(
  clock: Clock = systemClock,
): AgentTool<GetCurrentTimeInput, GetCurrentTimeOutput> {
  return {
    name: "get_current_time",
    description: "获取指定 IANA 时区的当前日期和时间；未指定时区时使用 UTC。",
    inputSchema: getCurrentTimeInputSchema,
    async execute(input, signal) {
      signal?.throwIfAborted();

      const now = clock.now();
      if (Number.isNaN(now.getTime())) {
        throw new Error("时钟返回了无效时间");
      }

      const timeZone = input.timeZone ?? "UTC";
      const localTime = new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        hourCycle: "h23",
        timeZone,
      }).format(now);

      return {
        isoTime: now.toISOString(),
        localTime,
        timeZone,
      };
    },
  };
}

export const getCurrentTimeTool = createGetCurrentTimeTool();

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}
