import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DocStore } from "../src/docs/doc-store.js";
import { extractText } from "../src/docs/word-editor.js";
import { createCreateWordDocumentTool } from "../src/tools/create-word-document.js";
import { createEditWordDocumentTool } from "../src/tools/edit-word-document.js";
import { createReadWordDocumentTool } from "../src/tools/read-word-document.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { createDocxFixture } from "./helpers/docx-fixture.js";

describe("word document tools", () => {
  afterEach(async () => {
    if (storeRoot) {
      await rm(storeRoot, { recursive: true, force: true });
      storeRoot = "";
    }
  });

  it("reads uploaded document text for the model", async () => {
    const store = await createStore();
    const { fileId } = await store.saveUpload(
      await createDocxFixture(["你好", "世界"]),
      "report.docx",
    );

    const tool = createReadWordDocumentTool(store);
    const result = await tool.execute({ fileId });

    expect(result).toMatchObject({
      fileId,
      name: "report.docx",
      paragraphCount: 2,
      text: "你好\n世界",
      truncated: false,
    });
  });

  it("edits into a new file, keeps the original and returns a download url", async () => {
    const store = await createStore();
    const source = await createDocxFixture(["旧价格 100 元"]);
    const { fileId } = await store.saveUpload(source, "价格表.docx");

    const tool = createEditWordDocumentTool(store);
    const result = await tool.execute({
      fileId,
      edits: [{ type: "replace_text", oldText: "100", newText: "200" }],
    });

    expect(result).toMatchObject({
      name: "价格表（已修改）.docx",
      downloadUrl: `/v1/files/${result.fileId}`,
      edits: [{ type: "replace_text", applied: true }],
    });
    expect(result.fileId).not.toBe(fileId);

    const edited = await store.read(result.fileId);
    expect(edited).toBeDefined();
    await expect(extractText(edited!.buffer)).resolves.toEqual({
      paragraphs: ["旧价格 200 元"],
    });
    // 原件保持不变。
    const original = await store.read(fileId);
    expect(original?.buffer.equals(source)).toBe(true);
  });

  it("rejects unknown or unsafe file ids", async () => {
    const store = await createStore();
    const readTool = createReadWordDocumentTool(store);
    const editTool = createEditWordDocumentTool(store);

    await expect(readTool.execute({ fileId: "missing" }))
      .rejects.toThrow("文件 missing 不存在");
    await expect(editTool.execute({
      fileId: "missing",
      edits: [{ type: "replace_text", oldText: "a", newText: "b" }],
    })).rejects.toThrow("文件 missing 不存在");
    // 路径穿越字符直接被 ID 白名单拒绝。
    await expect(store.read("../secret")).resolves.toBeUndefined();
  });

  it("creates a new document with a sanitized filename", async () => {
    const store = await createStore();
    const tool = createCreateWordDocumentTool(store);

    const result = await tool.execute({
      title: "季度/报告：2026",
      blocks: [
        { type: "heading", level: 1, text: "概况" },
        { type: "paragraph", text: "本季度增长 20%。" },
      ],
    });

    expect(result).toMatchObject({
      name: "季度 报告：2026.docx",
      downloadUrl: `/v1/files/${result.fileId}`,
      blocks: 2,
    });
    const file = await store.read(result.fileId);
    expect(file).toBeDefined();
    await expect(extractText(file!.buffer)).resolves.toEqual({
      paragraphs: ["季度/报告：2026", "概况", "本季度增长 20%。"],
    });
  });

  it("rejects create inputs without content blocks", async () => {
    const store = await createStore();
    const registry = new ToolRegistry([createCreateWordDocumentTool(store)]);

    await expect(registry.execute("create_word_document", {
      title: "空文档",
      blocks: [],
    })).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
  });

  it("creates documents with bullet lists and tables", async () => {
    const store = await createStore();
    const tool = createCreateWordDocumentTool(store);

    const result = await tool.execute({
      title: "项目报告",
      blocks: [
        { type: "heading", level: 1, text: "成果" },
        { type: "bullet", text: "完成上线" },
        {
          type: "table",
          headers: ["指标", "数值"],
          rows: [["转化率", "12%"]],
        },
      ],
    });

    const file = await store.read(result.fileId);
    await expect(extractText(file!.buffer)).resolves.toEqual({
      paragraphs: ["项目报告", "成果", "完成上线", "指标", "数值", "转化率", "12%"],
    });
  });

  it("rejects table rows whose column count mismatches headers", async () => {
    const store = await createStore();
    const registry = new ToolRegistry([createCreateWordDocumentTool(store)]);

    await expect(registry.execute("create_word_document", {
      title: "坏表格",
      blocks: [{
        type: "table",
        headers: ["a", "b"],
        rows: [["只有一列"]],
      }],
    })).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
  });
});

let storeRoot = "";

async function createStore(): Promise<DocStore> {
  storeRoot = await mkdtemp(path.join(tmpdir(), "panpilot-docs-"));
  return new DocStore(storeRoot);
}
