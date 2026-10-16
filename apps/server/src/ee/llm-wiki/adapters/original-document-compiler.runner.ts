import { Injectable } from '@nestjs/common';
import {
  CompiledKnowledgeArtifact,
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { LlmWikiCompilerRunner } from './llm-wiki-file-compiler.runner';
import { buildAttachmentEvidenceContent } from './knowledge-attachment-evidence';
import { stableKnowledgeUuid } from '../services/knowledge-stable-id';

const ORIGINAL_CHUNK_SIZE = 900;

@Injectable()
export class OriginalDocumentCompilerRunner implements LlmWikiCompilerRunner {
  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    if (input.sources.length !== 1) {
      throw new Error('original compilation requires exactly one source page');
    }
    const source = input.sources[0];
    const compilerRunId =
      input.compileTaskId ??
      `${input.workspaceId}:${input.spaceId}:original:${source.sourcePageId}`;
    const sourceRef = toSourceRef(source);
    const attachmentEvidence = buildAttachmentEvidenceContent({
      source,
      sourceRef,
      pageTitle: source.title || 'Untitled',
      includeAllChunks: true,
    });
    const structuralParents = attachmentEvidence.chunks.length
      ? []
      : chunkKnowledgeSource({
          pageTitle: source.title || 'Untitled',
          text: source.text,
          content: source.content,
          maxChildCharacters: ORIGINAL_CHUNK_SIZE,
        });
    const chunks = attachmentEvidence.chunks.length
      ? attachmentEvidence.chunks
      : structuralParents.flatMap((parent) =>
          parent.children.map((child) => ({
            text: child.text,
            embeddingText: child.embeddingText,
            contentHash: child.quoteHash,
            stableKey: child.stableKey,
            parentStableKey: parent.stableKey,
            chunkRole: 'child' as const,
            retrievalChannel: 'evidence' as const,
            headingPath: parent.headingPath,
            startOffset: child.startOffset,
            endOffset: child.endOffset,
            inputSourceRefs: [
              {
                ...sourceRef,
                sourceRange: {
                  startOffset: child.startOffset,
                  endOffset: child.endOffset,
                },
                quoteHash: child.quoteHash,
              },
            ],
          })),
        );
    const artifactId = stableKnowledgeUuid(
      `${input.workspaceId}:${input.spaceId}:original_source:${source.sourcePageId}`,
    );
    const artifact: CompiledKnowledgeArtifact = {
      artifactId,
      artifactKind: 'original_source',
      canonicalKey: source.sourcePageId,
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      title: source.title || 'Untitled',
      contentMarkdown: '',
      sourcePageIds: [source.sourcePageId],
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
      generationMode: 'original',
      compilerRunId,
      compileTaskId: input.compileTaskId ?? compilerRunId,
      inputSourceRefs: [sourceRef],
      parentSections: attachmentEvidence.chunks.length
        ? attachmentEvidence.parentSections
        : structuralParents.map((parent) => ({
            stableKey: parent.stableKey,
            headingPath: parent.headingPath,
            text: parent.text,
            startOffset: parent.startOffset,
            endOffset: parent.endOffset,
            contentHash: parent.quoteHash,
            inputSourceRefs: [sourceRef],
          })),
      chunks,
    };
    return {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      sources: [sourceRef],
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
      compilerRunId,
      artifacts: [artifact],
      diagnostics: { warnings: [], errors: [] },
    };
  }
}

function toSourceRef(source: KnowledgeSourceSnapshot) {
  return {
    workspaceId: source.workspaceId,
    spaceId: source.spaceId,
    sourcePageId: source.sourcePageId,
    sourceVersion: source.sourceVersion,
    contentHash: source.contentHash,
  };
}

