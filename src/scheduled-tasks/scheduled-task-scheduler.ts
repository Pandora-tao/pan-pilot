import { AgentMaxStepsError } from "../agent/chat-agent.js";
import {
  ResumableChatAgent,
  type AgentRunActivity,
  type AgentRunCheckpoint,
} from "../agent/resumable-chat-agent.js";
import {
  type ChatModelRegistry,
  UnavailableChatModelError,
  UnsupportedChatModelError,
} from "../model/model-registry.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ContextManagerOptions } from "../agent/context-manager.js";
import type { PermissionRequestPublic, PermissionService } from "../permissions/permission-service.js";
import { nextRunAt, serverTimeZone, TaskScheduleError, validateSchedule } from "./schedule-time.js";
import { ScheduledTaskError } from "./scheduled-task-error.js";
import {
  ScheduledTaskStore,
  ScheduledTaskStoreUnavailableError,
} from "./scheduled-task-store.js";
import {
  scheduledTaskInputSchema,
  taskSnapshot,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRun,
  type ScheduledTaskState,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_WAKE_DELAY_MS = 60 * 1000;
const SYSTEM_PROMPT = [
  "你正在执行 PanPilot 控制台用户创建的定时任务。",
  "独立完成用户提示词要求；可以使用当前已启用工具，但不要创建或修改其他定时任务。",
  "最终返回适合保存为任务运行结果的完整正文。",
].join("\n");

export interface ScheduledTaskSchedulerOptions {
  store: ScheduledTaskStore;
  modelRegistry: ChatModelRegistry;
  toolRegistry: ToolRegistry;
  authConfigured: boolean;
  now?: () => Date;
  runTimeoutMs?: number;
  contextOptions?: ContextManagerOptions;
  /** 授权服务（buildApp 单例）；定时任务的工具授权确认共享同一策略。 */
  permissionService?: PermissionService;
}

export class ScheduledTaskScheduler {
  private readonly now: () => Date;
  private readonly runTimeoutMs: number;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly executionQueue: string[] = [];
  private processor: Promise<void> | undefined;
  private currentAbort: AbortController | undefined;
  private started = false;
  private stopping = false;

  constructor(private readonly options: ScheduledTaskSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get available(): boolean {
    return this.options.authConfigured && this.options.store.available;
  }

  get unavailableReason(): "auth_not_configured" | "store_unavailable" | undefined {
    if (!this.options.authConfigured) return "auth_not_configured";
    if (!this.options.store.available) return "store_unavailable";
    return undefined;
  }

  get timeZone(): string {
    return serverTimeZone();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.available) return;
    await this.recover();
    await this.checkDue();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearWakeTimer();
    this.currentAbort?.abort();
    if (this.processor !== undefined) await this.processor;
    if (this.available) await this.recoverActiveRuns("服务已停止");
  }

  listTasks(): ScheduledTask[] {
    this.assertAvailable();
    return this.options.store.listTasks();
  }

  listRuns(options: { taskId?: string; limit: number }): ScheduledTaskRun[] {
    this.assertAvailable();
    return this.options.store.listRuns(options);
  }

  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    this.assertAvailable();
    const parsed = scheduledTaskInputSchema.parse(input);
    this.validateModel(parsed.modelId);
    const now = this.now();
    this.validateTaskSchedule(parsed, now);
    const timestamp = now.toISOString();
    const task: ScheduledTask = {
      ...parsed,
      id: this.options.store.newId(),
      nextRunAt: parsed.enabled ? nextRunAt(parsed.schedule, now)?.toISOString() ?? null : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.options.store.mutate((draft) => {
      draft.tasks.push(task);
    });
    this.arm();
    return structuredClone(task);
  }

  async update(id: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
    this.assertAvailable();
    const parsed = scheduledTaskInputSchema.parse(input);
    this.validateModel(parsed.modelId);
    const now = this.now();
    this.validateTaskSchedule(parsed, now);
    let updated: ScheduledTask | undefined;
    await this.options.store.mutate((draft) => {
      const index = draft.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw taskNotFound();
      assertTaskInactive(draft, id);
      const previous = draft.tasks[index];
      if (previous === undefined) throw taskNotFound();
      updated = {
        ...parsed,
        id,
        nextRunAt: parsed.enabled ? nextRunAt(parsed.schedule, now)?.toISOString() ?? null : null,
        createdAt: previous.createdAt,
        updatedAt: now.toISOString(),
      };
      draft.tasks[index] = updated;
    });
    this.arm();
    if (updated === undefined) throw taskNotFound();
    return structuredClone(updated);
  }

  async delete(id: string): Promise<void> {
    this.assertAvailable();
    await this.options.store.mutate((draft) => {
      const index = draft.tasks.findIndex((task) => task.id === id);
      if (index < 0) throw taskNotFound();
      assertTaskInactive(draft, id);
      draft.tasks.splice(index, 1);
    });
    this.arm();
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    this.assertAvailable();
    const now = this.now();
    let updated: ScheduledTask | undefined;
    await this.options.store.mutate((draft) => {
      const task = draft.tasks.find((candidate) => candidate.id === id);
      if (task === undefined) throw taskNotFound();
      let next: Date | null = null;
      if (enabled) {
        try {
          next = nextRunAt(task.schedule, now, {
            requireFutureOnce: task.schedule.type === "once",
          });
        } catch (error) {
          if (error instanceof TaskScheduleError && task.schedule.type === "once") {
            throw new ScheduledTaskError("TASK_SCHEDULE_PAST", error.message, 409);
          }
          throw error;
        }
      }
      task.enabled = enabled;
      task.nextRunAt = next?.toISOString() ?? null;
      task.updatedAt = now.toISOString();
      updated = structuredClone(task);
    });
    this.arm();
    if (updated === undefined) throw taskNotFound();
    return updated;
  }

  async runNow(id: string): Promise<ScheduledTaskRun> {
    this.assertAvailable();
    let queued: ScheduledTaskRun | undefined;
    const queuedAt = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const task = draft.tasks.find((candidate) => candidate.id === id);
      if (task === undefined) throw taskNotFound();
      assertTaskInactive(draft, id);
      queued = createRun(this.options.store.newId(), task, "manual", null, queuedAt);
      draft.runs.push(queued);
    });
    if (queued === undefined) throw taskNotFound();
    this.executionQueue.push(queued.id);
    this.startProcessor();
    return structuredClone(queued);
  }

  async pauseRun(id: string): Promise<ScheduledTaskRun> {
    this.assertAvailable();
    let updated: ScheduledTaskRun | undefined;
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === id);
      if (run === undefined) throw runNotFound();
      if (run.status === "queued") {
        run.status = "paused";
        run.pauseRequestedAt = timestamp;
        run.pausedAt = timestamp;
      } else if (run.status === "running") {
        run.status = "pausing";
        run.pauseRequestedAt = timestamp;
      } else if (run.status !== "pausing") {
        throw new ScheduledTaskError(
          "TASK_RUN_NOT_PAUSABLE", "只有排队中或运行中的任务可以暂停", 409,
        );
      }
      updated = structuredClone(run);
    });
    if (updated === undefined) throw runNotFound();
    return updated;
  }

  async resumeRun(id: string): Promise<ScheduledTaskRun> {
    this.assertAvailable();
    let updated: ScheduledTaskRun | undefined;
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === id);
      if (run === undefined) throw runNotFound();
      if (run.status === "needs_confirmation") {
        throw new ScheduledTaskError(
          "TASK_RUN_CONFIRMATION_REQUIRED",
          "该任务可能在工具执行中中断，需要明确选择重试或终止",
          409,
        );
      }
      if (run.status !== "paused") {
        throw new ScheduledTaskError(
          "TASK_RUN_NOT_RESUMABLE", "只有已暂停的任务可以恢复", 409,
        );
      }
      run.status = "queued";
      run.resumedAt = timestamp;
      delete run.pauseRequestedAt;
      delete run.pausedAt;
      delete run.error;
      delete run.recoveryReason;
      updated = structuredClone(run);
    });
    if (updated === undefined) throw runNotFound();
    this.executionQueue.push(id);
    this.startProcessor();
    return updated;
  }

  async resolveRecovery(
    id: string,
    action: "retry" | "terminate",
  ): Promise<ScheduledTaskRun> {
    this.assertAvailable();
    let updated: ScheduledTaskRun | undefined;
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === id);
      if (run === undefined) throw runNotFound();
      if (run.status !== "needs_confirmation") {
        throw new ScheduledTaskError(
          "TASK_RUN_NOT_RESUMABLE", "该任务不需要恢复确认", 409,
        );
      }
      if (action === "retry") {
        run.status = "queued";
        run.resumedAt = timestamp;
        delete run.finishedAt;
        delete run.error;
        delete run.recoveryReason;
        delete run.activity;
      } else {
        run.status = "interrupted";
        run.finishedAt = timestamp;
        run.error = "用户终止了状态不确定的任务";
        delete run.recoveryReason;
        delete run.activity;
        if (run.trigger === "scheduled" && run.task.schedule.type === "once") {
          removeTask(draft, run.taskId);
        }
      }
      updated = structuredClone(run);
    });
    if (updated === undefined) throw runNotFound();
    if (action === "retry") {
      this.executionQueue.push(id);
      this.startProcessor();
    }
    return updated;
  }

  async checkDue(): Promise<void> {
    if (!this.available || this.stopping) return;
    this.clearWakeTimer();
    const now = this.now();
    const due = this.options.store.listTasks()
      .filter((task) => task.enabled && task.nextRunAt !== null
        && new Date(task.nextRunAt).getTime() <= now.getTime())
      .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
    for (const task of due) await this.triggerScheduled(task.id, now);
    this.arm();
  }

  async waitForIdle(): Promise<void> {
    if (this.processor !== undefined) await this.processor;
  }

  private async recover(): Promise<void> {
    const now = this.now();
    const timestamp = now.toISOString();
    const recoveredRunIds: string[] = [];
    await this.options.store.mutate((draft) => {
      for (const run of draft.runs) {
        if (run.status === "queued") {
          recoveredRunIds.push(run.id);
        } else if (run.status === "running" || run.status === "pausing") {
          recoverRunAtStartup(run, timestamp, "服务重启前的任务未完成");
          const recovered = draft.runs.find((candidate) => candidate.id === run.id);
          if (recovered?.status === "queued") recoveredRunIds.push(run.id);
        }
      }
      for (const task of [...draft.tasks]) {
        if (!task.enabled || task.nextRunAt === null) continue;
        if (new Date(task.nextRunAt).getTime() > now.getTime()) continue;
        draft.runs.push(createSkippedRun(
          this.options.store.newId(),
          task,
          "skipped_misfire",
          task.nextRunAt,
          timestamp,
          "服务离线期间错过计划时间",
        ));
        if (task.schedule.type === "once") removeTask(draft, task.id);
        else task.nextRunAt = nextRunAt(task.schedule, now)?.toISOString() ?? null;
      }
    });
    this.executionQueue.push(...recoveredRunIds);
    this.startProcessor();
  }

  private async triggerScheduled(taskId: string, now: Date): Promise<void> {
    let queuedRunId: string | undefined;
    await this.options.store.mutate((draft) => {
      const task = draft.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined || !task.enabled || task.nextRunAt === null) return;
      const scheduledFor = task.nextRunAt;
      if (new Date(scheduledFor).getTime() > now.getTime()) return;
      if (isTaskActive(draft, task.id)) {
        draft.runs.push(createSkippedRun(
          this.options.store.newId(), task, "skipped_overlap", scheduledFor,
          now.toISOString(), "同一任务已有排队或执行中的运行",
        ));
        if (task.schedule.type === "once") removeTask(draft, task.id);
        else task.nextRunAt = nextRunAt(task.schedule, now)?.toISOString() ?? null;
        return;
      }
      const run = createRun(
        this.options.store.newId(), task, "scheduled", scheduledFor, now.toISOString(),
      );
      draft.runs.push(run);
      queuedRunId = run.id;
      task.nextRunAt = task.schedule.type === "once"
        ? null
        : nextRunAt(task.schedule, now)?.toISOString() ?? null;
    });
    if (queuedRunId !== undefined) {
      this.executionQueue.push(queuedRunId);
      this.startProcessor();
    }
  }

  private startProcessor(): void {
    if (this.processor !== undefined || this.stopping) return;
    this.processor = this.processQueue().catch(() => {
      // 存储写入失败会由 Store 自身转为 unavailable；后台队列在此收口，
      // 避免未处理的 Promise 拒绝影响聊天等独立能力。
    }).finally(() => {
      this.processor = undefined;
      if (this.executionQueue.length > 0 && !this.stopping) this.startProcessor();
      this.arm();
    });
  }

  private async processQueue(): Promise<void> {
    while (!this.stopping) {
      const runId = this.executionQueue.shift();
      if (runId === undefined) return;
      await this.execute(runId);
    }
  }

  private async execute(runId: string): Promise<void> {
    let run: ScheduledTaskRun | undefined;
    const startedAt = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const candidate = draft.runs.find((item) => item.id === runId);
      if (candidate === undefined || candidate.status !== "queued") return;
      candidate.status = "running";
      candidate.startedAt = startedAt;
      run = structuredClone(candidate);
    });
    if (run === undefined) return;

    const controller = new AbortController();
    this.currentAbort = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.runTimeoutMs);
    timeout.unref?.();
    try {
      const resolved = this.options.modelRegistry.resolve(run.task.modelId);
      const agent = new ResumableChatAgent(
        resolved.client,
        this.options.toolRegistry,
        {
          maxSteps: 10,
          ...(this.options.contextOptions === undefined
            ? {} : { context: this.options.contextOptions }),
          ...(this.options.permissionService === undefined
            ? {} : { permissionService: this.options.permissionService, runId }),
          onPermissionWait: (request) => this.markPermissionWait(runId, request),
          shouldPause: () => this.options.store.getRun(runId)?.status === "pausing",
          onActivity: (activity) => this.saveActivity(runId, activity),
          onCheckpoint: (checkpoint) => this.saveCheckpoint(runId, checkpoint),
        },
      );
      const outcome = await agent.run([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: run.task.prompt },
      ], run.checkpoint, controller.signal);
      if (outcome.type === "permission_wait") {
        // 已进入 needs_confirmation（markPermissionWait 已写库）；等待授权决定。
        return;
      }
      if (outcome.type === "paused") {
        await this.markPaused(runId, outcome.checkpoint);
        return;
      }
      const result = outcome.result;
      await this.finishRun(runId, {
        status: "succeeded",
        content: result.content,
        model: result.model,
        ...(result.totalTokens === undefined ? {} : { totalTokens: result.totalTokens }),
        steps: result.steps,
        toolExecutions: [...result.toolExecutions],
        ...(result.context === undefined ? {} : { context: result.context }),
      });
    } catch (error) {
      const interrupted = this.stopping && controller.signal.aborted;
      if (interrupted) {
        await this.recoverInterruptedRun(runId, "服务已停止");
        return;
      }
      await this.finishRun(runId, {
        status: interrupted ? "interrupted" : timedOut ? "timed_out" : "failed",
        error: interrupted
          ? "服务已停止，任务执行被中断"
          : timedOut ? "任务执行超过 10 分钟，已取消" : stableErrorSummary(error),
      });
    } finally {
      clearTimeout(timeout);
      this.currentAbort = undefined;
    }
  }

  private async saveActivity(runId: string, activity: AgentRunActivity): Promise<void> {
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run !== undefined && (run.status === "running" || run.status === "pausing")) {
        run.activity = structuredClone(activity);
      }
    });
  }

  private async saveCheckpoint(
    runId: string,
    checkpoint: AgentRunCheckpoint,
  ): Promise<void> {
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run !== undefined && (run.status === "running" || run.status === "pausing")) {
        run.checkpoint = structuredClone(checkpoint);
        delete run.activity;
      }
    });
  }

  private async markPermissionWait(
    runId: string,
    request: PermissionRequestPublic,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.status === "needs_confirmation") return;
      if (!["running", "pausing"].includes(run.status)) return;
      run.status = "needs_confirmation";
      run.finishedAt = timestamp;
      run.confirmation = {
        type: "tool_permission",
        permissionRequestId: request.id,
        toolName: request.toolName,
        target: request.target,
      };
      delete run.activity;
    });
  }

  /**
   * 授权决定已写入授权记忆后，从 needs_confirmation(工具授权) 续跑：
   * 恢复为 queued 并从同一待执行工具继续（不重复有副作用的工具）。
   */
  async continueAfterPermission(runId: string): Promise<void> {
    const timestamp = this.now().toISOString();
    let resumed = false;
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return;
      if (run.status !== "needs_confirmation") return;
      if (run.confirmation?.type !== "tool_permission") return;
      run.status = "queued";
      run.resumedAt = timestamp;
      delete run.confirmation;
      delete run.error;
      delete run.finishedAt;
      resumed = true;
    });
    if (!resumed) return;
    this.executionQueue.push(runId);
    this.startProcessor();
  }

  private async markPaused(
    runId: string,
    checkpoint: AgentRunCheckpoint,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || (run.status !== "pausing" && run.status !== "running")) return;
      run.status = "paused";
      run.pausedAt = timestamp;
      run.checkpoint = structuredClone(checkpoint);
      delete run.activity;
    });
  }

  private async recoverInterruptedRun(runId: string, reason: string): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run !== undefined) recoverRunAtStartup(run, timestamp, reason);
    });
  }

  private async recoverActiveRuns(reason: string): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      for (const run of draft.runs) {
        if (run.status === "queued" || run.status === "running" || run.status === "pausing") {
          recoverRunAtStartup(run, timestamp, reason);
        }
      }
    });
  }

  private async finishRun(
    runId: string,
    result: Pick<ScheduledTaskRun, "status"> & Partial<ScheduledTaskRun>,
  ): Promise<void> {
    const finishedAt = this.now().toISOString();
    await this.options.store.mutate((draft) => {
      const run = draft.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || !["queued", "running", "pausing"].includes(run.status)) return;
      Object.assign(run, result, { finishedAt });
      delete run.checkpoint;
      delete run.activity;
      delete run.pauseRequestedAt;
      delete run.pausedAt;
      delete run.recoveryReason;
      if (run.trigger === "scheduled" && run.task.schedule.type === "once") {
        removeTask(draft, run.taskId);
      }
    });
  }

  private arm(): void {
    if (!this.started || !this.available || this.stopping) return;
    this.clearWakeTimer();
    const now = this.now().getTime();
    const next = this.options.store.listTasks()
      .filter((task) => task.enabled && task.nextRunAt !== null)
      .map((task) => new Date(task.nextRunAt as string).getTime())
      .sort((a, b) => a - b)[0];
    const delay = next === undefined
      ? MAX_WAKE_DELAY_MS
      : Math.max(0, Math.min(MAX_WAKE_DELAY_MS, next - now));
    this.wakeTimer = setTimeout(() => void this.checkDue(), delay);
    this.wakeTimer.unref?.();
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private validateModel(modelId: string): void {
    try {
      this.options.modelRegistry.resolve(modelId);
    } catch (error) {
      if (error instanceof UnsupportedChatModelError) {
        throw new ScheduledTaskError("TASK_MODEL_UNSUPPORTED", "所选模型不存在", 400);
      }
      if (error instanceof UnavailableChatModelError) {
        throw new ScheduledTaskError("TASK_MODEL_UNAVAILABLE", "所选模型当前不可用", 503);
      }
      throw error;
    }
  }

  private validateTaskSchedule(input: ScheduledTaskInput, now: Date): void {
    try {
      validateSchedule(input.schedule, now);
    } catch (error) {
      if (error instanceof TaskScheduleError) {
        const code = input.schedule.type === "once" && /晚于/.test(error.message)
          ? "TASK_SCHEDULE_PAST" : "TASK_SCHEDULE_INVALID";
        throw new ScheduledTaskError(code, error.message, code === "TASK_SCHEDULE_PAST" ? 409 : 400);
      }
      throw error;
    }
  }

  private assertAvailable(): void {
    if (!this.options.authConfigured) {
      throw new ScheduledTaskError("AUTH_NOT_CONFIGURED", "未配置 PAN_PILOT_API_TOKEN", 503);
    }
    if (!this.options.store.available) {
      throw new ScheduledTaskError(
        "SCHEDULE_STORE_UNAVAILABLE", "定时任务存储不可用", 503,
      );
    }
  }
}

