import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

const AUTH = { authorization: "Bearer test-secret" };

/*
 * /v1/sessions 路由测试：完整 HTTP 生命周期（列表 → 新建 → 保存 →
 * 读取 → 删除），鉴权、参数校验与 404 语义。
 */
describe("session routes", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  let sessionsDir = "";

  beforeEach(async () => {
    sessionsDir = await mkdtemp(path.join(tmpdir(), "panpilot-session-route-"));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("lists no sessions initially and creates an empty one", async () => {
    const app = build();

    const list = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: AUTH,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ sessions: [] });

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: AUTH,
    });
    expect(created.statusCode).toBe(201);
    const session = created.json().session as {
      id: string;
      title: string;
      messages: unknown[];
    };
    expect(session).toMatchObject({ title: "新会话", messages: [] });
    expect(session.id).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it("saves messages with an auto-derived title and reads them back", async () => {
    const app = build();
    const created = await createSession(app);

    const put = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${created.id}`,
      headers: AUTH,
      payload: {
        messages: [
          { role: "user", content: "帮我总结这份文档" },
          { role: "assistant", content: "好的，已经总结。" },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().session).toMatchObject({
      id: created.id,
      title: "帮我总结这份文档",
      messages: [
        { role: "user", content: "帮我总结这份文档" },
        { role: "assistant", content: "好的，已经总结。" },
      ],
    });

    const got = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.id}`,
      headers: AUTH,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().session.messages).toHaveLength(2);

    const list = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: AUTH,
    });
    expect(list.json().sessions[0]).toMatchObject({
      id: created.id,
      title: "帮我总结这份文档",
      messageCount: 2,
    });
  });

  it("creates a missing session on PUT upsert and keeps explicit titles", async () => {
    const app = build();

    const upsert = await app.inject({
      method: "PUT",
      url: "/v1/sessions/upsert-test",
      headers: AUTH,
      payload: {
        title: "我的工作会话",
        messages: [{ role: "user", content: "开始" }],
      },
    });
    expect(upsert.statusCode).toBe(200);
    expect(upsert.json().session).toMatchObject({
      id: "upsert-test",
      title: "我的工作会话",
    });

    const update = await app.inject({
      method: "PUT",
      url: "/v1/sessions/upsert-test",
      headers: AUTH,
      payload: { messages: [{ role: "user", content: "继续" }] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().session).toMatchObject({
      id: "upsert-test",
      title: "我的工作会话",
      messages: [{ role: "user", content: "继续" }],
    });
  });

  it("deletes a session and returns 404 afterwards", async () => {
    const app = build();
    const created = await createSession(app);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created.id}`,
      headers: AUTH,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, sessionId: created.id });

    const again = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created.id}`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: "SESSION_NOT_FOUND" });
  });

  it("rejects invalid ids, payloads and missing sessions", async () => {
    const app = build();

    const badId = await app.inject({
      method: "GET",
      url: "/v1/sessions/bad_id",
      headers: AUTH,
    });
    expect(badId.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/sessions/does-not-exist",
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);

    const badPayload = await app.inject({
      method: "PUT",
      url: "/v1/sessions/upsert-test",
      headers: AUTH,
      payload: { messages: [{ role: "user", content: "" }] },
    });
    expect(badPayload.statusCode).toBe(400);

    const emptyBody = await app.inject({
      method: "PUT",
      url: "/v1/sessions/upsert-test",
      headers: AUTH,
      payload: {},
    });
    expect(emptyBody.statusCode).toBe(400);
  });

  it("protects all session routes with the API token", async () => {
    const app = build();

    for (const [method, url] of [
      ["GET", "/v1/sessions"],
      ["POST", "/v1/sessions"],
      ["GET", "/v1/sessions/some-id"],
      ["PUT", "/v1/sessions/some-id"],
      ["DELETE", "/v1/sessions/some-id"],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
  });

  async function createSession(app: ReturnType<typeof buildApp>): Promise<{
    id: string;
  }> {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: AUTH,
    });
    expect(created.statusCode).toBe(201);
    return created.json().session;
  }

  function build() {
    const app = buildApp({
      apiToken: "test-secret",
      sessionsDir,
      modelClient: fakeModelClient(),
    });
    apps.push(app);
    return app;
  }
});

function fakeModelClient(): ModelClient {
  return {
    complete: vi.fn(),
    completeStream: vi.fn(),
  };
}
