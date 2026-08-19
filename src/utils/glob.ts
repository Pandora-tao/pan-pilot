/**
 * 轻量 glob 匹配（纯 JS，跨平台，不依赖运行时下载二进制）。
 *
 * 支持语法：
 * - `*`：匹配一段路径内的任意字符（不含 `/`）；
 * - `**`：跨路径段匹配（`**` 或其后跟斜杠的形式可匹配零个或多个段）；
 * - `?`：单字符（不含 `/`）；
 * - `[abc]` / `[a-z]` / `[!abc]`：字符类；
 * - `{a,b}`：逗号分隔的备选项；
 * - `\`：转义下一个字面字符。
 */

const cache = new Map<string, RegExp>();

/** 把 glob 编译为锚定正则；编译结果缓存以避免重复解析。 */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;
  const source = compile(glob);
  const re = new RegExp(`^${source}$`);
  cache.set(glob, re);
  return re;
}

/** 判断 value 是否匹配 glob（路径使用 `/` 语义，`\` 归一化为 `/`）。 */
export function matchesGlob(glob: string, value: string): boolean {
  let normalized = value.replaceAll("\\", "/");
  // `**/` 前缀与绝对路径（以 / 开头）比较时，去掉候选路径的前导斜杠，
  // 否则 `**` 无法匹配首段。
  if (!glob.startsWith("/")) normalized = normalized.replace(/^\/+/, "");
  return globToRegExp(glob).test(normalized);
}

function compile(glob: string): string {
  let out = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const ch = glob[i]!;
    // `**` 跨段匹配（`**/` 可匹配零个或多个段）。
    if (ch === "*") {
      if (i + 1 < n && glob[i + 1] === "*") {
        i += 2;
        if (i < n && glob[i] === "/") {
          i += 1;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const { source, next } = parseClass(glob, i);
      out += source;
      i = next;
      continue;
    }
    if (ch === "{") {
      const { source, next } = parseBraces(glob, i);
      out += source;
      i = next;
      continue;
    }
    if (ch === "\\" && i + 1 < n) {
      out += escapeRegexChar(glob[i + 1]!);
      i += 2;
      continue;
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

function parseClass(glob: string, start: number): { source: string; next: number } {
  let j = start + 1;
  let negate = false;
  if (glob[j] === "!" || glob[j] === "^") {
    negate = true;
    j += 1;
  }
  let body = "";
  while (j < glob.length && glob[j] !== "]") {
    if (glob[j] === "\\" && j + 1 < glob.length) {
      body += escapeRegexChar(glob[j + 1]!);
      j += 2;
      continue;
    }
    body += escapeRegexChar(glob[j]!);
    j += 1;
  }
  // 未闭合的类按字符转义处理。
  if (j >= glob.length) {
    return { source: `\\[${negate ? "!" : ""}`, next: j + 1 };
  }
  return { source: `[${negate ? "^" : ""}${body}]`, next: j + 1 };
}

function parseBraces(glob: string, start: number): { source: string; next: number } {
  let j = start + 1;
  const parts: string[] = [];
  let current = "";
  while (j < glob.length && glob[j] !== "}") {
    if (glob[j] === ",") {
      parts.push(compileInto(current));
      current = "";
      j += 1;
      continue;
    }
    if (glob[j] === "\\" && j + 1 < glob.length) {
      current += glob[j + 1];
      j += 2;
      continue;
    }
    current += glob[j];
    j += 1;
  }
  if (j >= glob.length) {
    return { source: `${escapeRegexChar("{")}`, next: j + 1 };
  }
  parts.push(compileInto(current));
  return { source: `(?:${parts.join("|")})`, next: j + 1 };
}

/** 把一段不含嵌套结构的 glob 片段编译为未锚定正则源码。 */
function compileInto(segment: string): string {
  // 复用主编译逻辑：临时补成完整 glob 再取源码。
  return compile(segment);
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}