function createRun(
  id: string,
  task: ScheduledTask,
  trigger: ScheduledTaskRun["trigger"],
  scheduledFor: string | null,
  queuedAt: string,
): ScheduledTaskRun {
  return {
    id,
    taskId: task.id,
    trigger,
    status: "queued",
    task: taskSnapshot(task),
    scheduledFor,
    queuedAt,
  };
}

function createSkippedRun(
  id: string,
  task: ScheduledTask,
  status: "skipped_overlap" | "skipped_misfire",
  scheduledFor: string,
  queuedAt: string,
  error: string,
): ScheduledTaskRun {
  return {
    ...createRun(id, task, "scheduled", scheduledFor, queuedAt),
    status,
    finishedAt: queuedAt,
    error,
  };
}

function assertTaskInactive(state: ScheduledTaskState, taskId: string): void {
  if (isTaskActive(state, taskId)) {
    throw new ScheduledTaskError(
      "TASK_ALREADY_ACTIVE", "任务正在排队或执行，暂时不能执行此操作", 409,
    );
  }
}

function isTaskActive(state: ScheduledTaskState, taskId: string): boolean {
  return state.runs.some((run) => run.taskId === taskId
    && ["queued", "running", "pausing", "paused", "needs_confirmation"]
      .includes(run.status));
}

