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
  /**
   * Extraction ids frozen by the run plan for this page's successfully
   * extracted images. The merge build reads exactly these ids; a missing or
   * invalid frozen extraction forces a re-plan instead of publishing an input
   * the Run never planned.
   */
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
};
