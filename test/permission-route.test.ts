import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionService } from "../src/permissions/permission-service.js";
import { PermissionStore } from "../src/permissions/permission-store.js";
import { registerPermissionRoute } from "../src/routes/permission-route.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pan-pilot-perm-route-"));
  tempDirs.push(dir);
  return dir;
}

async function makeApp() {
  const dir = await tempDir();
  const service = new PermissionService({ store: new PermissionStore(dir) });
  const app = Fastify();
  registerPermissionRoute(app, service);
  return { app, service, dir };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("POST /v1/permission/requests/:id/decision", () => {
  it("allow_once / allow_always / reject 均生效", async () => {
    const { app, service } = await makeApp();
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/a.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, { origin: "chat", callId: "c1" });
    const id = gate.request!.id;

    const res = await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id}/decision`,
      payload: { action: "allow_once" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request).toMatchObject({ id, status: "allowed_once" });
    await expect(gate.wait()).resolves.toBe("allowed");

    // allow_always 落规则
    const gate2 = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/always.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, { origin: "scheduled_task", runId: "run-9" });
    const id2 = gate2.request!.id;
    await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id2}/decision`,
      payload: { action: "allow_always" },
    });
    expect(service.listRules()).toHaveLength(1);
    expect(service.listRules()[0]!.pattern).toBe("/tmp/always.txt");

    // reject
    const gate3 = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/deny.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, { origin: "chat", callId: "c3" });
    const id3 = gate3.request!.id;
    await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id3}/decision`,
      payload: { action: "reject" },
    });
    await expect(gate3.wait()).resolves.toBe("denied");
  });

  it("非法 action → 400；重复决定 → 409；未知请求 → 404", async () => {
    const { app, service } = await makeApp();
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/x.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, { origin: "chat", callId: "c1" });
    const id = gate.request!.id;

    expect((await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id}/decision`,
      payload: { action: "destroy" },
    })).statusCode).toBe(400);

    expect((await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id}/decision`,
      payload: { action: "allow_once" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id}/decision`,
      payload: { action: "allow_once" },
    })).statusCode).toBe(409);

    expect((await app.inject({
      method: "POST",
      url: "/v1/permission/requests/does-not-exist/decision",
      payload: { action: "allow_once" },
    })).statusCode).toBe(404);
  });

  it("对不可永久放行的请求提交 allow_always → 409", async () => {
    const { app, service } = await makeApp();
    const gate = await service.gate({
      toolName: "fs_delete",
      op: "delete",
      target: "/tmp/del.txt",
      summary: "delete",
      permanentlyAllowable: false,
    }, { origin: "chat", callId: "c1" });
    const id = gate.request!.id;
    const res = await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id}/decision`,
      payload: { action: "allow_always" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_ALLOWED");
  });
});

describe("GET /v1/permission/requests", () => {
  it("列出待决请求（不含内部授权键），已决定后不再出现", async () => {
    const { app, service } = await makeApp();
    await service.gate({
      toolName: "fs_read",
      op: "read",
      target: "/Users/x/.ssh/id_ed25519",
      summary: "read sensitive",
      permanentlyAllowable: false,
    }, { origin: "chat", callId: "c1" });

    const res = await app.inject({ method: "GET", url: "/v1/permission/requests" });
    expect(res.statusCode).toBe(200);
    const requests = res.json().requests as Array<Record<string, unknown>>;
    expect(requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ op: "read", origin: "chat", callId: "c1" });
    expect("key" in (requests[0] ?? {})).toBe(false);
  });
});

describe("永久规则接口", () => {
  it("GET 列表与 DELETE 撤销", async () => {
    const { app, service } = await makeApp();
    const gate = await service.gate({
      toolName: "fs_write",
      op: "write",
      target: "/tmp/r.txt",
      summary: "write",
      permanentlyAllowable: true,
    }, { origin: "chat", callId: "c1" });
    const id = gate.request!.id;
    await app.inject({
      method: "POST",
      url: `/v1/permission/requests/${id}/decision`,
      payload: { action: "allow_always" },
    });

    const list = await app.inject({ method: "GET", url: "/v1/permission/rules" });
    expect(list.statusCode).toBe(200);
    const rules = list.json().rules as Array<{ id: string; kind: string; pattern: string }>;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: "file", pattern: "/tmp/r.txt" });

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/permission/rules/${rules[0]!.id}`,
    });
    expect(del.statusCode).toBe(204);
    expect(service.listRules()).toHaveLength(0);

    const again = await app.inject({
      method: "DELETE",
      url: `/v1/permission/rules/${rules[0]!.id}`,
    });
    expect(again.statusCode).toBe(404);
  });
});
