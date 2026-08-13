import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../src/model/model-client.js";
import { createInjectedChatModelRegistry, DEFAULT_CHAT_MODEL_ID } from "../src/model/model-registry.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduled-task-scheduler.js";
import { ScheduledTaskStore } from "../src/scheduled-tasks/scheduled-task-store.js";
import type { ScheduledTask, ScheduledTaskRun } from "../src/scheduled-tasks/types.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

describe("ScheduledTaskScheduler", () => {
  it("executes all tasks through a single FIFO and never overlaps globally", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const complete = vi.fn<ModelClient["complete"]>(async (request) => {
      const prompt = request.messages.at(-1)?.content ?? "";
      order.push(`start:${prompt}`);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 8));
      concurrent -= 1;
      order.push(`end:${prompt}`);
      return { content: prompt, toolCalls: [], model: "test" };
    });
    const { scheduler } = harness(complete, () => new Date("2026-08-13T00:00:00.000Z"));
    await scheduler.start();
    const first = await scheduler.create(input("first", { type: "daily", time: "09:00" }));
    const second = await scheduler.create(input("second", { type: "daily", time: "09:00" }));
    await Promise.all([scheduler.runNow(first.id), scheduler.runNow(second.id)]);
    await scheduler.waitForIdle();
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    await scheduler.stop();
  });

  it("auto-deletes a completed once task but manual run preserves its plan", async () => {
    let now = new Date(2026, 7, 13, 8, 0, 0, 0);
    const { scheduler, store } = harness(
      vi.fn<ModelClient["complete"]>().mockResolvedValue({ content: "done", toolCalls: [], model: "test" }),
      () => new Date(now),
    );
    await scheduler.start();
    const onceAt = localInput(new Date(2026, 7, 13, 8, 1, 0, 0));
    const task = await scheduler.create(input("once", { type: "once", at: onceAt }));
    const planned = task.nextRunAt;
    await scheduler.runNow(task.id);
    await scheduler.waitForIdle();
    expect(store.getTask(task.id)?.nextRunAt).toBe(planned);
    now = new Date(2026, 7, 13, 8, 2, 0, 0);
    await scheduler.checkDue();
    await scheduler.waitForIdle();
    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.listRuns({ taskId: task.id, limit: 10 }).map((run) => run.trigger).sort())
      .toEqual(["manual", "scheduled"]);
    await scheduler.stop();
  });

  it("recovers stale runs and records only one missed occurrence", async () => {
    const store = new ScheduledTaskStore(tempDir());
    const recurring = persistedTask("recurring", { type: "daily", time: "09:00" }, "2026-08-12T01:00:00.000Z");
    const once = persistedTask("once", { type: "once", at: "2026-08-12T09:00" }, "2026-08-12T01:00:00.000Z");
    const activeOnce = persistedTask("active-once", { type: "once", at: "2026-08-13T09:00" }, "2026-08-13T01:00:00.000Z");
    await store.mutate((draft) => {
      draft.tasks.push(recurring, once, activeOnce);
      draft.runs.push(persistedRun(activeOnce, "running"));
    });
    const scheduler = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(vi.fn())),
      toolRegistry: new ToolRegistry(),
      authConfigured: true,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    await scheduler.start();
    expect(store.getTask("once")).toBeUndefined();
    expect(store.getTask("active-once")).toBeDefined();
    expect(new Date(store.getTask("recurring")?.nextRunAt ?? 0).getTime())
      .toBeGreaterThan(new Date("2026-08-13T00:00:00.000Z").getTime());
    expect(store.listRuns({ limit: 20 }).filter((run) => run.status === "skipped_misfire"))
      .toHaveLength(2);
    const recovered = store.listRuns({ limit: 20 })
      .find((run) => run.taskId === "active-once");
    expect(recovered).toMatchObject({
      status: "needs_confirmation",
      recoveryReason: expect.stringContaining("没有安全检查点"),
    });
    await scheduler.stop();
  });

  it("requires confirmation when restart occurred during a tool call", async () => {
    const store = new ScheduledTaskStore(tempDir());
    const task = persistedTask(
      "uncertain",
      { type: "daily", time: "09:00" },
      "2026-08-14T01:00:00.000Z",
    );
    await store.mutate((draft) => {
      draft.tasks.push(task);
      draft.runs.push({
        ...persistedRun(task, "running"),
        checkpoint: {
          version: 1,
          history: [{ role: "user", content: "计算" }],
          pendingToolCalls: [{
            id: "calc-uncertain",
            name: "calculator",
            arguments: { operation: "add", left: 1, right: 2 },
          }],
          nextToolCallIndex: 0,
          steps: 1,
          model: "test",
          toolExecutions: [],
        },
        activity: {
          phase: "tool",
          toolCallId: "calc-uncertain",
          toolName: "calculator",
        },
      });
    });
    const scheduler = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(vi.fn())),
      toolRegistry: new ToolRegistry(),
      authConfigured: true,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });

    await scheduler.start();
    const uncertain = store.getRun("uncertain-run");
    expect(uncertain).toMatchObject({
      status: "needs_confirmation",
      recoveryReason: expect.stringContaining("calc"),
    });
    await expect(scheduler.resumeRun("uncertain-run"))
      .rejects.toMatchObject({ code: "TASK_RUN_CONFIRMATION_REQUIRED" });
    expect(await scheduler.resolveRecovery("uncertain-run", "terminate"))
      .toMatchObject({ status: "interrupted" });
    await scheduler.stop();
  });
});

function harness(complete: ModelClient["complete"], now: () => Date) {
  const store = new ScheduledTaskStore(tempDir());
  const scheduler = new ScheduledTaskScheduler({ store, modelRegistry: createInjectedChatModelRegistry(client(complete)), toolRegistry: new ToolRegistry(), authConfigured: true, now });
  return { scheduler, store };
}
function client(complete: ModelClient["complete"]): ModelClient { return { complete, async *completeStream() { throw new Error("unused"); } }; }
function input(prompt: string, schedule: Parameters<typeof persistedTask>[1]) { return { name: prompt, prompt, modelId: DEFAULT_CHAT_MODEL_ID, enabled: true, schedule }; }
function tempDir(): string { return mkdtempSync(path.join(tmpdir(), "panpilot-scheduler-")); }
function localInput(date: Date): string { const pad = (value: number) => String(value).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function persistedTask(id: string, schedule: ScheduledTask["schedule"], nextRunAt: string): ScheduledTask { return { id, name: id, prompt: id, modelId: DEFAULT_CHAT_MODEL_ID, enabled: true, schedule, nextRunAt, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }; }
function persistedRun(task: ScheduledTask, status: "queued" | "running"): ScheduledTaskRun { return { id: `${task.id}-run`, taskId: task.id, trigger: "scheduled", status, task: { taskId: task.id, name: task.name, prompt: task.prompt, modelId: task.modelId, schedule: task.schedule }, scheduledFor: task.nextRunAt, queuedAt: "2026-08-12T23:00:00.000Z", ...(status === "running" ? { startedAt: "2026-08-12T23:00:01.000Z" } : {}) }; }
