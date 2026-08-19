import { mkdtempSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../src/model/model-client.js";
import {
  createInjectedChatModelRegistry,
  DEFAULT_CHAT_MODEL_ID,
} from "../src/model/model-registry.js";
import { PermissionService } from "../src/permissions/permission-service.js";
import { PermissionStore } from "../src/permissions/permission-store.js";
import { ScheduledTaskScheduler } from "../src/scheduled-tasks/scheduled-task-scheduler.js";
import { ScheduledTaskStore } from "../src/scheduled-tasks/scheduled-task-store.js";
import type { ScheduledTaskInput } from "../src/scheduled-tasks/types.js";
import { createFilesystemTools } from "../src/tools/filesystem.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

/** 定时任务授权闭环：授权点挂起（needs_confirmation）、决定后从同一工具恢复。 */
describe("ScheduledTaskScheduler 授权闭环", () => {
  const tempDirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "panpilot-task-perm-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function makeFsTools(hostCwd: string, adminRoots: string[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of createFilesystemTools({ hostCwd, adminRoots })) {
      registry.registerCore(tool);
    }
    return registry;
  }

  function client(complete: ModelClient["complete"]): ModelClient {
    return {
      complete,
      async *completeStream() {
        throw new Error("unused");
      },
    };
  }

  function input(name: string, prompt: string): ScheduledTaskInput {
    return { name, prompt, modelId: DEFAULT_CHAT_MODEL_ID, enabled: true, schedule: { type: "daily", time: "09:00" } as const };
  }

  it("授权请求挂起为 needs_confirmation，批准后从同一工具继续且只写一次", async () => {
    const workdir = tempDir();
    const taskDir = tempDir();
    const permDir = tempDir();
    const target = path.join(workdir, "hello.txt");

    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call-1", name: "fs_write", arguments: { path: target, content: "hello" } }],
        model: "test",
      })
      .mockResolvedValue({ content: "完成", toolCalls: [], model: "test" });

    const store = new ScheduledTaskStore(taskDir);
    const registry = makeFsTools(workdir, [workdir]);
    const permissionStore = new PermissionStore(permDir);
    const service = new PermissionService({ store: permissionStore });
    const scheduler = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(complete)),
      toolRegistry: registry,
      authConfigured: true,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      permissionService: service,
    });
    await scheduler.start();

    const task = await scheduler.create(input("write-task", "把 hello 写入文件"));
    const run = await scheduler.runNow(task.id);
    await scheduler.waitForIdle();
    const runId = run.id;

    // 工具授权挂起：进入 needs_confirmation，文件尚未写入。
    const parked = store.getRun(runId);
    expect(parked).toMatchObject({
      status: "needs_confirmation",
      confirmation: {
        type: "tool_permission",
        toolName: "fs_write",
        target,
      },
    });
    expect(parked!.recoveryReason).toBeUndefined(); // 区别于「异常恢复」
    await expect(fsp.stat(target)).rejects.toThrow();

    // 批准（allow_once）：决定写入授权记忆后，从同一待执行工具续跑。
    const pending = service.listPending();
    expect(pending).toHaveLength(1);
    service.decide(pending[0]!.id, "allow_once");
    await scheduler.continueAfterPermission(runId);

    await scheduler.waitForIdle();
    const finished = store.getRun(runId);
    expect(finished?.status).toBe("succeeded");
    // 工具只执行一次，文件内容正确。
    expect(await fsp.readFile(target, "utf8")).toBe("hello");
    const executions = finished!.toolExecutions ?? [];
    const writes = executions.filter((e) => e.name === "fs_write" && e.status === "success");
    expect(writes).toHaveLength(1);

    await scheduler.stop();
  });

  it("拒绝授权时把权限错误作为工具结果反馈模型，任务继续完成", async () => {
    const workdir = tempDir();
    const taskDir = tempDir();
    const permDir = tempDir();
    const target = path.join(workdir, "denied.txt");

    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call-1", name: "fs_write", arguments: { path: target, content: "x" } }],
        model: "test",
      })
      .mockImplementation(async (request) => {
        const toolMessages = request.messages.filter((m) => m.role === "tool");
        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0]!.content).toContain("PERMISSION_DENIED");
        expect(toolMessages[0]!.name).toBe("fs_write");
        return { content: "已告知用户权限被拒", toolCalls: [], model: "test" };
      });

    const store = new ScheduledTaskStore(taskDir);
    const registry = makeFsTools(workdir, [workdir]);
    const permissionStore = new PermissionStore(permDir);
    const service = new PermissionService({ store: permissionStore });
    const scheduler = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(complete)),
      toolRegistry: registry,
      authConfigured: true,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      permissionService: service,
    });
    await scheduler.start();

    const task = await scheduler.create(input("deny-task", "写入被拒的文件"));
    const run = await scheduler.runNow(task.id);
    await scheduler.waitForIdle();

    const parked = store.getRun(run.id);
    expect(parked?.status).toBe("needs_confirmation");

    const pending = service.listPending();
    service.decide(pending[0]!.id, "reject");
    await scheduler.continueAfterPermission(run.id);
    await scheduler.waitForIdle();

    const finished = store.getRun(run.id);
    expect(finished?.status).toBe("succeeded");
    expect(complete).toHaveBeenCalledTimes(2);
    await expect(fsp.stat(target)).rejects.toThrow();

    await scheduler.stop();
  });

  it("服务「重启」后待决请求被恢复，批准后从检查点继续", async () => {
    const workdir = tempDir();
    const taskDir = tempDir();
    const permDir = tempDir();
    const target = path.join(workdir, "restart.txt");

    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call-1", name: "fs_write", arguments: { path: target, content: "viable" } }],
        model: "test",
      })
      .mockResolvedValue({ content: "完成", toolCalls: [], model: "test" });

    const store = new ScheduledTaskStore(taskDir);
    const registry = makeFsTools(workdir, [workdir]);
    const permissionStore = new PermissionStore(permDir);
    const first = new PermissionService(
      { store: permissionStore, onRequestDecided: () => {} },
    );
    const scheduler = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(complete)),
      toolRegistry: registry,
      authConfigured: true,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      permissionService: first,
    });
    await scheduler.start();

    const task = await scheduler.create(input("restart-task", "写文件"));
    const firstRun = await scheduler.runNow(task.id);
    await scheduler.waitForIdle();
    const parked = store.getRun(firstRun.id);
    expect(parked?.status).toBe("needs_confirmation");
    const requestId = parked!.confirmation!.permissionRequestId;
    await scheduler.stop();

    // 模拟服务重启：同一 store 与新 PermissionService（从磁盘恢复待决请求）。
    const restarted = new PermissionService({ store: new PermissionStore(permDir) });
    const scheduler2 = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(complete)),
      toolRegistry: registry,
      authConfigured: true,
      now: () => new Date("2026-08-13T00:30:00.000Z"),
      permissionService: restarted,
    });
    await scheduler2.start();

    expect(restarted.listPending().some((r) => r.id === requestId)).toBe(true);
    restarted.decide(requestId, "allow_once");
    await scheduler2.continueAfterPermission(firstRun.id);
    await scheduler2.waitForIdle();

    const finished = store.getRun(firstRun.id);
    expect(finished?.status).toBe("succeeded");
    expect(await fsp.readFile(target, "utf8")).toBe("viable");

    await scheduler2.stop();
  });

  it("暂停任务后从检查点恢复，不会重复执行已完成的工具", async () => {
    // 复用拒绝流程验证：先挂起（授权），再走 continueAfterPermission。
    const workdir = tempDir();
    const taskDir = tempDir();
    const permDir = tempDir();
    const target = path.join(workdir, "resume.txt");

    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call-1", name: "fs_write", arguments: { path: target, content: "resumed" } }],
        model: "test",
      })
      .mockResolvedValue({ content: "完成", toolCalls: [], model: "test" });

    const store = new ScheduledTaskStore(taskDir);
    const registry = makeFsTools(workdir, [workdir]);
    const permissionStore = new PermissionStore(permDir);
    const service = new PermissionService({ store: permissionStore });
    const scheduler = new ScheduledTaskScheduler({
      store,
      modelRegistry: createInjectedChatModelRegistry(client(complete)),
      toolRegistry: registry,
      authConfigured: true,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
      permissionService: service,
    });
    await scheduler.start();

    const task = await scheduler.create(input("resume-task", "写文件"));
    const run = await scheduler.runNow(task.id);
    await scheduler.waitForIdle();
    expect(store.getRun(run.id)?.status).toBe("needs_confirmation");
    expect(await fsp.stat(target).catch(() => null)).toBeNull();

    const pending = service.listPending();
    service.decide(pending[0]!.id, "allow_once");
    await scheduler.continueAfterPermission(run.id);
    await scheduler.waitForIdle();
    expect(store.getRun(run.id)?.status).toBe("succeeded");
    expect(await fsp.readFile(target, "utf8")).toBe("resumed");
    await scheduler.stop();
  });
});