function taskNotFound(): ScheduledTaskError {
  return new ScheduledTaskError("TASK_NOT_FOUND", "定时任务不存在", 404);
}

function runNotFound(): ScheduledTaskError {
  return new ScheduledTaskError("TASK_RUN_NOT_FOUND", "任务运行记录不存在", 404);
}

function removeTask(state: ScheduledTaskState, taskId: string): void {
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index >= 0) state.tasks.splice(index, 1);
}

function removeInterruptedOnceTasks(state: ScheduledTaskState): void {
  const ids = new Set(state.runs
    .filter((run) => run.status === "interrupted" && run.task.schedule.type === "once")
    .map((run) => run.taskId));
  state.tasks = state.tasks.filter((task) => !ids.has(task.id));
}

function recoverRunAtStartup(
  run: ScheduledTaskRun,
  timestamp: string,
  reason: string,
): void {
  if (run.status === "paused" || run.status === "needs_confirmation") return;
  if (run.status === "queued") return;
  if (run.activity?.phase === "tool") {
    run.status = "needs_confirmation";
    run.finishedAt = timestamp;
    run.recoveryReason =
      `${reason}；工具 ${run.activity.toolName} 的执行结果不确定，请选择重试或终止`;
    run.error = run.recoveryReason;
    return;
  }
  if (run.checkpoint === undefined) {
    run.status = "needs_confirmation";
    run.finishedAt = timestamp;
    run.recoveryReason = `${reason}；旧运行没有安全检查点，无法确认是否已执行工具`;
    run.error = run.recoveryReason;
    return;
  }
  if (run.status === "pausing") {
    run.status = "paused";
    run.pausedAt = timestamp;
    delete run.activity;
    return;
  }
  run.status = "queued";
  run.resumedAt = timestamp;
  delete run.activity;
  delete run.finishedAt;
  delete run.error;
}

function stableErrorSummary(error: unknown): string {
  if (error instanceof UnsupportedChatModelError) return "保存的模型 ID 不再受支持";
  if (error instanceof UnavailableChatModelError) return "保存的模型当前不可用";
  if (error instanceof ScheduledTaskStoreUnavailableError) return "定时任务存储不可用";
  if (error instanceof AgentMaxStepsError) return "Agent 达到最大执行步数仍未完成";
  // 不落盘上游原始报错，避免 URL、请求上下文或厂商诊断细节进入历史。
  return "模型、工具或上游服务执行失败";
}
