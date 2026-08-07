import {
  AlignmentType,
  BorderStyle,
  Document,
  LineRuleType,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import JSZip from "jszip";

const DOCUMENT_XML_PATH = "word/document.xml";

export interface ExtractedDocument {
  /** 按段落拆分并去除空段的正文文本。 */
  paragraphs: readonly string[];
}

export type WordEdit =
  | { type: "replace_text"; oldText: string; newText: string }
  | { type: "insert_paragraph"; afterText: string; paragraph: string };

export interface WordEditResult {
  type: WordEdit["type"];
  applied: boolean;
  reason?: string;
}

export interface EditedDocument {
  buffer: Buffer;
  results: readonly WordEditResult[];
}

/** 从零生成文档的内容块：标题、段落、项目符号或表格。 */
export type WordBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; text: string }
  | {
      type: "table";
      headers: readonly string[];
      rows: readonly (readonly string[])[];
    };

export interface WordDocumentContent {
  title: string;
  blocks: readonly WordBlock[];
}

const DOC_FONT = "微软雅黑";
const HEADING_COLOR = "1F4E79";
const HEADING_COLOR_SUB = "2E74B5";
const A4_WIDTH_TWIP = 11906;
const A4_HEIGHT_TWIP = 16838;
const MARGIN_TWIP = 1440; // 1 英寸 ≈ 2.54cm
const LINE_SPACING = 324; // 324/240 ≈ 1.35 倍行距

/**
 * 从结构化内容生成排版完整的 docx：A4 页面与页边距、styles.xml、
 * 中文字体（微软雅黑）、标题层级配色、行距与段间距。
 *
 * 与早期最小包不同，完整样式表让 Word、WPS、LibreOffice 都按样式渲染；
 * 文本仍落在 w:p/w:t 结构里，创建后可直接用 applyEdits 继续修改。
 */
export async function createDocx(content: WordDocumentContent): Promise<Buffer> {
  const doc = new Document({
    creator: "PanPilot",
    title: content.title,
    styles: {
      default: {
        document: {
          run: { font: DOC_FONT, size: 22 }, // 22 半磅 = 11pt
          paragraph: {
            spacing: { after: 120, line: LINE_SPACING, lineRule: LineRuleType.AUTO },
          },
        },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          run: { font: DOC_FONT, size: 40, bold: true, color: HEADING_COLOR },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { after: 240, line: LINE_SPACING, lineRule: LineRuleType.AUTO },
            keepNext: true,
          },
        },
        ...headingStyles(),
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: A4_WIDTH_TWIP, height: A4_HEIGHT_TWIP },
          margin: {
            top: MARGIN_TWIP,
            bottom: MARGIN_TWIP,
            left: MARGIN_TWIP,
            right: MARGIN_TWIP,
          },
        },
      },
      children: [
        new Paragraph({
          style: "Title",
          children: [new TextRun(content.title)],
        }),
        ...content.blocks.map(toBlock),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

function headingStyles() {
  return [1, 2, 3].map((level) => ({
    id: `Heading${level}`,
    name: `Heading ${level}`,
    basedOn: "Normal",
    next: "Normal",
    run: {
      font: DOC_FONT,
      size: level === 1 ? 32 : level === 2 ? 28 : 24,
      bold: true,
      color: level === 1 ? HEADING_COLOR : HEADING_COLOR_SUB,
    },
    paragraph: {
      spacing: {
        before: level === 1 ? 360 : 240,
        after: 160,
        line: LINE_SPACING,
        lineRule: LineRuleType.AUTO,
      },
      keepNext: true,
    },
  }));
}

function toBlock(block: WordBlock): Paragraph | Table {
  switch (block.type) {
    case "heading":
      return new Paragraph({
        style: `Heading${block.level}`,
        children: [new TextRun(block.text)],
      });
    case "paragraph":
      return new Paragraph({ text: block.text });
    case "bullet":
      return new Paragraph({ text: block.text, bullet: { level: 0 } });
    case "table":
      return toTable(block.headers, block.rows);
  }
}

function toTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((header) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: "EAF1FA" },
        children: [
          new Paragraph({ children: [new TextRun({ text: header, bold: true })] }),
        ],
      })),
  });
  const bodyRows = rows.map((row) =>
    new TableRow({
      children: row.map((cell) =>
        new TableCell({ children: [new Paragraph(cell)] })),
    }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: [headerRow, ...bodyRows],
  });
}

