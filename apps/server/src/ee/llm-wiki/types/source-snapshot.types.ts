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
  references: KnowledgeSourceReference[];
}

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
