import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/plugins/canonical-json.js";
import {
  hashAction,
  InMemoryApprovalStore,
  newApprovalId,
  type ApprovalRecord,
} from "../src/plugins/approval-store.js";
import type { PluginManifest } from "../src/plugins/manifest-schema.js";

function sampleManifest(): PluginManifest {
  return {
    apiVersion: "v1",
    name: "weather",
    description: "查询天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    executor: {
      type: "http",
      method: "GET",
      url: "https://api.example.com/weather?city=${city}",
    },
  };
}

function sampleRecord(): ApprovalRecord {
  const action = {
    type: "create_plugin" as const,
    manifest: sampleManifest(),
    dirSnapshotHash: "snap",
  };
  return {
    id: newApprovalId(),
    action,
    actionHash: hashAction(action),
    status: "pending",
    createdAt: 1000,
    expiresAt: 1000 + 60_000,
    preview: { summary: "创建插件 weather", changes: [], riskSummary: "无" },
  };
}

describe("InMemoryApprovalStore", () => {
  it("creates, reads and lists records", () => {
    const store = new InMemoryApprovalStore();
    const record = sampleRecord();

    store.create(record);

    // 存储返回深拷贝：按内容相等断言，而不是同一引用。
    expect(store.get(record.id)).toEqual(record);
    expect(store.list().map((item) => item.id)).toEqual([record.id]);
    expect(store.get("missing")).toBeUndefined();
  });

  it("updates status atomically and preserves lastError", () => {
    const store = new InMemoryApprovalStore();
    const record = sampleRecord();
    store.create(record);

    const updated = store.updateStatus(record.id, "approved");
    expect(updated?.status).toBe("approved");
    expect(store.get(record.id)?.status).toBe("approved");

    store.updateStatus(record.id, "executed", "重载失败");
    expect(store.get(record.id)).toMatchObject({
      status: "executed",
      lastError: "重载失败",
    });

    store.updateStatus(record.id, "approved");
    expect(store.get(record.id)?.lastError).toBeUndefined();
    expect(store.updateStatus("missing", "approved")).toBeUndefined();
  });

  it("loses all records when the process restarts (in-memory boundary)", () => {
    const first = new InMemoryApprovalStore();
    const record = sampleRecord();
    first.create(record);

    // 新实例等价于重启后的进程：审批全部失效，需要重新创建草案。
    const restarted = new InMemoryApprovalStore();
    expect(restarted.get(record.id)).toBeUndefined();
    expect(restarted.list()).toEqual([]);
  });

  it("returns deep copies: mutating a returned record cannot change stored state", () => {
    const store = new InMemoryApprovalStore();
    const record = sampleRecord();
    store.create(record);

    const leaked = store.get(record.id)!;
    (leaked.action as { manifest: { name: string } }).manifest.name = "tampered";
    leaked.preview.summary = "tampered preview";

    const again = store.get(record.id)!;
    expect((again.action as { manifest: { name: string } }).manifest.name)
      .toBe("weather");
    expect(again.preview.summary).toBe("创建插件 weather");

    // list() 也是副本。
    const listed = store.list()[0]!;
    (listed.action as { manifest: { name: string } }).manifest.name = "listed-tampered";
    expect((store.get(record.id)!.action as { manifest: { name: string } }).manifest.name)
      .toBe("weather");

    // create() 的返回值同样是副本，篡改它不影响内部记录。
    const created = store.create(sampleRecord());
    (created.action as { manifest: { name: string } }).manifest.name = "created-tampered";
    expect((store.get(created.id)!.action as { manifest: { name: string } }).manifest.name)
      .toBe("weather");
  });

  it("updateStatus returns a copy while applying state to the internal record", () => {
    const store = new InMemoryApprovalStore();
    const record = sampleRecord();
    store.create(record);

    const updated = store.updateStatus(record.id, "approved")!;
    updated.status = "executed";
    updated.preview.summary = "tampered";

    expect(store.get(record.id)?.status).toBe("approved");
    expect(store.get(record.id)?.preview.summary).toBe("创建插件 weather");
  });
});

describe("approval hashing", () => {
  it("canonicalizes objects so key order does not change the hash", () => {
    const a = { b: 1, a: [1, { d: 2, c: 3 }] };
    const b = { a: [1, { c: 3, d: 2 }], b: 1 };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const action = { type: "reload_plugins", dirSnapshotHash: "abc" } as const;
    expect(hashAction(action)).toMatch(/^[0-9a-f]{64}$/);
  });
});
