import { KnowledgeScope, KnowledgeSourceRef } from './knowledge.types';
import { KnowledgeSourceSnapshot } from './source-snapshot.types';
import { JsonValue } from '../../../database/types/db';
import { KyselyTransaction } from '../../../database/types/kysely.types';
import type { KnowledgeOperationBudget } from '../services/knowledge-operation-budget';

export interface CompileSpaceInput extends KnowledgeScope {
  sources: KnowledgeSourceSnapshot[];
  compilerVersion: string;
  promptVersion: string;
  compileTaskId?: string;
  compileMode: 'pages';
  purpose?: string;
  schema?: string;
  catalog?: KnowledgeArtifactCatalogEntry[];
  bypassCache?: boolean;
  publicationGuard?: (trx: KyselyTransaction) => Promise<boolean>;
  operationBudget?: KnowledgeOperationBudget;
  indexMode?: 'compiled' | 'original';
}

export interface KnowledgeArtifactCatalogEntry {
  artifactId?: string;
  artifactKind: CompiledKnowledgeArtifactKind;
  canonicalKey: string;
  title: string;
}

export interface CompileDiagnostic {
  code: string;
  message: string;
  sourcePageId?: string;
}

export interface CompileDiagnostics {
  warnings: CompileDiagnostic[];
  errors: CompileDiagnostic[];
}

export type CompiledKnowledgeArtifactKind =
  | 'source_summary'
  | 'original_source'
  | 'concept'
  | 'entity'
  | 'comparison';

export interface CompiledKnowledgeArtifact extends KnowledgeScope {
  artifactId: string;
  artifactKind?: CompiledKnowledgeArtifactKind;
  canonicalKey?: string;
  title: string;
  contentMarkdown: string;
  sourcePageIds: string[];
  compilerVersion: string;
  promptVersion: string;
  generationMode?: 'semantic' | 'legacy' | 'raw_fallback' | 'original';
  compilerRunId?: string;
  compileTaskId?: string;
  inputSourceRefs?: KnowledgeSourceRef[];
  parentSections?: Array<{
    stableKey: string;
    headingPath: string[];
    text: string;
    contentHash?: string;
    startOffset?: number | null;
    endOffset?: number | null;
    inputSourceRefs?: KnowledgeSourceRef[];
  }>;
  chunks?: Array<{
    text: string;
    embedding?: JsonValue;
    contentHash?: string;
    inputSourceRefs?: KnowledgeSourceRef[];
    stableKey?: string;
    parentStableKey?: string | null;
    chunkRole?: 'child' | 'standalone';
    retrievalChannel?: 'evidence' | 'memory';
    headingPath?: string[];
    startOffset?: number | null;
    endOffset?: number | null;
    embeddingText?: string;
    attachmentOccurrences?: Array<{
      attachmentId: string;
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      attachmentUpdatedAt: string;
      startOffset: number;
      endOffset: number;
    }>;
  }>;
  links?: Array<{
    linkType: string;
    linkText?: string;
    targetPageId?: string;
    targetSpaceId?: string;
    targetArtifactKind?: CompiledKnowledgeArtifactKind;
    targetCanonicalKey?: string;
    toKnowledgePageId?: string;
    isOpaque?: boolean;
    isDangling?: boolean;
    inputSourceRefs?: KnowledgeSourceRef[];
  }>;
  rawArtifactKey?: string;
}

export interface CompileSpaceResult extends KnowledgeScope {
  sources: KnowledgeSourceRef[];
  compilerVersion: string;
  promptVersion: string;
  compilerRunId: string;
  artifacts: CompiledKnowledgeArtifact[];
  diagnostics: CompileDiagnostics;
  resultQuality?: 'normal' | 'degraded';
}
