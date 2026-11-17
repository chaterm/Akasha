import { KnowledgeSourceSnapshot } from './source-snapshot.types';
import { KnowledgeIndexMode } from './knowledge-index-mode.types';

export type KnowledgeTextPageData = {
  workspaceId: string;
  spaceId: string;
  sourcePageIds: string[];
  sourceVersion?: string;
  sourceContentHash?: string;
  spaceRunId: string;
  knowledgeGeneration: number;
  indexMode?: KnowledgeIndexMode;
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
  expectedExtractionIds: string[];
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
  embedding?: {
    reusedCount: number;
    generatedCount: number;
    profileMismatchCount: number;
  };
};
