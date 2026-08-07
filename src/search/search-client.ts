/** 单条网页搜索结果；摘要截断后回填给模型，帮助它引用来源。 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 搜索提供端口：Agent 只认识这个接口。
 *
 * 默认实现是无需 API Key 的 Bing 网页搜索；以后接 Tavily、Serper
 * 等带 Key 的搜索服务时，实现同一接口即可，工具层不需要改动。
 */
export interface SearchClient {
  search(query: string, maxResults: number): Promise<readonly WebSearchResult[]>;
}
