import { z } from "zod";
import {
  agentRunActivitySchema,
  agentRunCheckpointSchema,
} from "../agent/resumable-chat-agent.js";

export const TASK_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const localTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export const taskScheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    at: z.string().regex(localDateTimePattern),
  }).strict(),
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(localTimePattern),
  }).strict(),
  z.object({
    type: z.literal("weekly"),
    weekday: z.number().int().min(0).max(6),
    time: z.string().regex(localTimePattern),
  }).strict(),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1).max(200),
  }).strict(),
]);

export type TaskSchedule = z.infer<typeof taskScheduleSchema>;

export const scheduledTaskInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(10_000),
  modelId: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  schedule: taskScheduleSchema,
}).strict();

export type ScheduledTaskInput = z.infer<typeof scheduledTaskInputSchema>;

export const scheduledTaskSchema = scheduledTaskInputSchema.extend({
  id: z.string().regex(TASK_ID_PATTERN),
  nextRunAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const taskRunStatusSchema = z.enum([
  "queued",
  "running",
  "pausing",
  "paused",
  "needs_confirmation",
  "succeeded",
  "failed",
  "timed_out",
  "skipped_overlap",
  "skipped_misfire",
  "interrupted",
]);
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;

export const taskRunTriggerSchema = z.enum(["scheduled", "manual"]);
export type TaskRunTrigger = z.infer<typeof taskRunTriggerSchema>;

export const taskSnapshotSchema = z.object({
  taskId: z.string().regex(TASK_ID_PATTERN),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(10_000),
  modelId: z.string().min(1).max(120),
  schedule: taskScheduleSchema,
}).strict();

export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const scheduledTaskRunSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  taskId: z.string().regex(TASK_ID_PATTERN),
  trigger: taskRunTriggerSchema,
  status: taskRunStatusSchema,
  task: taskSnapshotSchema,
  scheduledFor: z.string().datetime({ offset: true }).nullable(),
  queuedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).optional(),
  pauseRequestedAt: z.string().datetime({ offset: true }).optional(),
  pausedAt: z.string().datetime({ offset: true }).optional(),
  resumedAt: z.string().datetime({ offset: true }).optional(),
  finishedAt: z.string().datetime({ offset: true }).optional(),
  content: z.string().max(200_000).optional(),
  error: z.string().max(1000).optional(),
  model: z.string().max(200).optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  steps: z.number().int().positive().optional(),
  toolExecutions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["success", "error"]),
    // 旧运行记录没有该字段，读取时保持兼容；新运行总是写入。
    durationMs: z.number().int().nonnegative().optional(),
  }).strict()).optional(),
  context: z.object({
    compactions: z.number().int().nonnegative(),
    summarizedMessages: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
  }).strict().optional(),
  checkpoint: agentRunCheckpointSchema.optional(),
  activity: agentRunActivitySchema.optional(),
  recoveryReason: z.string().max(1000).optional(),
}).strict();

export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>;

export const scheduledTaskStateSchema = z.object({
  version: z.literal(1),
  tasks: z.array(scheduledTaskSchema),
  runs: z.array(scheduledTaskRunSchema),
}).strict();

export type ScheduledTaskState = z.infer<typeof scheduledTaskStateSchema>;

export function taskSnapshot(task: ScheduledTask): TaskSnapshot {
  return {
    taskId: task.id,
    name: task.name,
    prompt: task.prompt,
    modelId: task.modelId,
    schedule: structuredClone(task.schedule),
  };
}
