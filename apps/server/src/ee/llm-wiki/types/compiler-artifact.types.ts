import { KnowledgeScope, KnowledgeSourceRef } from './knowledge.types';
import { KnowledgeSourceSnapshot } from './source-snapshot.types';
import { JsonValue } from '../../../database/types/db';

export interface CompileSpaceInput extends KnowledgeScope {
  sources: KnowledgeSourceSnapshot[];
  compilerVersion: string;
  promptVersion: string;
  compileMode?: 'space' | 'pages';
  purpose?: string;
  schema?: string;
  catalog?: KnowledgeArtifactCatalogEntry[];
}

export interface KnowledgeArtifactCatalogEntry {
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
  | 'concept'
  | 'entity'
  | 'comparison'
  | 'overview';

export interface CompiledKnowledgeArtifact extends KnowledgeScope {
  artifactId: string;
  artifactKind?: CompiledKnowledgeArtifactKind;
  canonicalKey?: string;
  title: string;
  contentMarkdown: string;
  sourcePageIds: string[];
  compilerVersion: string;
  promptVersion: string;
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
  }>;
  links?: Array<{
    linkType: string;
    linkText?: string;
    targetPageId?: string;
    targetSpaceId?: string;
    toKnowledgePageId?: string;
    isOpaque?: boolean;
    isDangling?: boolean;
    inputSourceRefs?: KnowledgeSourceRef[];
  }>;
  graphEdges?: Array<{
    toKnowledgePageId: string;
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
}
