import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  scheduledTaskStateSchema,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskState,
} from "./types.js";

const STATE_FILE = "scheduled-tasks.json";
const MAX_RUNS_PER_TASK = 10;
const MAX_GLOBAL_RUNS = 200;

export class ScheduledTaskStoreUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ScheduledTaskStoreUnavailableError";
  }
}

export class ScheduledTaskStore {
  private state: ScheduledTaskState = { version: 1, tasks: [], runs: [] };
  private unavailableReason: string | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly statePath: string;
  private readonly resolvedRootDir: string;

  constructor(private readonly rootDir: string) {
    this.resolvedRootDir = path.resolve(rootDir);
    this.statePath = path.join(this.resolvedRootDir, STATE_FILE);
    this.load();
  }

  get available(): boolean {
    return this.unavailableReason === undefined;
  }

  get error(): string | undefined {
    return this.unavailableReason;
  }

  listTasks(): ScheduledTask[] {
    this.assertAvailable();
    return structuredClone(this.state.tasks);
  }

  getTask(id: string): ScheduledTask | undefined {
    this.assertAvailable();
    const task = this.state.tasks.find((candidate) => candidate.id === id);
    return task === undefined ? undefined : structuredClone(task);
  }

  listRuns(options: { taskId?: string; limit: number }): ScheduledTaskRun[] {
    this.assertAvailable();
    return structuredClone(this.state.runs
      .filter((run) => options.taskId === undefined || run.taskId === options.taskId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
      .slice(0, options.limit));
  }

  getRun(id: string): ScheduledTaskRun | undefined {
    this.assertAvailable();
    const run = this.state.runs.find((candidate) => candidate.id === id);
    return run === undefined ? undefined : structuredClone(run);
  }

  async mutate(
    mutator: (draft: ScheduledTaskState) => void,
  ): Promise<ScheduledTaskState> {
    this.assertAvailable();
    let result!: ScheduledTaskState;
    let failure: unknown;
    const operation = this.mutationQueue.then(() => {
      const draft = structuredClone(this.state);
      mutator(draft);
      draft.runs = trimRuns(draft.runs);
      const parsed = scheduledTaskStateSchema.safeParse(draft);
      if (!parsed.success) {
        throw new ScheduledTaskStoreUnavailableError(
          "定时任务状态校验失败",
          parsed.error,
        );
      }
      this.persist(parsed.data);
      this.state = parsed.data;
      result = structuredClone(this.state);
    }).catch((error) => {
      if (error instanceof ScheduledTaskStoreUnavailableError) {
        this.markUnavailable(error.message, error.cause ?? error);
      }
      failure = error;
    });
    this.mutationQueue = operation;
    await operation;
    if (failure !== undefined) throw failure;
    return result;
  }

  newId(): string {
    return randomUUID();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      this.markUnavailable("无法读取定时任务状态文件", error);
      return;
    }
    try {
      const parsed = scheduledTaskStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.markUnavailable("定时任务状态文件格式或版本不受支持", parsed.error);
        return;
      }
      this.state = parsed.data;
    } catch (error) {
      this.markUnavailable("定时任务状态文件不是合法 JSON", error);
    }
  }

  private persist(state: ScheduledTaskState): void {
    mkdirSync(this.resolvedRootDir, { recursive: true });
    const tempPath = path.join(this.resolvedRootDir, `.${STATE_FILE}-${randomUUID()}.tmp`);
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(tempPath, this.statePath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw new ScheduledTaskStoreUnavailableError("写入定时任务状态失败", error);
    }
  }

  private assertAvailable(): void {
    if (this.unavailableReason !== undefined) {
      throw new ScheduledTaskStoreUnavailableError(this.unavailableReason);
    }
  }

  private markUnavailable(message: string, cause: unknown): void {
    this.unavailableReason = `${message}: ${messageOf(cause)}`;
  }
}

function trimRuns(runs: ScheduledTaskRun[]): ScheduledTaskRun[] {
  // 活动记录必须优先保留，否则连续 overlap 历史可能把真正运行中的记录挤掉，
  // 令后续触发误判为空闲。其余记录按最新时间裁剪。
  const sorted = [...runs].sort((a, b) => {
    const activeDelta = Number(isActiveRun(b)) - Number(isActiveRun(a));
    return activeDelta || b.queuedAt.localeCompare(a.queuedAt);
  });
  const perTask = new Map<string, number>();
  const kept: ScheduledTaskRun[] = [];
  for (const run of sorted) {
    const count = perTask.get(run.taskId) ?? 0;
    if (count >= MAX_RUNS_PER_TASK) continue;
    perTask.set(run.taskId, count + 1);
    kept.push(run);
    if (kept.length >= MAX_GLOBAL_RUNS) break;
  }
  return kept;
}

function isActiveRun(run: ScheduledTaskRun): boolean {
  return ["queued", "running", "pausing", "paused", "needs_confirmation"]
    .includes(run.status);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
