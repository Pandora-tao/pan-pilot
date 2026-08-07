import type { SearchClient, WebSearchResult } from "./search-client.js";

const DEFAULT_BASE_URL = "https://www.bing.com/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface BingSearchOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 无 Key 的 Bing 网页搜索实现。
 *
 * 解析结果页里 class="b_algo" 的结果块：h2 内第一个链接是标题/目标地址，
 * 块内第一个 <p> 是摘要。Bing 对常规 UA 的网页搜索可用，无需 API Key；
 * 以后接 Tavily、Serper 等带 Key 服务时实现同一 SearchClient 接口即可。
 */
export class BingSearchClient implements SearchClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BingSearchOptions = {}) {
    this.baseUrl = options.baseUrl
      ?? process.env.SEARCH_BASE_URL
      ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(
    query: string,
    maxResults: number,
  ): Promise<readonly WebSearchResult[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html",
          "accept-language": "zh-CN,zh;q=0.9",
        },
        // 结合调用方取消信号与固定超时，避免搜索挂起拖住整个 Agent 循环。
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`搜索请求失败：${messageOf(error)}`);
    }

    if (!response.ok) {
      throw new Error(`搜索服务返回 ${response.status}`);
    }
    const html = await response.text();
    return parseBingHtml(html).slice(0, maxResults);
  }
}

/** 解析 Bing 结果页；导出以便用固定 HTML 夹具做离线测试。 */
export function parseBingHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const startPattern = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"/g;
  const starts = [...html.matchAll(startPattern)];

  for (let index = 0; index < starts.length; index += 1) {
    const blockEnd = index + 1 < starts.length
      ? starts[index + 1]!.index
      : html.length;
    const block = html.slice(starts[index]!.index, blockEnd);

    const linkMatch = block.match(
      /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

    const url = (linkMatch[1] ?? "").replace(/&amp;/g, "&");
    const title = stripHtml(linkMatch[2] ?? "").trim();
    const snippet = stripHtml(snippetMatch?.[1] ?? "").trim();
    if (/^https?:\/\//i.test(url) && title) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ""));
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ensp|emsp|hellip|ndash|mdash);/gi,
    (entity) => {
      const body = entity.slice(1, -1);
      if (body.startsWith("#x")) {
        return safeFromCodePoint(parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) {
        return safeFromCodePoint(parseInt(body.slice(1), 10));
      }
      return ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
        ensp: " ",
        emsp: " ",
        hellip: "…",
        ndash: "–",
        mdash: "—",
      })[body.toLowerCase()] ?? entity;
    },
  );
}

function safeFromCodePoint(codePoint: number): string {
  return Number.isNaN(codePoint) ? "" : String.fromCodePoint(codePoint);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
