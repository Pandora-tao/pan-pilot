import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ScheduledTaskError } from "./scheduled-task-error.js";
import type { ScheduledTaskScheduler } from "./scheduled-task-scheduler.js";
import { scheduledTaskInputSchema, TASK_ID_PATTERN } from "./types.js";

const idParamsSchema = z.object({ id: z.string().regex(TASK_ID_PATTERN) }).strict();
const runsQuerySchema = z.object({
  taskId: z.string().regex(TASK_ID_PATTERN).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
const recoverySchema = z.object({
  action: z.enum(["retry", "terminate"]),
}).strict();

export function registerScheduledTaskRoutes(
  app: FastifyInstance,
  scheduler: ScheduledTaskScheduler,
): void {
  const routeOptions = {
    preHandler: async (_request: unknown, reply: FastifyReply) => {
      if (scheduler.available) return;
      const authMissing = scheduler.unavailableReason === "auth_not_configured";
      return reply.code(503).send({
        error: authMissing ? "AUTH_NOT_CONFIGURED" : "SCHEDULE_STORE_UNAVAILABLE",
        message: authMissing
          ? "未配置 PAN_PILOT_API_TOKEN，定时任务接口拒绝服务"
          : "定时任务存储不可用",
      });
    },
  };

  app.get("/v1/scheduled-tasks", routeOptions, async (_request, reply) => handle(reply, () => {
    const tasks = scheduler.listTasks();
    const runs = scheduler.listRuns({ limit: 200 });
    const latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs) if (!latest.has(run.taskId)) latest.set(run.taskId, run);
    return {
      serverNow: new Date().toISOString(),
      serverTimeZone: scheduler.timeZone,
      scheduler: {
        status: scheduler.available ? "available" : "unavailable",
        ...(scheduler.unavailableReason === undefined
          ? {} : { reason: scheduler.unavailableReason }),
      },
      tasks: tasks.map((task) => ({
        ...task,
        latestRun: summarizeRun(latest.get(task.id)),
      })),
    };
  }));

  app.post("/v1/scheduled-tasks", routeOptions, async (request, reply) => {
    const parsed = scheduledTaskInputSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);
    return handle(reply, async () => reply.code(201).send({
      task: await scheduler.create(parsed.data),
    }));
  });

  app.put("/v1/scheduled-tasks/:id", routeOptions, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = scheduledTaskInputSchema.safeParse(request.body);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    if (!body.success) return invalidRequest(reply, body.error.issues);
    return handle(reply, async () => ({
      task: await scheduler.update(params.data.id, body.data),
    }));
  });

  app.delete("/v1/scheduled-tasks/:id", routeOptions, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    return handle(reply, async () => {
      await scheduler.delete(params.data.id);
      return reply.code(204).send();
    });
  });

  app.post("/v1/scheduled-tasks/:id/enable", routeOptions, async (request, reply) => {
    return setEnabled(request.params, reply, scheduler, true);
  });
  app.post("/v1/scheduled-tasks/:id/disable", routeOptions, async (request, reply) => {
    return setEnabled(request.params, reply, scheduler, false);
  });

  app.post("/v1/scheduled-tasks/:id/run", routeOptions, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    return handle(reply, async () => reply.code(202).send({
      run: publicRun(await scheduler.runNow(params.data.id)),
    }));
  });

  app.post("/v1/scheduled-task-runs/:id/pause", routeOptions, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    return handle(reply, async () => ({
      run: publicRun(await scheduler.pauseRun(params.data.id)),
    }));
  });

  app.post("/v1/scheduled-task-runs/:id/resume", routeOptions, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    return handle(reply, async () => ({
      run: publicRun(await scheduler.resumeRun(params.data.id)),
    }));
  });

  app.post("/v1/scheduled-task-runs/:id/recovery", routeOptions, async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = recoverySchema.safeParse(request.body);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    if (!body.success) return invalidRequest(reply, body.error.issues);
    return handle(reply, async () => ({
      run: publicRun(await scheduler.resolveRecovery(params.data.id, body.data.action)),
    }));
  });

  app.get("/v1/scheduled-task-runs", routeOptions, async (request, reply) => {
    const query = runsQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error.issues);
    return handle(reply, () => ({
      runs: scheduler.listRuns({
        limit: query.data.limit,
        ...(query.data.taskId === undefined ? {} : { taskId: query.data.taskId }),
      }).map(publicRun),
    }));
  });
}

function summarizeRun(run: ReturnType<ScheduledTaskScheduler["listRuns"]>[number] | undefined) {
  if (run === undefined) return undefined;
  return {
    id: run.id,
    taskId: run.taskId,
    trigger: run.trigger,
    status: run.status,
    scheduledFor: run.scheduledFor,
    queuedAt: run.queuedAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.pauseRequestedAt === undefined ? {} : { pauseRequestedAt: run.pauseRequestedAt }),
    ...(run.pausedAt === undefined ? {} : { pausedAt: run.pausedAt }),
    ...(run.resumedAt === undefined ? {} : { resumedAt: run.resumedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.model === undefined ? {} : { model: run.model }),
  };
}

/** 检查点可能含原始工具参数和结果，只允许调度器内部读取，不进入 HTTP。 */
function publicRun(run: ReturnType<ScheduledTaskScheduler["listRuns"]>[number]) {
  const { checkpoint: _checkpoint, activity: _activity, ...safe } = run;
  return safe;
}

async function setEnabled(
  rawParams: unknown,
  reply: FastifyReply,
  scheduler: ScheduledTaskScheduler,
  enabled: boolean,
) {
  const params = idParamsSchema.safeParse(rawParams);
  if (!params.success) return invalidRequest(reply, params.error.issues);
  return handle(reply, async () => ({
    task: await scheduler.setEnabled(params.data.id, enabled),
  }));
}

async function handle<T>(
  reply: FastifyReply,
  action: () => T | Promise<T>,
): Promise<T | FastifyReply> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ScheduledTaskError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
    }
    throw error;
  }
}

function invalidRequest(reply: FastifyReply, details: unknown): FastifyReply {
  return reply.code(400).send({
    error: "INVALID_REQUEST",
    message: "请求参数不正确",
    details,
  });
}
