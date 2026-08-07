import { describe, expect, it, vi } from "vitest";
import type { SearchClient } from "../src/search/search-client.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { createWebSearchTool } from "../src/tools/web-search.js";

describe("web_search tool", () => {
  it("forwards the query and default max results, and caps snippets", async () => {
    const search = vi.fn<SearchClient["search"]>().mockResolvedValue([
      { title: "标题", url: "https://example.com", snippet: "短摘要" },
      {
        title: "长摘要",
        url: "https://example.com/long",
        snippet: "x".repeat(800),
      },
    ]);
    const tool = createWebSearchTool({ search });

    const result = await tool.execute({ query: "PanPilot" });

    expect(result).toEqual({
      query: "PanPilot",
      resultCount: 2,
      results: [
        { title: "标题", url: "https://example.com", snippet: "短摘要" },
        {
          title: "长摘要",
          url: "https://example.com/long",
          snippet: "x".repeat(500),
        },
      ],
    });
    expect(search).toHaveBeenCalledWith("PanPilot", 5);
  });

  it("passes an explicit max results value", async () => {
    const search = vi.fn<SearchClient["search"]>().mockResolvedValue([]);
    const tool = createWebSearchTool({ search });

    await tool.execute({ query: "q", maxResults: 3 });

    expect(search).toHaveBeenCalledWith("q", 3);
  });

  it("rejects empty queries and out-of-range max results", async () => {
    const tool = createWebSearchTool({ search: vi.fn() });
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("web_search", { query: "   " })).rejects.toMatchObject({
      code: "INVALID_TOOL_INPUT",
    });
    await expect(registry.execute("web_search", { query: "q", maxResults: 0 }))
      .rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    await expect(registry.execute("web_search", { query: "q", maxResults: 11 }))
      .rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
  });

  it("propagates search provider errors", async () => {
    const tool = createWebSearchTool({
      search: vi.fn().mockRejectedValue(new Error("搜索服务返回 500")),
    });

    await expect(tool.execute({ query: "q" }))
      .rejects.toThrow("搜索服务返回 500");
  });

  it("does not call the provider when the signal is already aborted", async () => {
    const search = vi.fn<SearchClient["search"]>();
    const tool = createWebSearchTool({ search });
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));

    await expect(tool.execute({ query: "q" }, controller.signal))
      .rejects.toThrow("用户取消");
    expect(search).not.toHaveBeenCalled();
  });
});
