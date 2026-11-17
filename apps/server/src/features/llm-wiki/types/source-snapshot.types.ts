export interface KnowledgeSourceSnapshot {
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  effectiveKnowledgeHash?: string;
  title: string;
  text: string;
  content?: unknown;
  images?: KnowledgeSourceImage[];
  attachmentOccurrences?: SourceAttachmentOccurrence[];
  attachmentSerializedText?: string;
  attachmentSerializedBlocks?: SerializedKnowledgeSourceBlock[];
  references: KnowledgeSourceReference[];
}

export type SourceAttachmentOccurrence = {
  attachmentId: string;
  sourcePageId: string;
  attachmentUpdatedAt: string;
  startOffset: number;
  endOffset: number;
};

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

export interface KnowledgeSourceImage {
  attachmentId: string;
  fileName: string;
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
