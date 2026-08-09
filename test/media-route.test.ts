import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";
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

  it("rejects wrong extensions and non-media content", async () => {
    const app = buildWithToken();

    const wrongExtension = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "note.txt", "text/plain", Buffer.from("hi"), BOUNDARY),
    });
    expect(wrongExtension.statusCode).toBe(415);
    expect(wrongExtension.json()).toMatchObject({ error: "UNSUPPORTED_MEDIA_TYPE" });

    const fakeContent = await app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "fake.png", "image/png", Buffer.from("not an image"), BOUNDARY),
    });
    expect(fakeContent.statusCode).toBe(415);
    expect(fakeContent.json()).toMatchObject({ error: "INVALID_MEDIA" });
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
