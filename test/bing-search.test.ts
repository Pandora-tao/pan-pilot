import { describe, expect, it, vi } from "vitest";
import {
  BingSearchClient,
  parseBingHtml,
} from "../src/search/bing-search.js";

describe("parseBingHtml", () => {
  it("extracts titles, snippets and urls from b_algo blocks", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo" data-id iid="SERP.5333">
          <h2 class="">
            <a target="_blank"
              href="https://example.com/page?a=1&amp;b=2" h="ID=SERP,5129.2">
              <strong>宁波</strong>政府 &amp; 公告
            </a>
          </h2>
          <p class="b_lineclamp2">摘要：价格是 <strong>100</strong> 元&#8220;引号&#8221;&ensp;继续</p>
        </li>
        <li class="b_algo">
          <h2><a target="_blank" href="https://second.example/">Second Result</a></h2>
          <p class="b_lineclamp2">第二个摘要</p>
        </li>
        <li class="b_no">不是结果块的条目</li>
      </ol>
    `;

    expect(parseBingHtml(html)).toEqual([
      {
        title: "宁波政府 & 公告",
        url: "https://example.com/page?a=1&b=2",
        snippet: "摘要：价格是 100 元“引号” 继续",
      },
      {
        title: "Second Result",
        url: "https://second.example/",
        snippet: "第二个摘要",
      },
    ]);
  });

  it("returns an empty list for pages without results", () => {
    expect(parseBingHtml("<html><body>no results</body></html>")).toEqual([]);
  });

  it("skips blocks without a usable link", () => {
    const html = `
      <li class="b_algo"><h2>只有标题没有链接</h2><p>摘要</p></li>
      <li class="b_algo"><h2><a href="/relative">Relative</a></h2><p>x</p></li>
    `;

    expect(parseBingHtml(html)).toEqual([]);
  });
});

describe("BingSearchClient", () => {
  it("queries the endpoint with the search term and slices results", async () => {
    const html = Array.from({ length: 8 }, (_, index) => `
      <li class="b_algo">
        <h2><a href="https://site-${index}.example/">Result ${index}</a></h2>
        <p>摘要 ${index}</p>
      </li>
    `).join("");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(html, { status: 200 }),
    );
    const client = new BingSearchClient({
      baseUrl: "https://search.example/search",
      fetchImpl,
    });

    const results = await client.search("测试 关键词", 3);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      title: "Result 0",
      url: "https://site-0.example/",
    });
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://search.example/search?q=%E6%B5%8B%E8%AF%95+%E5%85%B3%E9%94%AE%E8%AF%8D&count=3",
    );
    expect(options?.headers).toMatchObject({ accept: "text/html" });
  });

  it("throws a readable error on non-200 responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("blocked", { status: 429 }),
    );
    const client = new BingSearchClient({ fetchImpl });

    await expect(client.search("q", 5)).rejects.toThrow("搜索服务返回 429");
  });

  it("wraps network failures into a readable error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed"),
    );
    const client = new BingSearchClient({ fetchImpl });

    await expect(client.search("q", 5)).rejects.toThrow("搜索请求失败：fetch failed");
  });
});
