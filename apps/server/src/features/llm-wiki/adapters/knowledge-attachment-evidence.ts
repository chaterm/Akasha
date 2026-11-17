import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';

export const ATTACHMENT_EVIDENCE_STABLE_KEY_NAMESPACE = 'source';

type CompiledChunk = NonNullable<CompiledKnowledgeArtifact['chunks']>[number];
type CompiledParentSection = NonNullable<
  CompiledKnowledgeArtifact['parentSections']
>[number];

export type AttachmentEvidenceContent = {
  parentSections: CompiledParentSection[];
  chunks: CompiledChunk[];
};

const EMPTY_CONTENT: AttachmentEvidenceContent = {
  parentSections: [],
  chunks: [],
};

export function buildAttachmentEvidenceContent(input: {
  source: KnowledgeSourceSnapshot;
  sourceRef: KnowledgeSourceRef;
  pageTitle: string;
  existingChunkStableKeys?: Iterable<string>;
  includeAllChunks?: boolean;
}): AttachmentEvidenceContent {
  const occurrences = input.source.attachmentOccurrences ?? [];
  const serializedText = input.source.attachmentSerializedText;
  if (occurrences.length === 0 || !serializedText) return EMPTY_CONTENT;

  const structuralParents = chunkKnowledgeSource({
    pageTitle: input.pageTitle,
    text: serializedText,
    attachmentOccurrences: occurrences.map((occurrence) => ({
      startOffset: occurrence.startOffset,
      endOffset: occurrence.endOffset,
    })),
    sourceBlocks: input.source.attachmentSerializedBlocks,
    stableKeyNamespace: ATTACHMENT_EVIDENCE_STABLE_KEY_NAMESPACE,
  });

  const seenChunkStableKeys = new Set(input.existingChunkStableKeys ?? []);
  const parentSections: CompiledParentSection[] = [];
  const chunks: CompiledChunk[] = [];

  for (const parent of structuralParents) {
    let parentKept = false;
    for (const child of parent.children) {
      const containedOccurrences = occurrences.filter(
        (occurrence) =>
          occurrence.startOffset >= child.startOffset &&
          occurrence.endOffset <= child.endOffset,
      );
      if (containedOccurrences.length === 0 && !input.includeAllChunks) {
        continue;
      }
      if (seenChunkStableKeys.has(child.stableKey)) continue;
      seenChunkStableKeys.add(child.stableKey);

      chunks.push({
        text: child.text,
        embeddingText: child.embeddingText,
        contentHash: child.quoteHash,
        stableKey: child.stableKey,
        parentStableKey: parent.stableKey,
        chunkRole: 'child',
        retrievalChannel: 'evidence',
        headingPath: parent.headingPath,
        startOffset: child.startOffset,
        endOffset: child.endOffset,
        inputSourceRefs: [input.sourceRef],
        attachmentOccurrences: containedOccurrences.map((occurrence) => ({
          attachmentId: occurrence.attachmentId,
          sourcePageId: occurrence.sourcePageId,
          sourceVersion: input.source.sourceVersion,
          sourceContentHash: input.source.contentHash,
          attachmentUpdatedAt: occurrence.attachmentUpdatedAt,
          startOffset: occurrence.startOffset,
          endOffset: occurrence.endOffset,
        })),
      });
      parentKept = true;
    }

    if (parentKept) {
      parentSections.push({
        stableKey: parent.stableKey,
        headingPath: parent.headingPath,
        text: parent.text,
        contentHash: parent.quoteHash,
        startOffset: parent.startOffset,
        endOffset: parent.endOffset,
        inputSourceRefs: [input.sourceRef],
      });
    }
  }

  return { parentSections, chunks };
}
