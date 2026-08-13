import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScheduledTaskStore } from "../src/scheduled-tasks/scheduled-task-store.js";
import type { ScheduledTask, ScheduledTaskRun } from "../src/scheduled-tasks/types.js";

describe("ScheduledTaskStore", () => {
  it("initializes atomically and recovers after restart", async () => {
    const dir = tempDir();
    const store = new ScheduledTaskStore(dir);
    await store.mutate((draft) => draft.tasks.push(task("alpha")));
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(new ScheduledTaskStore(dir).listTasks()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(dir, "scheduled-tasks.json"), "utf8")).version).toBe(1);
  });

  it("protects corrupt and unsupported state without overwriting it", async () => {
    for (const raw of ["{broken", JSON.stringify({ version: 2, tasks: [], runs: [] })]) {
      const dir = tempDir();
      const file = path.join(dir, "scheduled-tasks.json");
      writeFileSync(file, raw);
      const store = new ScheduledTaskStore(dir);
      expect(store.available).toBe(false);
      await expect(store.mutate(() => undefined)).rejects.toThrow(/定时任务/);
      expect(readFileSync(file, "utf8")).toBe(raw);
    }
  });

  it("keeps at most ten runs per task and 200 globally", async () => {
    const store = new ScheduledTaskStore(tempDir());
    await store.mutate((draft) => {
      for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
        const current = task(`task-${taskIndex}`);
        draft.tasks.push(current);
        for (let runIndex = 0; runIndex < 12; runIndex += 1) {
          draft.runs.push(run(current, runIndex));
        }
      }
    });
    const global = store.listRuns({ limit: 200 });
    expect(global).toHaveLength(200);
    const counts = new Map<string, number>();
    for (const item of global) counts.set(item.taskId, (counts.get(item.taskId) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(10);
  });
});

function tempDir(): string { return mkdtempSync(path.join(tmpdir(), "panpilot-schedules-")); }
function task(id: string): ScheduledTask { return { id, name: id, prompt: "执行", modelId: "test/model", enabled: true, schedule: { type: "daily", time: "09:00" }, nextRunAt: "2026-08-14T01:00:00.000Z", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" }; }
function run(current: ScheduledTask, index: number): ScheduledTaskRun { const time = new Date(Date.UTC(2026, 7, 13, 0, index)).toISOString(); return { id: `${current.id}-run-${index}`, taskId: current.id, trigger: "manual", status: "succeeded", task: { taskId: current.id, name: current.name, prompt: current.prompt, modelId: current.modelId, schedule: current.schedule }, scheduledFor: null, queuedAt: time, startedAt: time, finishedAt: time, content: "ok", model: "test" }; }
