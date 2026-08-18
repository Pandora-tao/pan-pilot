/**
 * 轻量 Markdown 渲染的纯分词层：只产出结构化 token，不引入 React。
 * 用于助手长回复的排版与代码块；支持的子集：
 * 段落 / 标题(#-######) / 有序无序列表 / 引用 / 分隔线 / 围栏代码块
 * 行内：加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 裸网址 / /v1 受控下载路径。
 */

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "emphasis"; text: string }
  | { type: "deleted"; text: string }
  | { type: "inline-code"; code: string }
  | { type: "link"; text: string; href: string }
  /** 裸 URL（http/https 或 /v1/media|artifacts 受控路径），渲染时转成链接/文件 chip。 */
  | { type: "bare-url"; raw: string };

export type BlockToken =
  | { type: "paragraph"; inlines: InlineToken[] }
  | { type: "heading"; level: number; inlines: InlineToken[] }
  | { type: "code-block"; lang: string; code: string }
  | { type: "quote"; inlines: InlineToken[] }
  | { type: "list"; ordered: boolean; items: InlineToken[][] }
  | { type: "hr" };

const FENCE_PATTERN = /^(```|~~~)(\w*)\s*$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const HR_PATTERN = /^\s*([-*_])(?:\s*[-*_]){2,}\s*$/;
const QUOTE_PATTERN = /^>\s?/;
const UL_PATTERN = /^\s*[-*+]\s+(.*)$/;
const OL_PATTERN = /^\s*\d+[.)]\s+(.*)$/;
const UL_MARKER_RE = /^\s*[-*+]\s+/;
const OL_MARKER_RE = /^\s*\d+[.)]\s+/;
const FENCE_CLOSE_RE = /^\s*(```|~~~)\s*$/;

/** 行内分词：优先代码区间/链接/裸地址，再做加粗/斜体/删除线。 */
export function parseInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "text", text: source.slice(last, index) });
    const [
      _whole,
      code,
      _linkGroup,
      linkText,
      linkHref,
      bareMedia,
      bareHttp,
      strong,
      em,
      del,
    ] = match;
    if (code !== undefined) {
      tokens.push({ type: "inline-code", code: code.slice(1, -1) });
    } else if (linkHref !== undefined) {
      tokens.push({ type: "link", text: linkText ?? "", href: linkHref });
    } else if (bareMedia !== undefined) {
      tokens.push({ type: "bare-url", raw: bareMedia });
    } else if (bareHttp !== undefined) {
      tokens.push({ type: "bare-url", raw: bareHttp });
    } else if (strong !== undefined) {
      // **x** / __x__
      tokens.push({ type: "strong", text: strong.slice(2, -2) });
    } else if (em !== undefined) {
      // *x* / _x_
      tokens.push({ type: "emphasis", text: em.slice(1, -1) });
    } else if (del !== undefined) {
      tokens.push({ type: "deleted", text: del.slice(2, -2) });
    }
    last = index + match[0].length;
  }
  if (last < source.length) tokens.push({ type: "text", text: source.slice(last) });
  return tokens;
}

/** 块级分词：按行扫描，输出块级 token 列表。 */
export function parseBlocks(source: string): BlockToken[] {
  const lines = source.split("\n");
  const blocks: BlockToken[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = FENCE_PATTERN.exec(trimmed);
    if (fence) {
      const lang = fence[2] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test((lines[i] ?? "").trim())) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1; // 跳过闭合围栏
      blocks.push({ type: "code-block", lang, code: codeLines.join("\n") });
      continue;
    }

    // ATX 标题
    const heading = HEADING_PATTERN.exec(trimmed);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        inlines: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    // 分隔线
    if (HR_PATTERN.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    // 引用
    if (QUOTE_PATTERN.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE_PATTERN.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(QUOTE_PATTERN, ""));
        i += 1;
      }
      blocks.push({ type: "quote", inlines: parseInline(quoted.join(" ")) });
      continue;
    }

    // 列表
    const ul = UL_PATTERN.exec(line);
    const ol = OL_PATTERN.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const markerRe = ordered ? OL_MARKER_RE : UL_MARKER_RE;
      const items: InlineToken[][] = [];
      let current: string[] = [ul ? (ul[1] ?? "") : (ol?.[1] ?? "")];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.trim() === "") break;
        const item = markerRe.exec(next);
        if (item) {
          items.push(parseInline(current.join(" ")));
          current = [next.slice(item[0].length)];
          i += 1;
          continue;
        }
        // 非列表标记的普通行视为当前条目续行
        current.push(next.trim());
        i += 1;
      }
      items.push(parseInline(current.join(" ")));
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 普通段落：遇到空行或块级起始行即结束
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (cur.trim() === "") break;
      if (i > 0 && paraLines.length > 0 && isBlockStart(cur)) break;
      paraLines.push(cur);
      i += 1;
    }
    blocks.push({ type: "paragraph", inlines: parseInline(paraLines.join(" ")) });
  }
  return blocks;
}

/** 判断一行是否构成新的块级起始（可中断段落）。 */
function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return FENCE_PATTERN.test(trimmed)
    || HEADING_PATTERN.test(trimmed)
    || HR_PATTERN.test(trimmed)
    || QUOTE_PATTERN.test(line)
    || UL_PATTERN.test(line)
    || OL_PATTERN.test(line);
}

/**
 * 行内主模式：顺序即优先级。
 * 1 行内代码  2/3/4 链接  5 /v1 路径  6 http(s) 裸地址  7 加粗  8 斜体  9 删除线
 * 加粗/斜体仅支持星号（不支持下划线，避免 PAN_PILOT_* 等标识符被误判为强调）。
 */
const INLINE_PATTERN = /(`[^`]+`)|(\[([^\]]*)\]\(([^)]+)\))|(\/v1\/(?:media|artifacts)\/[A-Za-z0-9-]+)|(https?:\/\/[^\s<>"')\]]+)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)/g;
