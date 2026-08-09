import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";
import { mp3Bytes, pngBytes } from "./helpers/media-fixture.js";
import { multipartBody } from "./helpers/docx-fixture.js";

const BOUNDARY = "----panpilot-chat-media-test";
const AUTH = { authorization: "Bearer test-secret" };

/*
 * /v1/chat attachments 测试：上传受控媒体后通过 attachments 触发
 * analyze_image / analyze_audio / transcribe_audio，且原始媒体不回传 HTTP。
 */
describe("chat attachments", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  let mediaDir = "";

  beforeEach(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "panpilot-chat-media-"));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(mediaDir, { recursive: true, force: true });
  });

  it("injects a mandatory analyze_image hint for an image attachment", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "我会调用工具分析图片",
      toolCalls: [],
      model: "test-model",
    });
    const app = buildWithFakeModel(complete);
    const mediaId = await uploadMedia(app, pngBytes(), "a.png");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: {
        message: "看看这张图",
        attachments: [{ mediaId, kind: "image" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      message: "我会调用工具分析图片",
      execution: { mode: "chat", toolExecutions: [] },
    });
    // 提示消息只含 mediaId，不含媒体字节或 Base64，也不回传 HTTP 响应。
    const hint = complete.mock.calls[0]![0].messages.at(-1)?.content ?? "";
    expect(hint).toContain(`mediaId: ${mediaId}`);
    expect(hint).toContain("必须先调用 analyze_image");
    // 不允许弱措辞「需要时调用」。
    expect(hint).not.toContain("需要时调用");
    expect(JSON.stringify(response.json())).not.toContain(mediaId);
  });

  it("injects a mandatory hint mentioning both audio tools", async () => {
    const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "明白了",
      toolCalls: [],
      model: "test-model",
    });
    const app = buildWithFakeModel(complete);
    const mediaId = await uploadMedia(app, mp3Bytes(), "a.mp3");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: {
        messages: [{ role: "user", content: "听一下" }],
        attachments: [{ mediaId }],
      },
    });

    expect(response.statusCode).toBe(200);
    const hint = complete.mock.calls[0]![0].messages.at(-1)?.content ?? "";
    expect(hint).toContain("必须先调用");
    expect(hint).toContain("transcribe_audio");
    expect(hint).toContain("analyze_audio");
    expect(hint).not.toContain("需要时调用");
  });

  it("rejects unknown media ids before calling the model", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    const app = buildWithFakeModel(complete);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: {
        message: "看附件",
        attachments: [{ mediaId: "does-not-exist" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "INVALID_REQUEST",
      details: [{ mediaId: "does-not-exist", reason: "媒体不存在" }],
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects attachments whose kind does not match the stored media", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    const app = buildWithFakeModel(complete);
    const mediaId = await uploadMedia(app, pngBytes(), "a.png");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: {
        message: "看附件",
        attachments: [{ mediaId, kind: "audio" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      details: [{ mediaId, reason: "kind 与媒体实际类型（image）不符" }],
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects unsafe media ids in attachments", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    const app = buildWithFakeModel(complete);

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: {
        message: "看附件",
        attachments: [{ mediaId: "../secret" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("injects attachment hints into the streaming path too", async () => {
    const completeStream = vi.fn<ModelClient["completeStream"]>()
      .mockImplementation(async function* () {
        yield { type: "content", content: "好的" };
        yield {
          type: "completion",
          completion: {
            content: "好的",
            toolCalls: [],
            model: "test-model",
          },
        };
      });
    const app = buildApp({
      apiToken: "test-secret",
      mediaDir,
      modelClient: { complete: vi.fn(), completeStream },
    });
    apps.push(app);
    const mediaId = await uploadMedia(app, pngBytes(), "a.png");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: {
        message: "看附件",
        attachments: [{ mediaId }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const messages = completeStream.mock.calls[0]![0].messages;
    expect(messages.at(-1)?.content).toContain(`mediaId: ${mediaId}`);
    expect(messages.at(-1)?.content).toContain("必须先调用");
  });

  async function uploadMedia(
    app: ReturnType<typeof buildApp>,
    payload: Buffer,
    filename: string,
  ): Promise<string> {
    const upload = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", filename, "application/octet-stream", payload, BOUNDARY),
    });
    expect(upload.statusCode).toBe(201);
    return (upload.json() as { mediaId: string }).mediaId;
  }

  function buildWithFakeModel(complete: ModelClient["complete"]) {
    const app = buildApp({
      apiToken: "test-secret",
      mediaDir,
      modelClient: { complete, completeStream: vi.fn() },
    });
    apps.push(app);
    return app;
  }
});
