import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaStore } from "../src/media/media-store.js";
import {
  gifBytes,
  jpegBytes,
  mp3Bytes,
  pngBytes,
  wavBytes,
  webpBytes,
} from "./helpers/media-fixture.js";

type SavedMedia = Awaited<ReturnType<MediaStore["save"]>>;

/** 去掉 save 返回值中的 mediaId，得到与边车 JSON 一致的元数据形状。 */
function metaOf(saved: SavedMedia): Record<string, unknown> {
  const { mediaId: _mediaId, ...meta } = saved;
  return { ...meta };
}

/*
 * MediaStore 单元测试：校验魔数/扩展名/大小、mediaId 的路径穿越边界，
 * 以及边车 JSON 被篡改后 read() 必须拒绝（含 extension 穿越路径）。
 * 全部使用临时目录，不接触工作区。
 */
describe("MediaStore", () => {
  let root = "";
  let store: MediaStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "panpilot-media-"));
    store = new MediaStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves and reads back a PNG with metadata derived from magic bytes", async () => {
    const buffer = pngBytes();
    const saved = await store.save(buffer, "截图.png");

    expect(saved).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      extension: "png",
      size: buffer.length,
      name: "截图.png",
    });
    expect(saved.mediaId).toMatch(/^[a-zA-Z0-9-]+$/);

    const media = await store.read(saved.mediaId);
    const { mediaId: _mediaId, ...expectedMeta } = saved;
    expect(media?.meta).toEqual(expectedMeta);
    expect(media?.buffer.equals(buffer)).toBe(true);
  });

  it("accepts jpeg/webp/gif/wav/mp3 by magic", async () => {
    const cases: Array<[Buffer, string, string, string, "image" | "audio"]> = [
      [jpegBytes(), "a.jpg", "image/jpeg", "jpeg", "image"],
      [jpegBytes(), "a.jpeg", "image/jpeg", "jpeg", "image"],
      [webpBytes(), "a.webp", "image/webp", "webp", "image"],
      [gifBytes(), "a.gif", "image/gif", "gif", "image"],
      [wavBytes(), "a.wav", "audio/wav", "wav", "audio"],
      [mp3Bytes(), "a.mp3", "audio/mpeg", "mp3", "audio"],
    ];
    for (const [buffer, name, mimeType, extension, kind] of cases) {
      const saved = await store.save(buffer, name);
      expect(saved).toMatchObject({ kind, mimeType, extension });
    }
  });

  it("rejects content that is not supported media", async () => {
    await expect(store.save(Buffer.from("hello world"), "a.png"))
      .rejects.toMatchObject({ code: "INVALID_MEDIA" });
    await expect(store.save(Buffer.alloc(0), "a.png"))
      .rejects.toMatchObject({ code: "INVALID_MEDIA" });
  });

  it("rejects extension mismatches, missing extensions and unsupported extensions", async () => {
    await expect(store.save(pngBytes(), "a.jpg"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
    await expect(store.save(pngBytes(), "a"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
    await expect(store.save(pngBytes(), "a.svg"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
    await expect(store.save(mp3Bytes(), "a.png"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
  });

  it("normalizes file names to basename", async () => {
    const saved = await store.save(pngBytes(), "../../etc/passwd.png");
    expect(saved.name).toBe("passwd.png");
    expect(await store.read(saved.mediaId)).toBeDefined();
  });

  it("rejects media over the size limit", async () => {
    const tiny = new MediaStore(root, { maxBytes: 8 });
    await expect(tiny.save(pngBytes(), "a.png"))
      .rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });

  it("returns undefined for unknown or unsafe media ids", async () => {
    await expect(store.read("does-not-exist")).resolves.toBeUndefined();
    await expect(store.read("../secret")).resolves.toBeUndefined();
    await expect(store.read("..%2Fsecret")).resolves.toBeUndefined();
    await expect(store.read("a/b")).resolves.toBeUndefined();
  });

  it("rejects a tampered sidecar whose extension escapes the media directory", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    await writeSidecar(saved.mediaId, {
      ...metaOf(saved),
      extension: "../../etc/passwd",
    });

    // 篡改的 extension 不在固定白名单内，read 必须当作不存在，而不是拼接路径。
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
  });

  it("rejects a tampered sidecar with wrong kind, mimeType, size or name", async () => {
    const saved = await store.save(mp3Bytes(), "a.mp3");

    // kind 被翻转成另一个合法枚举值：schema 通过，但魔数二次校验会拒绝。
    await writeSidecar(saved.mediaId, { ...metaOf(saved), kind: "image" });
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();

    // kind 超出枚举：schema 直接拒绝。
    await writeSidecar(saved.mediaId, { ...metaOf(saved), kind: "video" });
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();

    await writeSidecar(saved.mediaId, { ...metaOf(saved), mimeType: "text/html" });
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();

    await writeSidecar(saved.mediaId, { ...metaOf(saved), size: -1 });
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();

    await writeSidecar(saved.mediaId, { ...metaOf(saved), name: "../逃逸.png" });
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
  });

  it("rejects a sidecar whose extension claims png while the bytes are mp3", async () => {
    const saved = await store.save(mp3Bytes(), "a.mp3");
    // 把真实文件字节复制到篡改扩展名对应的文件名下，确保魔数二次校验是拒绝原因。
    const bytes = await readFile(path.join(root, "media", `${saved.mediaId}.mp3`));
    await writeFile(path.join(root, "media", `${saved.mediaId}.png`), bytes);
    await writeSidecar(saved.mediaId, { ...metaOf(saved), extension: "png" });

    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
  });

  it("treats an unreadable or non-JSON sidecar as missing", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    await writeFile(sidecarPath(saved.mediaId), "{ 不是 JSON", "utf8");
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
  });

  function sidecarPath(mediaId: string): string {
    return path.join(root, "media", `${mediaId}.json`);
  }

  async function writeSidecar(
    mediaId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await writeFile(sidecarPath(mediaId), JSON.stringify(meta), "utf8");
  }
});

describe("MediaStore sidecar strictness", () => {
  it("rejects extensions that are whitelist-shaped but not in the whitelist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "panpilot-media-sidecar-"));
    try {
      const store = new MediaStore(root);
      const saved = await store.save(pngBytes(), "a.png");
      await writeFile(
        path.join(root, "media", `${saved.mediaId}.json`),
        JSON.stringify({ ...metaOf(saved), extension: "png/../conf" }),
        "utf8",
      );
      await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
