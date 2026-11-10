export interface KnowledgeSourceSnapshot {
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  /**
   * Hash of the source, compiler inputs, and ordered ready image knowledge.
   * It is distinct from contentHash, which remains the raw source-version
   * fence.
   */
  effectiveKnowledgeHash?: string;
  title: string;
  text: string;
  content?: unknown;
  images?: KnowledgeSourceImage[];
  attachmentOccurrences?: SourceAttachmentOccurrence[];
  /**
   * The Knowledge-specific serialization of the page with attachment markers
   * emitted at each real attachment node. Offsets in `attachmentOccurrences`
   * are relative to THIS text, not `text` (which stays the marker-free
   * jsonToText body used for the source content hash and existing chunking).
   * Only populated when the page has trusted attachment occurrences so pages
   * without attachments are never enlarged. Consumed by the compiler runners to
   * produce deterministic, verifiable attachment evidence chunks.
   */
  attachmentSerializedText?: string;
  /**
   * Structural boundaries of `attachmentSerializedText`. They are emitted by
   * the same traversal as attachment occurrences so deterministic attachment
   * chunking does not have to rediscover page structure from flattened text.
   */
  attachmentSerializedBlocks?: SerializedKnowledgeSourceBlock[];
  references: KnowledgeSourceReference[];
}

/**
 * A single in-position occurrence of a page-owned, non-image file attachment
 * captured while serializing the source for Knowledge compilation.
 *
 * Offsets use JS string UTF-16 counting over the serializer-produced text and
 * describe the half-open range [startOffset, endOffset). The range covers the
 * emitted "file name + marker" span so the marker is always contained inside a
 * single occurrence, letting the structural chunker treat it as unsplittable.
 */
export type SourceAttachmentOccurrence = {
  attachmentId: string;
  sourcePageId: string;
  attachmentUpdatedAt: string;
  startOffset: number;
  endOffset: number;
};

/**
 * The Knowledge-specific serialization of a page: text with attachment markers
 * emitted at each real attachment node, the trusted occurrence ranges for
 * those markers, and the top-level block ranges the structural chunker can use
 * directly instead of guessing node positions with indexOf.
 */
export type SerializedKnowledgeSourceBlock = {
  startOffset: number;
  endOffset: number;
  headingLevel?: number;
  headingText?: string;
  atomic?: boolean;
};

export type SerializedKnowledgeSource = {
  text: string;
  attachmentOccurrences: SourceAttachmentOccurrence[];
  blocks: SerializedKnowledgeSourceBlock[];
};

/**
 * A page-owned image reference captured as part of the source snapshot.
 *
 * The binary remains in Akasha storage. The snapshot only carries enough
 * identity and version information to fence image enrichment against page and
 * attachment changes while a compile job is running.
 */
export interface KnowledgeSourceImage {
  attachmentId: string;
  fileName: string;
  /**
   * The attachment's declared safe raster type. The enrichment boundary still
   * verifies the bytes and normalizes non-JPEG/PNG images before calling the
   * vision provider. Active formats such as SVG are deliberately excluded.
   */
  mimeType: KnowledgeSourceImageMimeType;
  fileSize: number | null;
  attachmentVersion: string;
  altText?: string;
}

export type KnowledgeSourceImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/apng'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/tiff'
  | 'image/bmp';

export interface KnowledgeSourceReference {
  sourcePageId: string;
  targetPageId: string;
  targetSpaceId: string;
  kind: 'same_space_reference' | 'cross_space_reference' | 'transclusion';
  mode: 'opaque' | 'expanded';
}
