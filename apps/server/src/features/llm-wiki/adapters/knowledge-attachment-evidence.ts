import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';

/**
 * Stable-key namespace applied to every deterministic attachment evidence
 * block so it never collides with the model-generated evidence child blocks in
 * the same knowledge page and stays distinguishable in observability/diagnostic
 * logs (see design §5.3.5 and §11.4).
 */
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

/**
 * Re-chunks the marker-carrying serialized source text (design §5.3.1) and
 * keeps only the deterministic original-content blocks that fully contain a
 * trusted attachment occurrence. Each kept block:
 *
 * - hard-codes `retrievalChannel='evidence'` and `chunkRole='child'` (§5.3.4),
 * - reuses the `source:` stable-key namespace so it never collides with the
 *   model-generated evidence blocks (§5.3.5),
 * - carries the trusted occurrences needed to write knowledge_chunk_attachments
 *   rows (§5.1 full containment),
 * - is deduplicated by stable key against itself and any already-emitted chunk
 *   (§5.3.8 / §5.3.9).
 *
 * Model summary/rewrite blocks never enter here, so they never establish an
 * attachment relation (§5.3.7).
 */
export function buildAttachmentEvidenceContent(input: {
  source: KnowledgeSourceSnapshot;
  sourceRef: KnowledgeSourceRef;
  pageTitle: string;
  existingChunkStableKeys?: Iterable<string>;
  /**
   * Publishes every deterministic original-content chunk instead of only the
   * chunks carrying an attachment. Used by the direct/original compiler so an
   * attachment page has one canonical chunk set rather than overlapping raw
   * and attachment-only indexes.
   */
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
        // Ranges/quote hashes reference the serialized (marker) text, not the
        // source content hash text, so only carry the base source ref. Trusted
        // provenance travels on attachmentOccurrences and is re-checked by the
        // artifact validator (§6.2).
        inputSourceRefs: [input.sourceRef],
        attachmentOccurrences: containedOccurrences.map((occurrence) => ({
          attachmentId: occurrence.attachmentId,
          sourcePageId: occurrence.sourcePageId,
          sourceVersion: input.source.sourceVersion,
          sourceContentHash: input.source.contentHash,
          attachmentUpdatedAt: occurrence.attachmentUpdatedAt,
          // Carry the marker range so the validator can re-prove full
          // containment inside this chunk (§6.2), not just same-page ownership.
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
