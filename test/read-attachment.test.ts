import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaStore } from "../src/media/media-store.js";
import { createReadAttachmentTool } from "../src/tools/read-attachment.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { createDocxFixture } from "./helpers/docx-fixture.js";
import { mp3Bytes, pngBytes } from "./helpers/media-fixture.js";

/*
 * read_attachment 工具测试：text 解码与截断、Office 文档隔离、
 * binary 只回元信息、image/audio 拒绝、非法 mediaId 拒绝。
 */
describe("read_attachment tool", () => {
  let root = "";
  let store: MediaStore;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "panpilot-read-attachment-"));
    store = new MediaStore(root);
    registry = new ToolRegistry([createReadAttachmentTool(store)]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns decoded text for a text attachment", async () => {
    const { mediaId } = await store.save(Buffer.from("第一行\n第二行"), "notes.txt");
    const result = await registry.execute("read_attachment", { mediaId });
    expect(result).toMatchObject({
      mediaId,
      name: "notes.txt",
      kind: "text",
      textAvailable: true,
      text: "第一行\n第二行",
      truncated: false,
    });
  });

  it("truncates long text to the model budget", async () => {
    const { mediaId } = await store.save(Buffer.from("x".repeat(40_000)), "long.txt");
    const result = await registry.execute("read_attachment", { mediaId }) as {
      text: string;
      truncated: boolean;
    };
    expect(result.text.length).toBe(30_000);
    expect(result.truncated).toBe(true);
  });

  it("rejects DOCX and PDF parsing with Office MCP guidance", async () => {
    const docx = await store.save(await createDocxFixture(["段落甲"]), "doc.docx");
    const pdf = await store.save(createPdfFixture("Hello PDF World"), "report.pdf");

    await expect(registry.execute("read_attachment", { mediaId: docx.mediaId }))
      .rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    await expect(registry.execute("read_attachment", { mediaId: pdf.mediaId }))
      .rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });

  it("returns metadata only for a binary attachment", async () => {
    const { mediaId } = await store.save(
      Buffer.from([0x00, 0xff, 0xfe, 0x80]),
      "data.bin",
    );
    const result = await registry.execute("read_attachment", { mediaId }) as {
      kind: string;
      textAvailable: boolean;
      text: string;
      size: number;
    };
    expect(result).toMatchObject({
      kind: "binary",
      textAvailable: false,
      text: "",
      size: 4,
    });
  });

  it("rejects image and audio attachments with guidance", async () => {
    const image = await store.save(pngBytes(), "a.png");
    await expect(registry.execute("read_attachment", { mediaId: image.mediaId }))
      .rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });

    const audio = await store.save(mp3Bytes(), "a.mp3");
    await expect(registry.execute("read_attachment", { mediaId: audio.mediaId }))
      .rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });

  it("rejects unsafe media ids and missing attachments", async () => {
    await expect(registry.execute("read_attachment", { mediaId: "../secret" }))
      .rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    await expect(registry.execute("read_attachment", { mediaId: "does-not-exist" }))
      .rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });
});

/** 生成带正确 xref 偏移的最小单页 PDF，避免依赖 pdfjs 的容错恢复。 */
function createPdfFixture(text: string): Buffer {
  const stream = `BT /F1 14 Tf 30 200 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300]"
      + " /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
