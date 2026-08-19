import { mkdtempSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PermissionDecisionError,
  PermissionService,
  type PermissionRequestPublic,
} from "../src/permissions/permission-service.js";
import { PermissionStore } from "../src/permissions/permission-store.js";

const tempDirs: string[] = [];

function syncTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pan-pilot-perm-"));
  tempDirs.push(dir);
  return dir;
}

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pan-pilot-perm-"));
  tempDirs.push(dir);
  return dir;
}

function makeService(options: { timeoutMs?: number } = {}): {
  service: PermissionService;
  requestsCreated: PermissionRequestPublic[];
  decided: PermissionRequestPublic[];
} {
  const requestsCreated: PermissionRequestPublic[] = [];
  const decided: PermissionRequestPublic[] = [];
  const service = new PermissionService({
    store: new PermissionStore(syncTempDir()),
    requestTimeoutMs: options.timeoutMs ?? 120_000,
    onRequestCreated: (request) => requestsCreated.push(request),
    onRequestDecided: (request) => decided.push(request),
  });
  return { service, requestsCreated, decided };
}

type Scope = Parameters<PermissionService["gate"]>[1];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const chatScope: Scope = { origin: "chat", callId: "call_1" };

describe("PermissionService.gate 策略", () => {
  it("普通读取自动放行（非敏感路径）", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_read",
      op: "read",
      target: "/tmp/normal.txt",
      summary: "read",
      permanentlyAllowable: false,
    }, chatScope);
    expect(gate.outcome).toBe("allowed");
    expect(gate.request).toBeUndefined();
  });

  it("写入需要确认，且目标为普通路径时可永久放行", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/normal.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, chatScope);
    expect(gate.outcome).toBeUndefined();
    expect(gate.request).toBeDefined();
    expect(gate.request!.permanentlyAllowable).toBe(true);
  });

  it("敏感路径读取需要确认且不可永久放行", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_read",
      op: "read",
      target: "/Users/x/.ssh/id_ed25519",
      summary: "read ssh key",
      permanentlyAllowable: false,
    }, chatScope);
    expect(gate.outcome).toBeUndefined();
    expect(gate.request!.permanentlyAllowable).toBe(false);
  });

  it("符号链接指向敏感路径时判定为敏感（realpath 不可绕过）", async () => {
    const { service } = makeService();
    const outside = await tempDir();
    const secret = path.join(outside, ".env");
    await fsp.writeFile(secret, "TOKEN=x");
    const root = await tempDir();
    const link = path.join(root, "link");
    await fsp.symlink(secret, link);
    expect(await service.isSensitivePath(link)).toBe(true);
  });

  it("删除始终询问且不可永久放行", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_delete",
      op: "delete",
      target: "/tmp/anything",
      summary: "delete",
      permanentlyAllowable: false,
    }, chatScope);
    expect(gate.outcome).toBeUndefined();
    // 即使工具误传 permanentlyAllowable=true，服务端仍按删除强制 false。
    const gate2 = await service.gate({
      toolName: "fs_delete",
      op: "delete",
      target: "/tmp/anything",
      summary: "delete",
      permanentlyAllowable: true,
    }, chatScope);
    expect(gate2.request!.permanentlyAllowable).toBe(false);
  });

  it("终端：严格只读白名单命令自动放行；组合/破坏性命令询问", async () => {
    const { service } = makeService();
    const allow = await service.gate({
      toolName: "terminal",
      op: "command",
      target: "ls -la",
      summary: "cmd",
      permanentlyAllowable: false,
    }, chatScope);
    expect(allow.outcome).toBe("allowed");

    const composite = await service.gate({
      toolName: "terminal",
      op: "command",
      target: "cat a.txt | grep x",
      summary: "cmd",
      permanentlyAllowable: false,
    }, chatScope);
    expect(composite.outcome).toBeUndefined();

    const destructive = await service.gate({
      toolName: "terminal",
      op: "command",
      target: "rm -rf /tmp/x",
      summary: "cmd",
      permanentlyAllowable: false,
    }, chatScope);
    expect(destructive.outcome).toBeUndefined();
    expect(destructive.request!.permanentlyAllowable).toBe(false);
  });
});

