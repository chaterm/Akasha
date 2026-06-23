export interface SearchResult {
  query: string;
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
}

export class MockSearchProvider implements SearchProvider {
  constructor(private readonly perQuery = 3) {}

  async search(query: string): Promise<SearchResult[]> {
    return Array.from({ length: this.perQuery }, (_, i) => ({
      query,
      title: `[MOCK] 关于「${query}」的资料 ${i + 1}`,
      url: `https://example.com/search?q=${encodeURIComponent(query)}&r=${i + 1}`,
      snippet:
        `这是针对「${query}」的第 ${i + 1} 条模拟检索结果(占位)。` +
        `真实接入搜索 API 后,此处为网页正文摘要。`,
    }));
  }
}
