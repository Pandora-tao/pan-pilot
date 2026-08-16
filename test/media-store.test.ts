import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { createDocxFixture } from "./helpers/docx-fixture.js";
import { createPptxFixture } from "./helpers/pptx-fixture.js";

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

  it("rejects empty content", async () => {
    await expect(store.save(Buffer.alloc(0), "a.png"))
      .rejects.toMatchObject({ code: "INVALID_MEDIA" });
  });

  it("accepts text files as text kind by UTF-8 content", async () => {
    const cases: Array<[string, string, string]> = [
      ["notes.txt", "text/plain", "txt"],
      ["data.json", "application/json", "json"],
      ["README.md", "text/markdown", "md"],
      ["Makefile", "text/plain", "txt"],
    ];
    for (const [name, mimeType, extension] of cases) {
      const saved = await store.save(Buffer.from("你好 world\n第二行"), name);
      expect(saved).toMatchObject({ kind: "text", mimeType, extension });
      const media = await store.read(saved.mediaId);
      expect(media?.meta).toMatchObject({ kind: "text", mimeType, extension });
    }
  });

  it("stores non-UTF8 or non-text-extension content as binary", async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
    const saved = await store.save(binary, "data.bin");
    expect(saved).toMatchObject({
      kind: "binary",
      mimeType: "application/octet-stream",
      extension: "bin",
    });
    await expect(store.read(saved.mediaId)).resolves.toBeDefined();

    // 内容是合法 UTF-8，但扩展名不在文本白名单 → binary。
    const pngNamed = await store.save(Buffer.from("hello world"), "a.png");
    expect(pngNamed).toMatchObject({
      kind: "binary",
      mimeType: "application/octet-stream",
      extension: "png",
    });
    const media = await store.read(pngNamed.mediaId);
    expect(media?.meta).toMatchObject({ kind: "binary" });
  });

  it("accepts pdf, docx and pptx as document kind", async () => {
    const pdf = await store.save(Buffer.from("%PDF-1.4\n% minimal"), "report.pdf");
    expect(pdf).toMatchObject({
      kind: "document",
      mimeType: "application/pdf",
      extension: "pdf",
    });
    await expect(store.read(pdf.mediaId)).resolves.toBeDefined();

    const docx = await store.save(
      await createDocxFixture(["段落一", "段落二"]),
      "doc.docx",
    );
    expect(docx).toMatchObject({
      kind: "document",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: "docx",
    });
    await expect(store.read(docx.mediaId)).resolves.toBeDefined();

    const pptx = await store.save(
      await createPptxFixture("演示文稿"),
      "slides.pptx",
    );
    expect(pptx).toMatchObject({
      kind: "document",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: "pptx",
    });
    await expect(store.read(pptx.mediaId)).resolves.toBeDefined();
  });

  it("rejects a zip container that only pretends to be docx", async () => {
    // PK\x03\x04 魔数但不是合法 docx 包结构。
    const fake = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("not a docx package", "utf8"),
    ]);
    await expect(store.save(fake, "fake.docx"))
      .rejects.toMatchObject({ code: "INVALID_MEDIA" });
  });

  it("rejects OOXML content with the wrong Office extension", async () => {
    await expect(store.save(await createDocxFixture(["x"]), "wrong.pptx"))
      .rejects.toMatchObject({ code: "INVALID_MEDIA" });
    await expect(store.save(await createPptxFixture("x"), "wrong.docx"))
      .rejects.toMatchObject({ code: "INVALID_MEDIA" });
  });

  it("rejects magic-format content with a mismatched extension", async () => {
    await expect(store.save(Buffer.from("%PDF-1.4\n% x"), "a.txt"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
    await expect(store.save(await createDocxFixture(["x"]), "a.zip"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_EXTENSION" });
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
    return path.join(root, "media", `${mediaId}.meta.json`);
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
        path.join(root, "media", `${saved.mediaId}.meta.json`),
        JSON.stringify({ ...metaOf(saved), extension: "png/../conf" }),
        "utf8",
      );
      await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MediaStore delete lifecycle", () => {
  let root = "";
  let store: MediaStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "panpilot-media-delete-"));
    store = new MediaStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deletes the media file and sidecar, then reports not found", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    const mediaPath = path.join(root, "media", `${saved.mediaId}.png`);
    const sidecar = path.join(root, "media", `${saved.mediaId}.meta.json`);
    expect(await store.read(saved.mediaId)).toBeDefined();

    await expect(store.delete(saved.mediaId)).resolves.toBe(true);

    await expect(readFile(mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.read(saved.mediaId)).resolves.toBeUndefined();
    await expect(store.delete(saved.mediaId)).resolves.toBe(false);
  });

  it("returns false for nonexistent and unsafe media ids", async () => {
    await expect(store.delete("does-not-exist")).resolves.toBe(false);
    await expect(store.delete("../secret")).resolves.toBe(false);
    await expect(store.delete("a/b")).resolves.toBe(false);
    await expect(store.delete("..%2Fsecret")).resolves.toBe(false);
    await expect(store.delete("")).resolves.toBe(false);
  });

  it("cleans up a partial state where the sidecar is missing", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    const mediaPath = path.join(root, "media", `${saved.mediaId}.png`);
    await rm(
      path.join(root, "media", `${saved.mediaId}.meta.json`),
      { force: true },
    );

    await expect(store.delete(saved.mediaId)).resolves.toBe(true);

    await expect(readFile(mediaPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up a partial state where the media file is missing", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    const sidecar = path.join(root, "media", `${saved.mediaId}.meta.json`);
    await rm(path.join(root, "media", `${saved.mediaId}.png`), { force: true });

    await expect(store.delete(saved.mediaId)).resolves.toBe(true);

    await expect(readFile(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a tampered sidecar and whitelisted media files", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    // 边车损坏（read 视为不存在）时，delete 仍应尽力清理所有痕迹。
    await writeFile(
      path.join(root, "media", `${saved.mediaId}.meta.json`),
      "{ 不是 JSON",
      "utf8",
    );

    await expect(store.delete(saved.mediaId)).resolves.toBe(true);

    const entries = await readdir(path.join(root, "media"));
    expect(entries.filter((entry) => entry.startsWith(saved.mediaId))).toEqual([]);
  });

  it("fails loudly when the underlying delete throws and never reports success", async () => {
    const saved = await store.save(pngBytes(), "a.png");
    const failing = new MediaStore(root, {
      deleteFileImpl: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    await expect(failing.delete(saved.mediaId)).rejects.toMatchObject({
      code: "MEDIA_DELETE_FAILED",
    });

    // 文件仍在：绝不能把真实删除失败当作成功。
    await expect(store.read(saved.mediaId)).resolves.toBeDefined();
  });

  it("treats a missing media directory as idempotent not-found", async () => {
    const missing = new MediaStore(root, {
      readDirImpl: async () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
    });

    await expect(missing.delete("some-media")).resolves.toBe(false);
  });

  it("fails loudly when listing the media directory fails", async () => {
    const failing = new MediaStore(root, {
      readDirImpl: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    await expect(failing.delete("some-media")).rejects.toMatchObject({
      code: "MEDIA_DELETE_FAILED",
    });
  });
});
