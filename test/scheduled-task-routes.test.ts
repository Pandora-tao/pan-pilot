import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

describe("scheduled task routes and Agent integration", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("fails closed when API token is not configured", async () => {
    const app = buildApp({ modelClient: client(vi.fn()), scheduledTasksDir: tempDir() });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/scheduled-tasks" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "AUTH_NOT_CONFIGURED" });
  });

  it("returns 503 for corrupt state while chat remains available", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "scheduled-tasks.json"), "{broken");
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({ content: "chat ok", toolCalls: [], model: "test" });
    const app = buildApp({ modelClient: client(complete), apiToken: "secret", scheduledTasksDir: dir });
    apps.push(app);
    const tasks = await authInject(app, "GET", "/v1/scheduled-tasks");
    expect(tasks.statusCode).toBe(503);
    expect(tasks.json()).toMatchObject({ error: "SCHEDULE_STORE_UNAVAILABLE" });
    const chat = await authInject(app, "POST", "/v1/chat", { message: "继续工作" });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({ message: "chat ok" });
  });

  it("rejects past once rules and invalid run-history limits with stable codes", async () => {
    const app = buildApp({ modelClient: client(vi.fn()), apiToken: "secret", scheduledTasksDir: tempDir() });
    apps.push(app);
    const past = await createTask(app, { type: "once", at: "2020-01-01T09:00" });
    expect(past.statusCode).toBe(409);
    expect(past.json()).toMatchObject({ error: "TASK_SCHEDULE_PAST" });
    const limit = await authInject(app, "GET", "/v1/scheduled-task-runs?limit=201");
    expect(limit.statusCode).toBe(400);
    expect(limit.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("requires Bearer auth and supports CRUD, enable, and delete", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({ content: "ok", toolCalls: [], model: "test" });
    const app = buildApp({ modelClient: client(complete), apiToken: "secret", scheduledTasksDir: tempDir() });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/v1/scheduled-tasks" })).statusCode).toBe(401);
    const created = await createTask(app, { type: "daily", time: "09:00" });
    expect(created.statusCode).toBe(201);
    const id = created.json().task.id as string;
    const disabled = await authInject(app, "POST", `/v1/scheduled-tasks/${id}/disable`);
    expect(disabled.json().task.nextRunAt).toBeNull();
    const enabled = await authInject(app, "POST", `/v1/scheduled-tasks/${id}/enable`);
    expect(enabled.json().task.nextRunAt).toBeTruthy();
    expect((await authInject(app, "DELETE", `/v1/scheduled-tasks/${id}`)).statusCode).toBe(204);
  });

  it("runs a real ChatAgent tool loop and persists safe execution summary", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "calc-1", name: "calculator", arguments: { operation: "multiply", left: 6, right: 7 } }], model: "test", totalTokens: 5 })
      .mockResolvedValueOnce({ content: "答案是 42", toolCalls: [], model: "test", totalTokens: 4 });
    const app = buildApp({ modelClient: client(complete), apiToken: "secret", scheduledTasksDir: tempDir() });
    apps.push(app);
    const id = (await createTask(app, { type: "daily", time: "09:00" })).json().task.id as string;
    expect((await authInject(app, "POST", `/v1/scheduled-tasks/${id}/run`)).statusCode).toBe(202);
    const run = await waitForRun(app, id, "succeeded");
    expect(run).toMatchObject({ content: "答案是 42", model: "test", totalTokens: 9, steps: 2, toolExecutions: [{ id: "calc-1", name: "calculator", status: "success" }] });
    expect(JSON.stringify(run)).not.toContain("left");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rejects a second manual run and editing while active", async () => {
    let finish!: () => void;
    const complete = vi.fn<ModelClient["complete"]>().mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ content: "done", toolCalls: [], model: "test" }); }));
    const app = buildApp({ modelClient: client(complete), apiToken: "secret", scheduledTasksDir: tempDir() });
    apps.push(app);
    const id = (await createTask(app, { type: "daily", time: "09:00" })).json().task.id as string;
    await authInject(app, "POST", `/v1/scheduled-tasks/${id}/run`);
    const duplicate = await authInject(app, "POST", `/v1/scheduled-tasks/${id}/run`);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: "TASK_ALREADY_ACTIVE" });
    const edit = await authInject(app, "PUT", `/v1/scheduled-tasks/${id}`, taskPayload({ type: "daily", time: "10:00" }));
    expect(edit.statusCode).toBe(409);
    finish();
    await waitForRun(app, id, "succeeded");
  });

  it("cancels execution at the configured timeout", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockImplementation((request) => new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const app = buildApp({ modelClient: client(complete), apiToken: "secret", scheduledTasksDir: tempDir(), scheduledTaskRunTimeoutMs: 10 });
    apps.push(app);
    const id = (await createTask(app, { type: "daily", time: "09:00" })).json().task.id as string;
    await authInject(app, "POST", `/v1/scheduled-tasks/${id}/run`);
    expect(await waitForRun(app, id, "timed_out")).toMatchObject({ error: expect.stringContaining("10 分钟") });
  });

  it("pauses at a safe boundary and resumes from the persisted checkpoint", async () => {
    let finishModel!: () => void;
    const firstCompletion = new Promise<Awaited<ReturnType<ModelClient["complete"]>>>((resolve) => {
      finishModel = () => resolve({
        content: "",
        toolCalls: [{
          id: "calc-pause",
          name: "calculator",
          arguments: { operation: "multiply", left: 6, right: 7 },
        }],
        model: "test",
        totalTokens: 5,
      });
    });
    const complete = vi.fn<ModelClient["complete"]>()
      .mockImplementationOnce(() => firstCompletion)
      .mockResolvedValueOnce({
        content: "恢复后答案是 42",
        toolCalls: [],
        model: "test",
        totalTokens: 4,
      });
    const app = buildApp({
      modelClient: client(complete),
      apiToken: "secret",
      scheduledTasksDir: tempDir(),
    });
    apps.push(app);
    const id = (await createTask(app, { type: "daily", time: "09:00" })).json().task.id as string;
    const runId = (await authInject(app, "POST", `/v1/scheduled-tasks/${id}/run`))
      .json().run.id as string;
    await waitForRun(app, id, "running");

    const pausing = await authInject(
      app,
      "POST",
      `/v1/scheduled-task-runs/${runId}/pause`,
    );
    expect(pausing.json().run.status).toBe("pausing");
    finishModel();
    const paused = await waitForRun(app, id, "paused");
    expect(JSON.stringify(paused)).not.toContain("arguments");
    expect(JSON.stringify(paused)).not.toContain("left");

    const resumed = await authInject(
      app,
      "POST",
      `/v1/scheduled-task-runs/${runId}/resume`,
    );
    expect(resumed.json().run.status).toBe("queued");
    expect(await waitForRun(app, id, "succeeded")).toMatchObject({
      content: "恢复后答案是 42",
      steps: 2,
      toolExecutions: [{ id: "calc-pause", name: "calculator", status: "success" }],
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("pauses a queued run immediately without calling the model", async () => {
    let finishFirst!: () => void;
    const complete = vi.fn<ModelClient["complete"]>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = () => resolve({ content: "first done", toolCalls: [], model: "test" });
      }))
      .mockResolvedValue({ content: "second done", toolCalls: [], model: "test" });
    const app = buildApp({
      modelClient: client(complete),
      apiToken: "secret",
      scheduledTasksDir: tempDir(),
    });
    apps.push(app);
    const firstId = (await createTask(app, { type: "daily", time: "09:00" })).json().task.id as string;
    const secondId = (await createTask(app, { type: "daily", time: "10:00" })).json().task.id as string;
    await authInject(app, "POST", `/v1/scheduled-tasks/${firstId}/run`);
    await waitForRun(app, firstId, "running");
    const secondRunId = (await authInject(app, "POST", `/v1/scheduled-tasks/${secondId}/run`))
      .json().run.id as string;

    const paused = await authInject(
      app,
      "POST",
      `/v1/scheduled-task-runs/${secondRunId}/pause`,
    );
    expect(paused.json().run.status).toBe("paused");
    finishFirst();
    await waitForRun(app, firstId, "succeeded");
    expect(complete).toHaveBeenCalledTimes(1);

    await authInject(app, "POST", `/v1/scheduled-task-runs/${secondRunId}/resume`);
    expect(await waitForRun(app, secondId, "succeeded"))
      .toMatchObject({ content: "second done" });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

function client(complete: ModelClient["complete"]): ModelClient { return { complete, async *completeStream() { throw new Error("unused"); } }; }
function tempDir(): string { return mkdtempSync(path.join(tmpdir(), "panpilot-routes-")); }
function taskPayload(schedule: unknown) { return { name: "日报", prompt: "计算 6×7", modelId: "volcengine/deepseek-v4-flash", enabled: true, schedule }; }
function createTask(app: ReturnType<typeof buildApp>, schedule: unknown) { return authInject(app, "POST", "/v1/scheduled-tasks", taskPayload(schedule)); }
async function authInject(app: ReturnType<typeof buildApp>, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  if (payload === undefined) return app.inject({ method, url, headers: { authorization: "Bearer secret" } });
  return app.inject({ method, url, headers: { authorization: "Bearer secret", "content-type": "application/json" }, payload: JSON.stringify(payload) });
}
async function waitForRun(app: ReturnType<typeof buildApp>, taskId: string, status: string) { for (let attempt = 0; attempt < 100; attempt += 1) { const response = await authInject(app, "GET", `/v1/scheduled-task-runs?taskId=${taskId}&limit=10`); const run = response.json().runs.find((item: { status: string }) => item.status === status); if (run) return run; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error(`run did not reach ${status}`); }
