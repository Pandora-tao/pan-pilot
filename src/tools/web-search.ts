import { z } from "zod";
import type { SearchClient, WebSearchResult } from "../search/search-client.js";
import type { AgentTool } from "./tool.js";

const MAX_SNIPPET_CHARS = 500;

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1, "query 不能为空").max(300),
  maxResults: z.number().int().min(1).max(10).optional(),
}).strict();

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;

export interface WebSearchOutput {
  query: string;
  resultCount: number;
  results: readonly WebSearchResult[];
}

/** 搜索互联网并返回标题、链接和摘要，供模型引用实时信息。 */
export function createWebSearchTool(
  client: SearchClient,
): AgentTool<WebSearchInput, WebSearchOutput> {
  return {
    name: "web_search",
    description:
      "搜索互联网，返回网页标题、链接和内容摘要，用于获取实时信息或事实核查",
    inputSchema: webSearchInputSchema,
    async execute(input, ctx) {
      ctx.signal?.throwIfAborted();
      const maxResults = input.maxResults ?? 5;
      const results = await client.search(input.query, maxResults);
      return {
        query: input.query,
        resultCount: results.length,
        results: results.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.snippet.slice(0, MAX_SNIPPET_CHARS),
        })),
      };
    },
  };
}
