import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";
import { MediaStore } from "../src/media/media-store.js";
import { mp3Bytes, pngBytes } from "./helpers/media-fixture.js";
import { multipartBody } from "./helpers/docx-fixture.js";

const BOUNDARY = "----panpilot-media-route-test";
const AUTH = { authorization: "Bearer test-secret" };

/*
 * /v1/media 路由测试：走完整 HTTP 生命周期（multipart 上传 → 下载），
 * 存储目录与大小上限都指向每个用例独立的临时配置。
 */
describe("media routes", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  let mediaDir = "";

  beforeEach(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "panpilot-media-route-"));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(mediaDir, { recursive: true, force: true });
  });

  it("does not expose the removed legacy /v1/files routes", async () => {
    const app = buildWithToken();
    const get = await app.inject({ method: "GET", url: "/v1/files/legacy", headers: AUTH });
    const post = await app.inject({ method: "POST", url: "/v1/files", headers: AUTH });
    expect(get.statusCode).toBe(404);
    expect(post.statusCode).toBe(404);
  });

  it("uploads a PNG and downloads it back with derived metadata", async () => {
    const app = buildWithToken();
    const png = pngBytes();

    const upload = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "截图.png", "image/png", png, BOUNDARY),
    });

    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json() as {
      mediaId: string;
      name: string;
      kind: string;
      mimeType: string;
      size: number;
    };
    expect(uploaded).toMatchObject({
      name: "截图.png",
      kind: "image",
      mimeType: "image/png",
      size: png.length,
    });

    const download = await app.inject({
      method: "GET",
      url: `/v1/media/${uploaded.mediaId}`,
      headers: AUTH,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.rawPayload.equals(png)).toBe(true);
  });

  it("serves HEAD media headers (filename/length) without a body", async () => {
    const app = buildWithToken();
    const png = pngBytes();

    const upload = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "截图.png", "image/png", png, BOUNDARY),
    });
    expect(upload.statusCode).toBe(201);
    const { mediaId } = upload.json() as { mediaId: string };

    const head = await app.inject({
      method: "HEAD",
      url: `/v1/media/${mediaId}`,
      headers: AUTH,
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toBe("image/png");
    expect(head.headers["content-disposition"]).toContain("attachment");
    expect(head.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("截图.png")}`,
    );
    expect(Number(head.headers["content-length"])).toBe(png.length);
  });

  it("uploads an MP3 as audio media", async () => {
    const app = buildWithToken();
    const mp3 = mp3Bytes();

    const upload = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "voice.mp3", "audio/mpeg", mp3, BOUNDARY),
    });

    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      kind: "audio",
      mimeType: "audio/mpeg",
      size: mp3.length,
    });
  });

  it("protects upload and download with the API token", async () => {
    const app = buildWithToken();
    const png = pngBytes();

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody("file", "a.png", "image/png", png, BOUNDARY),
    });
    expect(unauthorized.statusCode).toBe(401);

    const download = await app.inject({
      method: "GET",
      url: "/v1/media/some-id",
    });
    expect(download.statusCode).toBe(401);
  });

  it("accepts arbitrary text and binary attachments", async () => {
    const app = buildWithToken();

    const text = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "note.txt", "text/plain", Buffer.from("hi"), BOUNDARY),
    });
    expect(text.statusCode).toBe(201);
    expect(text.json()).toMatchObject({
      kind: "text",
      mimeType: "text/plain",
      size: 2,
    });

    const binary = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        "file",
        "archive.bin",
        "application/octet-stream",
        Buffer.from([0x00, 0x01, 0xff, 0xfe]),
        BOUNDARY,
      ),
    });
    expect(binary.statusCode).toBe(201);
    expect(binary.json()).toMatchObject({
      kind: "binary",
      mimeType: "application/octet-stream",
    });
  });

  it("rejects empty content and magic-format extension mismatches", async () => {
    const app = buildWithToken();

    const empty = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "empty.txt", "text/plain", Buffer.alloc(0), BOUNDARY),
    });
    expect(empty.statusCode).toBe(415);
    expect(empty.json()).toMatchObject({ error: "INVALID_MEDIA" });

    const fakePng = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        "file",
        "fake.png",
        "image/png",
        Buffer.from("%PDF-1.4\n% not an image"),
        BOUNDARY,
      ),
    });
    expect(fakePng.statusCode).toBe(415);
    expect(fakePng.json()).toMatchObject({ error: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("rejects media over the configured size limit", async () => {
    const app = buildApp({
      apiToken: "test-secret",
      mediaDir,
      mediaMaxBytes: 64,
      modelClient: fakeModelClient(),
    });
    apps.push(app);

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        "file",
        "big.png",
        "image/png",
        Buffer.concat([pngBytes(), Buffer.alloc(128)]),
        BOUNDARY,
      ),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: "MEDIA_TOO_LARGE" });
  });

  it("deletes media and returns only the deletion result", async () => {
    const app = buildWithToken();
    const png = pngBytes();
    const upload = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "删除.png", "image/png", png, BOUNDARY),
    });
    const { mediaId } = upload.json() as { mediaId: string };

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaId}`,
      headers: AUTH,
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, mediaId });
    expect(deleted.rawPayload.toString("utf8")).not.toContain(
      png.toString("base64"),
    );

    const after = await app.inject({
      method: "GET",
      url: `/v1/media/${mediaId}`,
      headers: AUTH,
    });
    expect(after.statusCode).toBe(404);
  });

  it("returns 404 for a missing media id and 400 for an invalid one", async () => {
    const app = buildWithToken();

    const missing = await app.inject({
      method: "DELETE",
      url: "/v1/media/does-not-exist",
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "MEDIA_NOT_FOUND" });

    const invalid = await app.inject({
      method: "DELETE",
      url: "/v1/media/bad_id",
      headers: AUTH,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("protects delete with the API token", async () => {
    const app = buildWithToken();

    const unauthorized = await app.inject({
      method: "DELETE",
      url: "/v1/media/some-id",
    });
    expect(unauthorized.statusCode).toBe(401);
  });

  it("returns a generic 500 without internals when deletion fails", async () => {
    const failingStore = new MediaStore(mediaDir, {
      deleteFileImpl: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const app = buildApp({
      apiToken: "test-secret",
      mediaDir,
      mediaStore: failingStore,
      modelClient: fakeModelClient(),
    });
    apps.push(app);
    const upload = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "a.png", "image/png", pngBytes(), BOUNDARY),
    });
    const { mediaId } = upload.json() as { mediaId: string };

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaId}`,
      headers: AUTH,
    });

    expect(deleted.statusCode).toBe(500);
    expect(deleted.json()).toMatchObject({
      error: "MEDIA_DELETE_FAILED",
      message: "媒体删除失败，请稍后再试",
    });
    // 不泄露路径或底层错误细节。
    const body = JSON.stringify(deleted.json());
    expect(body).not.toContain(mediaDir);
    expect(body).not.toContain("permission denied");
    expect(body).not.toContain("EACCES");
  });

  function buildWithToken() {
    const app = buildApp({
      apiToken: "test-secret",
      mediaDir,
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
