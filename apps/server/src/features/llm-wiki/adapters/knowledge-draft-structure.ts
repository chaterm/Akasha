import { createHash } from 'node:crypto';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';
import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';

type CompiledParentSection = NonNullable<
  CompiledKnowledgeArtifact['parentSections']
>[number];
type CompiledChunk = NonNullable<CompiledKnowledgeArtifact['chunks']>[number];

/**
 * Per-source namespace for the structural chunks of one generated draft.
 *
 * Shared artifacts union several single-source drafts by stable key. Without a
 * source scope, two sources with the same heading path ("概述") produced the
 * same parent key, so one source's parent text was kept and the other source's
 * children were attached to it. The namespace keeps every draft's parent/child
 * keys disjoint. It must stay distinct from the attachment-evidence namespace
 * (`source:`) and the `table-row:` prefix, and short enough for varchar(64).
 */
export function draftStableKeyNamespace(sourcePageId: string): string {
  return `d.${createHash('sha256').update(sourcePageId).digest('hex').slice(0, 12)}`;
}

export function isDraftStructuralChunk(chunk: CompiledChunk): boolean {
  return (
    !chunk.stableKey?.startsWith('table-row:') &&
    (chunk.attachmentOccurrences?.length ?? 0) === 0
  );
}

/**
 * Deterministic parent sections and child chunks for one source's generated
 * Markdown. Parent and child keys come from the same chunker run, so every
 * child's parentStableKey always names a parent produced here.
 */
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
      // Model-generated knowledge, not deterministic source evidence. Table
      // rows and attachment blocks keep the evidence channel.
      retrievalChannel: 'memory' as const,
      headingPath: parent.headingPath,
      startOffset: child.startOffset,
      endOffset: child.endOffset,
      embeddingText: child.embeddingText,
    })),
  );
  return { parentSections, chunks };
}

/**
 * Rebuilds the structural draft chunks of a stored single-source contribution
 * with the source-scoped namespace. Contributions persisted before the
 * namespace fix carry colliding keys and would otherwise be re-merged with
 * them on every later materialization. Table rows and attachment evidence keep
 * their own deterministic identities and are passed through unchanged.
 *
 * Returns null when the contribution cannot be attributed to exactly one
 * source; callers keep it as stored rather than guessing a source.
 * Idempotent: rebuilding an already-normalized contribution yields the same
 * keys.
 */
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
