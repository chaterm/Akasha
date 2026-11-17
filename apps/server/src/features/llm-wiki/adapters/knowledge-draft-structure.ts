import { createHash } from 'node:crypto';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';
import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';

type CompiledParentSection = NonNullable<
  CompiledKnowledgeArtifact['parentSections']
>[number];
type CompiledChunk = NonNullable<CompiledKnowledgeArtifact['chunks']>[number];

export function draftStableKeyNamespace(sourcePageId: string): string {
  return `d.${createHash('sha256').update(sourcePageId).digest('hex').slice(0, 12)}`;
}

export function isDraftStructuralChunk(chunk: CompiledChunk): boolean {
  return (
    !chunk.stableKey?.startsWith('table-row:') &&
    (chunk.attachmentOccurrences?.length ?? 0) === 0
  );
}

export function buildDraftStructuralContent(input: {
  title: string;
  markdown: string;
  sourceRef: KnowledgeSourceRef;
}): { parentSections: CompiledParentSection[]; chunks: CompiledChunk[] } {
  const structuralParents = chunkKnowledgeSource({
    pageTitle: input.title,
    text: input.markdown,
    stableKeyNamespace: draftStableKeyNamespace(input.sourceRef.sourcePageId),
  });
  const parentSections = structuralParents.map((parent) => ({
    stableKey: parent.stableKey,
    headingPath: parent.headingPath,
    text: parent.text,
    contentHash: parent.quoteHash,
    startOffset: parent.startOffset,
    endOffset: parent.endOffset,
    inputSourceRefs: [input.sourceRef],
  }));
  const chunks = structuralParents.flatMap((parent) =>
    parent.children.map((child) => ({
      text: child.text,
      inputSourceRefs: [input.sourceRef],
      contentHash: child.quoteHash,
      stableKey: child.stableKey,
      parentStableKey: parent.stableKey,
      chunkRole: 'child' as const,
      retrievalChannel: 'memory' as const,
      headingPath: parent.headingPath,
      startOffset: child.startOffset,
      endOffset: child.endOffset,
      embeddingText: child.embeddingText,
    })),
  );
  return { parentSections, chunks };
}

export function normalizeStoredContributionStructure(
  artifact: CompiledKnowledgeArtifact,
): CompiledKnowledgeArtifact | null {
  const sourcePageIds = [...new Set(artifact.sourcePageIds ?? [])];
  const sourceRefs = artifact.inputSourceRefs ?? [];
  if (sourcePageIds.length !== 1) return null;
  const sourceRef = sourceRefs.find(
    (ref) => ref.sourcePageId === sourcePageIds[0] && !ref.sourceRange,
  );
  if (!sourceRef) return null;
  if (sourceRefs.some((ref) => ref.sourcePageId !== sourcePageIds[0])) {
    return null;
  }

  const structural = buildDraftStructuralContent({
    title: artifact.title,
    markdown: artifact.contentMarkdown,
    sourceRef,
  });
  const preservedChunks = (artifact.chunks ?? []).filter(
    (chunk) => !isDraftStructuralChunk(chunk),
  );
  const preservedParentKeys = new Set(
    preservedChunks.flatMap((chunk) =>
      chunk.parentStableKey ? [chunk.parentStableKey] : [],
    ),
  );
  const preservedParents = (artifact.parentSections ?? []).filter((parent) =>
    preservedParentKeys.has(parent.stableKey),
  );

  return {
    ...artifact,
    parentSections: [...structural.parentSections, ...preservedParents],
    chunks: [...structural.chunks, ...preservedChunks],
  };
}