/** 读取 docx 正文（word/document.xml 中的段落文本）。 */
export async function extractText(buffer: Buffer): Promise<ExtractedDocument> {
  const xml = await readDocumentXml(buffer);
  return { paragraphs: extractParagraphs(xml) };
}

/**
 * 按编辑列表修改 docx：只重写 word/document.xml，其余 zip 条目原样保留。
 *
 * 当前支持：
 * - replace_text：在单个 <w:t> 文本节点内替换（Word 可能把一段文字拆成多个节点，
 *   跨节点的匹配会失败并返回未应用原因）；
 * - insert_paragraph：在包含指定文本的段落之后插入新段落。
 */
export async function applyEdits(
  buffer: Buffer,
  edits: readonly WordEdit[],
): Promise<EditedDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(DOCUMENT_XML_PATH);
  if (!entry) {
    throw new Error("不是有效的 docx：缺少 word/document.xml");
  }

  let xml = await entry.async("string");
  const results: WordEditResult[] = [];
  for (const edit of edits) {
    const outcome = applyEditToXml(xml, edit);
    xml = outcome.xml;
    results.push({
      type: edit.type,
      applied: outcome.applied,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    });
  }

  zip.file(DOCUMENT_XML_PATH, xml);
  const output = await zip.generateAsync({ type: "nodebuffer" });
  return { buffer: output, results };
}

/** 校验 docx 结构（zip 容器 + 必需的包内条目）。 */
export async function assertDocxStructure(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  if (!zip.file("[Content_Types].xml") || !zip.file(DOCUMENT_XML_PATH)) {
    throw new Error("不是有效的 docx：缺少必需的包条目");
  }
}

export function isDocxMagic(buffer: Buffer): boolean {
  // zip 本地文件头 PK\x03\x04（也可能是空包 PK\x05\x06 或分卷 PK\x07\x08）。
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
    && buffer[3] === 0x04;
}

async function readDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(DOCUMENT_XML_PATH);
  if (!entry) {
    throw new Error("不是有效的 docx：缺少 word/document.xml");
  }
  return entry.async("string");
}

function extractParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const text = extractTextFromXml(match[0]).trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function extractTextFromXml(xml: string): string {
  let text = "";
  for (const match of xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    text += unescapeXml(match[1] ?? "");
  }
  return text;
}

function applyEditToXml(
  xml: string,
  edit: WordEdit,
): { xml: string; applied: boolean; reason?: string } {
  if (edit.type === "replace_text") {
    return applyReplaceText(xml, edit.oldText, edit.newText);
  }
  return applyInsertParagraph(xml, edit.afterText, edit.paragraph);
}

function applyReplaceText(
  xml: string,
  oldText: string,
  newText: string,
): { xml: string; applied: boolean; reason?: string } {
  let replaced = 0;
  const updated = xml.replace(
    /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g,
    (match, attrs: string, content: string) => {
      const text = unescapeXml(content);
      if (!text.includes(oldText)) return match;
      replaced += 1;
      return `<w:t${attrs}>${escapeXml(text.replaceAll(oldText, newText))}</w:t>`;
    },
  );
  if (replaced === 0) {
    return {
      xml,
      applied: false,
      reason: `未找到文本「${oldText}」（可能被 Word 拆分成多个片段）`,
    };
  }
  return { xml: updated, applied: true };
}

function applyInsertParagraph(
  xml: string,
  afterText: string,
  paragraph: string,
): { xml: string; applied: boolean; reason?: string } {
  const paragraphPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let matchedEnd = -1;
  for (const match of xml.matchAll(paragraphPattern)) {
    const text = extractTextFromXml(match[0]);
    if (text.includes(afterText)) {
      matchedEnd = (match.index ?? 0) + match[0].length;
      break;
    }
  }
  if (matchedEnd < 0) {
    return {
      xml,
      applied: false,
      reason: `未找到包含「${afterText}」的段落`,
    };
  }
  const newParagraph =
    `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`;
  const updated = xml.slice(0, matchedEnd) + newParagraph + xml.slice(matchedEnd);
  return { xml: updated, applied: true };
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

function unescapeXml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) =>
    entities[entity] ?? entity);
}
