export interface KnowledgeSourceSnapshot {
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  title: string;
  text: string;
  content?: unknown;
  references: KnowledgeSourceReference[];
}

export interface KnowledgeSourceReference {
  sourcePageId: string;
  targetPageId: string;
  targetSpaceId: string;
  kind: 'same_space_reference' | 'cross_space_reference' | 'transclusion';
  mode: 'opaque' | 'expanded';
}