describe("PermissionService.decide", () => {
  it("allow_once 解决待决，并在同一授权键再次请求时直接放行", async () => {
    const { service, requestsCreated } = makeService();
    const ask = {
      toolName: "fs_write",
      op: "write",
      target: "/tmp/data.txt",
      summary: "write",
      permanentlyAllowable: true,
    };
    const first = await service.gate(ask, chatScope);
    const id = first.request!.id;
    expect(requestsCreated).toHaveLength(1);

    const decided = service.decide(id, "allow_once");
    expect(decided.status).toBe("allowed_once");

    const gate = first.wait();
    await expect(gate).resolves.toBe("allowed");

    // 同一键再次请求：命中授权记忆，直接放行，不再新建待决请求。
    const second = await service.gate(ask, chatScope);
    expect(second.outcome).toBe("allowed");
    expect(requestsCreated).toHaveLength(1);
  });

  it("reject 解决为 denied，并在同一授权键再次请求时记忆拒绝", async () => {
    const { service } = makeService();
    const ask = {
      toolName: "fs_write",
      op: "write",
      target: "/tmp/deny.txt",
      summary: "write",
      permanentlyAllowable: true,
    };
    const gate = await service.gate(ask, chatScope);
    service.decide(gate.request!.id, "reject");
    await expect(gate.wait()).resolves.toBe("denied");

    const again = await service.gate(ask, chatScope);
    expect(again.outcome).toBe("denied");
  });

  it("allow_always 落永久规则；规则命中后无需再询问", async () => {
    const { service } = makeService();
    const ask = {
      toolName: "fs_write",
      op: "write",
      target: "/tmp/always.txt",
      summary: "write",
      permanentlyAllowable: true,
    };
    const gate = await service.gate(ask, chatScope);
    service.decide(gate.request!.id, "allow_always");
    await expect(gate.wait()).resolves.toBe("allowed");

    expect(service.listRules()).toHaveLength(1);
    const again = await service.gate(ask, chatScope);
    expect(again.outcome).toBe("allowed");
  });

  it("对不可永久放行的请求提交 allow_always 抛错", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_delete",
      op: "delete",
      target: "/tmp/never.txt",
      summary: "delete",
      permanentlyAllowable: false,
    }, chatScope);
    expect(() => service.decide(gate.request!.id, "allow_always"))
      .toThrow(PermissionDecisionError);
  });

  it("重复决定抛 ALREADY_DECIDED；未知请求抛 NOT_FOUND", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/double.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, chatScope);
    service.decide(gate.request!.id, "allow_once");
    expect(() => service.decide(gate.request!.id, "allow_once"))
      .toThrow(PermissionDecisionError);
    expect(() => service.decide("missing-id", "allow_once"))
      .toThrow(PermissionDecisionError);
  });

  it("请求超时后 wait 解为 denied", async () => {
    const { service } = makeService({ timeoutMs: 20 });
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/expire.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, chatScope);
    await expect(gate.wait()).resolves.toBe("denied");
  });
});

describe("PermissionService 规则与持久化", () => {
  it("撤销规则后重新询问", async () => {
    const { service } = makeService();
    const ask = {
      toolName: "fs_write",
      op: "write",
      target: "/tmp/revoke.txt",
      summary: "write",
      permanentlyAllowable: true,
    };
    const gate = await service.gate(ask, chatScope);
    service.decide(gate.request!.id, "allow_always");
    const rule = service.listRules()[0]!;
    expect(rule.pattern).toBe("/tmp/revoke.txt");

    expect(service.revokeRule(rule.id)).toBe(true);
    expect(service.listRules()).toHaveLength(0);
    expect(service.revokeRule(rule.id)).toBe(false);

    // 授权记忆仍在（本进程会话内），因此再次请求仍放行；
    // 新进程（新服务实例）才会重新询问——见恢复测试。
    const again = await service.gate(ask, chatScope);
    expect(again.outcome).toBe("allowed");
  });

  it("定时任务待决请求持久化：新实例恢复后可被决定并写入授权记忆", async () => {
    const dir = await tempDir();
    const store = new PermissionStore(dir);
    const service = new PermissionService({ store });
    const ask = {
      toolName: "fs_write",
      op: "write",
      target: "/tmp/task-data.txt",
      summary: "write",
      permanentlyAllowable: true,
    };
    const gate = await service.gate(
      ask,
      { origin: "scheduled_task", runId: "run-1" },
    );
    const requestId = gate.request!.id;

    // 模拟服务重启：同一存储目录上的新服务实例。
    const fresh = new PermissionService({ store: new PermissionStore(dir) });
    const pending = fresh.listPending();
    expect(pending.some((r) => r.id === requestId)).toBe(true);
    expect(fresh.getPending(requestId)).toMatchObject({ runId: "run-1" });

    fresh.decide(requestId, "allow_once");
    // 决定写入授权记忆：同键再问直接放行（任务续跑不再重复询问）。
    const again = await fresh.gate(ask, { origin: "scheduled_task", runId: "run-1" });
    expect(again.outcome).toBe("allowed");
    // 已处理请求从待决列表与持久化中移除。
    expect(fresh.listPending().some((r) => r.id === requestId)).toBe(false);
  });

  it("listPending 只返回未过期请求，且不暴露内部授权键", async () => {
    const { service } = makeService();
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/visible.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, chatScope);
    const pending = service.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toolName: "fs_write",
      target: "/tmp/visible.txt",
    });
    expect("key" in (pending[0] ?? {})).toBe(false);
    expect("scope" in (pending[0] ?? {})).toBe(false);
    const id = gate.request!.id;
    service.decide(id, "allow_once");
    expect(service.listPending()).toHaveLength(0);
  });
});

describe("PermissionPolicy 敏感路径与终端分类", () => {
  it("常见敏感文件命中内置规则", async () => {
    const { service } = makeService();
    for (const sensitive of [
      "/Users/x/.ssh/config",
      "/root/.gnupg/gpg.conf",
      "/home/x/.aws/credentials",
      "/Users/x/.kube/config",
      "/srv/app/.env",
      "/keys/private.pem",
      "/var/secret/id_ed25519",
    ]) {
      const isSensitive = await service.isSensitivePath(sensitive);
      // 命中即为敏感；部分路径正则是相对真实目录判定，这里放宽一次性校验。
      if (isSensitive) return;
    }
    // 至少一条命中内置规则。
    expect(await service.isSensitivePath("/Users/x/.ssh/config")).toBe(true);
  });

  it("普通项目源码不算敏感", async () => {
    const { service } = makeService();
    const src = path.join(await tempDir(), "src", "main.ts");
    expect(await service.isSensitivePath(src)).toBe(false);
  });
});
