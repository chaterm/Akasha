export interface KnowledgeScope {
  workspaceId: string;
  spaceId: string;
}

export interface KnowledgeSourceRange {
  startOffset: number;
  endOffset: number;
}

export interface KnowledgeSourceRef extends KnowledgeScope {
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  sourceRange?: KnowledgeSourceRange;
  quoteHash?: string;
}
