import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionStore,
  deriveSessionTitle,
} from "../src/sessions/session-store.js";

describe("SessionStore", () => {
  let root = "";
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "panpilot-sessions-"));
    store = new SessionStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates, saves and reads a session back", async () => {
    const session = store.newSession();
    session.messages = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "嗨" },
    ];
    await store.save(session);

    const read = await store.read(session.id);
    expect(read).toEqual(session);
    expect(read?.messages).toHaveLength(2);
  });

  it("lists summaries sorted by updatedAt desc with message counts", async () => {
    const first = store.newSession();
    first.title = "第一个";
    first.messages = [{ role: "user", content: "一" }];
    await store.save(first);

    const second = store.newSession();
    second.title = "第二个";
    second.messages = [{ role: "user", content: "二" }];
    await store.save(second);

    // 把 first 的更新时间提到最新，验证排序。
    first.updatedAt = new Date(Date.now() + 1_000).toISOString();
    await store.save(first);

    const list = await store.list();
    expect(list.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(list[0]).toMatchObject({ title: "第一个", messageCount: 1 });
  });

  it("reads undefined for missing or unsafe ids", async () => {
    await expect(store.read("does-not-exist")).resolves.toBeUndefined();
    await expect(store.read("../secret")).resolves.toBeUndefined();
    await expect(store.read("a/b")).resolves.toBeUndefined();
  });

  it("skips corrupted session files in read and list", async () => {
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await writeFile(
      path.join(root, "sessions", "corrupt.json"),
      "{ 不是合法 JSON",
      "utf8",
    );
    await expect(store.read("corrupt")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("deletes existing sessions and reports missing ones", async () => {
    const session = store.newSession();
    await store.save(session);

    await expect(store.delete(session.id)).resolves.toBe(true);
    await expect(store.read(session.id)).resolves.toBeUndefined();
    await expect(store.delete(session.id)).resolves.toBe(false);
    await expect(store.delete("bad_id")).resolves.toBe(false);
    await expect(store.delete("../secret")).resolves.toBe(false);
  });

  it("rejects invalid session payloads on save", async () => {
    const session = store.newSession();
    session.messages = [{ role: "system", content: "" }];
    await expect(store.save(session)).rejects.toThrow("会话数据校验失败");
  });
});

describe("deriveSessionTitle", () => {
  it("uses the first user message, collapsed and truncated", () => {
    expect(
      deriveSessionTitle([{ role: "user", content: "  帮我  看看  " }]),
    ).toBe("帮我 看看");

    const long = "x".repeat(60);
    expect(
      deriveSessionTitle([{ role: "user", content: long }]),
    ).toBe(`${"x".repeat(40)}…`);
  });

  it("falls back to 新会话 without user messages", () => {
    expect(deriveSessionTitle([])).toBe("新会话");
    expect(deriveSessionTitle([{ role: "assistant", content: "hi" }]))
      .toBe("新会话");
  });
});
