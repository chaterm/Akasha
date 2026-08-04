import { KnowledgeSourceSnapshot } from './source-snapshot.types';

export type KnowledgeTextPageData = {
  workspaceId: string;
  spaceId: string;
  sourcePageIds: string[];
  sourceVersion?: string;
  sourceContentHash?: string;
  spaceRunId: string;
  knowledgeGeneration: number;
};

export type KnowledgeImageMergePageData = {
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  sourceVersion: string;
  sourceContentHash: string;
  spaceRunId: string;
  knowledgeGeneration: number;
  images: NonNullable<KnowledgeSourceSnapshot['images']>;
  effectiveKnowledgeHash: string;
};

export type KnowledgePageCompilationResult = {
  type: 'text' | 'image_merge';
  workspaceId: string;
  spaceId: string;
  compilerRunId: string;
  sourceCount: number;
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  durationMs: number;
};
