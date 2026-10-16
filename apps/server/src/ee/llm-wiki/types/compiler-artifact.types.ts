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
  /** Explicit cache bypass used by administrator force rebuilds. */
  bypassCache?: boolean;
  /** Prevents a degraded fallback from replacing an existing publication. */
  hasLastSuccess?: boolean;
  publicationGuard?: (trx: KyselyTransaction) => Promise<boolean>;
  operationBudget?: KnowledgeOperationBudget;
  indexMode?: 'compiled' | 'original';
}

export interface KnowledgeArtifactCatalogEntry {
  artifactId?: string;
  artifactKind: CompiledKnowledgeArtifactKind;
  canonicalKey: string;
  title: string;
  summary?: string;
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
  claims?: Array<{
    text: string;
    confidence?: number | null;
    inputSourceRefs?: KnowledgeSourceRef[];
  }>;
  chunks?: Array<{
    text: string;
    claimIndex?: number | null;
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
    /**
     * Trusted, page-owned non-image attachments fully contained inside this
     * chunk's source range. Only deterministic original-content chunks carry
     * it; model summary/rewrite chunks never do. Most fields mirror
     * knowledge_chunk_attachments so import can persist relation rows directly;
     * `startOffset`/`endOffset` are the occurrence's marker range (relative to
     * the serialized attachment text, the same basis as this chunk's own
     * offsets) and are NOT persisted — they exist so the artifact validator can
     * prove the marker is fully contained inside this chunk (§6.2), rather than
     * merely belonging to the same page.
     */
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
  graphEdges?: Array<{
    toKnowledgePageId?: string;
    targetArtifactKind?: CompiledKnowledgeArtifactKind;
    targetCanonicalKey?: string;
    relation: string;
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
