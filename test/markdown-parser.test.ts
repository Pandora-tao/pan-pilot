import { describe, expect, it } from "vitest";
import {
  parseBlocks,
  parseInline,
  type BlockToken,
  type InlineToken,
} from "../web/src/features/chat/markdown-parser.js";

describe("markdown inline parser", () => {
  it("keeps plain text untouched", () => {
    expect(parseInline("普通的说明文字，没有格式。")).toEqual([
      { type: "text", text: "普通的说明文字，没有格式。" },
    ]);
  });

  it("parses bold, italic, strikethrough and inline code", () => {
    expect(parseInline("**加粗** *斜体* ~~删除~~ `代码`")).toEqual([
      { type: "strong", text: "加粗" },
      { type: "text", text: " " },
      { type: "emphasis", text: "斜体" },
      { type: "text", text: " " },
      { type: "deleted", text: "删除" },
      { type: "text", text: " " },
      { type: "inline-code", code: "代码" },
    ]);
  });

  it("does not treat snake_case underscores as emphasis", () => {
    expect(parseInline("使用 PAN_PILOT_API_TOKEN")).toEqual([
      { type: "text", text: "使用 PAN_PILOT_API_TOKEN" },
    ]);
  });

  it("parses markdown links and bare URLs / controlled paths", () => {
    const tokens = parseInline("看 [文档](https://example.com) 和 /v1/media/abc123 与 https://x.co");
    expect(tokens).toContainEqual({ type: "link", text: "文档", href: "https://example.com" });
    expect(tokens).toContainEqual({ type: "bare-url", raw: "/v1/media/abc123" });
    expect(tokens).toContainEqual({ type: "bare-url", raw: "https://x.co" });
  });
});

describe("markdown block parser", () => {
  it("parses headings at each level", () => {
    const blocks = parseBlocks("# 一级\n## 二级\n### 三级");
    expect(blocks.map((b) => [b.type, (b as { level?: number }).level])).toEqual([
      ["heading", 1],
      ["heading", 2],
      ["heading", 3],
    ]);
  });

  it("parses fenced code blocks with language and untouched content", () => {
    const blocks = parseBlocks("开头\n\n```ts\nconst a: number = 1\n# 不是标题\n```\n结尾");
    const code = blocks.find((b) => b.type === "code-block") as BlockToken & { code: string; lang: string };
    expect(code).toMatchObject({ type: "code-block", lang: "ts" });
    expect(code.code).toBe("const a: number = 1\n# 不是标题");
  });

  it("splits paragraphs on blank lines and interrupts on headings", () => {
    const blocks = parseBlocks("第一段\n第二行同段\n\n# 标题\n\n第三段");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
    const first = blocks[0] as BlockToken & { inlines: InlineToken[] };
    expect(first.type).toBe("paragraph");
    expect(first.inlines).toEqual([{ type: "text", text: "第一段 第二行同段" }]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseBlocks("- 苹果\n- 香蕉\n- 橙子\n\n1. 一\n2. 二");
    const ul = blocks[0] as BlockToken & { items: InlineToken[][] };
    const ol = blocks[1] as BlockToken & { items: InlineToken[][] };
    expect(ul.type).toBe("list");
    expect((ol as BlockToken).type).toBe("list");
    if (ul.type === "list") {
      expect(ul.ordered).toBe(false);
      expect(ul.items.length).toBe(3);
      expect(ul.items[0]).toEqual([{ type: "text", text: "苹果" }]);
    }
    if (ol.type === "list") {
      expect(ol.ordered).toBe(true);
      expect(ol.items.length).toBe(2);
      expect(ol.items[1]).toEqual([{ type: "text", text: "二" }]);
    }
  });

  it("parses blockquotes and thematic breaks", () => {
    const blocks = parseBlocks("> 引用文字\n\n---");
    expect(blocks[0]).toMatchObject({ type: "quote" });
    expect(blocks[1]).toEqual({ type: "hr" });
    const quote = blocks[0] as BlockToken & { inlines: InlineToken[] };
    expect(quote.type).toBe("quote");
    expect(quote.inlines).toEqual([{ type: "text", text: "引用文字" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseBlocks("   \n\n")).toEqual([]);
  });
});
