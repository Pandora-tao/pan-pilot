import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  assertDocxStructure,
  createDocx,
  extractText,
  isDocxMagic,
} from "../src/docs/word-editor.js";
import { createDocxFixture } from "./helpers/docx-fixture.js";

describe("word-editor", () => {
  it("extracts paragraphs and skips empty ones", async () => {
    const buffer = await createDocxFixture(["第一段", "第二段", ""]);

    await expect(extractText(buffer)).resolves.toEqual({
      paragraphs: ["第一段", "第二段"],
    });
  });

  it("replaces text and escapes XML special characters", async () => {
    const buffer = await createDocxFixture(["价格是 100 元", "另一段 A&B"]);

    const edited = await applyEdits(buffer, [{
      type: "replace_text",
      oldText: "100",
      newText: "200<含税>",
    }]);

    expect(edited.results).toEqual([{ type: "replace_text", applied: true }]);
    await expect(extractText(edited.buffer)).resolves.toEqual({
      paragraphs: ["价格是 200<含税> 元", "另一段 A&B"],
    });
  });

  it("reports unmatched replacements as not applied", async () => {
    const buffer = await createDocxFixture(["原文"]);

    const edited = await applyEdits(buffer, [{
      type: "replace_text",
      oldText: "不存在",
      newText: "x",
    }]);

    expect(edited.results[0]).toMatchObject({ applied: false });
    await expect(extractText(edited.buffer)).resolves.toEqual({
      paragraphs: ["原文"],
    });
  });

  it("inserts a paragraph after the anchor paragraph", async () => {
    const buffer = await createDocxFixture(["第一段", "第二段"]);

    const edited = await applyEdits(buffer, [{
      type: "insert_paragraph",
      afterText: "第一段",
      paragraph: "插入的新段落",
    }]);

    expect(edited.results).toEqual([{ type: "insert_paragraph", applied: true }]);
    await expect(extractText(edited.buffer)).resolves.toEqual({
      paragraphs: ["第一段", "插入的新段落", "第二段"],
    });
  });

  it("reports a missing anchor paragraph as not applied", async () => {
    const buffer = await createDocxFixture(["第一段"]);

    const edited = await applyEdits(buffer, [{
      type: "insert_paragraph",
      afterText: "找不到",
      paragraph: "新段落",
    }]);

    expect(edited.results[0]).toMatchObject({ applied: false });
  });

  it("keeps other zip entries untouched", async () => {
    const buffer = await createDocxFixture(["原文"]);

    const edited = await applyEdits(buffer, [{
      type: "replace_text",
      oldText: "原文",
      newText: "新文",
    }]);

    const zip = await JSZip.loadAsync(edited.buffer);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("_rels/.rels")).not.toBeNull();
  });

  it("validates docx magic bytes and package structure", async () => {
    const buffer = await createDocxFixture(["x"]);

    expect(isDocxMagic(buffer)).toBe(true);
    await expect(assertDocxStructure(buffer)).resolves.toBeUndefined();

    expect(isDocxMagic(Buffer.from("not a zip file"))).toBe(false);
    await expect(assertDocxStructure(Buffer.from("garbage"))).rejects.toThrow();
  });

  it("creates a valid docx with title, headings and paragraphs", async () => {
    const buffer = await createDocx({
      title: "报告标题",
      blocks: [
        { type: "heading", level: 1, text: "第一章" },
        { type: "paragraph", text: "正文内容" },
        { type: "heading", level: 2, text: "1.1 小节" },
      ],
    });

    expect(isDocxMagic(buffer)).toBe(true);
    await expect(assertDocxStructure(buffer)).resolves.toBeUndefined();
    await expect(extractText(buffer)).resolves.toEqual({
      paragraphs: ["报告标题", "第一章", "正文内容", "1.1 小节"],
    });
  });

  it("creates a docx that the editor can modify afterwards", async () => {
    const buffer = await createDocx({
      title: "合同",
      blocks: [{ type: "paragraph", text: "价格 100 元" }],
    });

    const edited = await applyEdits(buffer, [{
      type: "replace_text",
      oldText: "100",
      newText: "200",
    }]);

    await expect(extractText(edited.buffer)).resolves.toEqual({
      paragraphs: ["合同", "价格 200 元"],
    });
  });

  it("creates a styled package with bullet lists and tables", async () => {
    const buffer = await createDocx({
      title: "报告",
      blocks: [
        { type: "bullet", text: "第一项" },
        { type: "bullet", text: "第二项" },
        {
          type: "table",
          headers: ["姓名", "年龄"],
          rows: [["张三", "30"], ["李四", "25"]],
        },
      ],
    });

    // 完整样式包：styles.xml 存在，表格/列表文本按单元格顺序可提取。
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/styles.xml")).not.toBeNull();
    expect(zip.file("word/numbering.xml")).not.toBeNull();
    await expect(extractText(buffer)).resolves.toEqual({
      paragraphs: [
        "报告",
        "第一项",
        "第二项",
        "姓名",
        "年龄",
        "张三",
        "30",
        "李四",
        "25",
      ],
    });
  });

  it("defines page margins and heading styles in the package", async () => {
    const buffer = await createDocx({
      title: "标题",
      blocks: [{ type: "heading", level: 1, text: "第一章" }],
    });

    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain('w:pgMar w:top="1440"');
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    expect(stylesXml).toContain('w:styleId="Heading1"');
    expect(stylesXml).toContain('w:val="1F4E79"');
  });
});
