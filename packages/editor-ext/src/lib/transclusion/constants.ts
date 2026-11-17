export const TRANSCLUSION_SOURCE_ALLOWED_NODE_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'taskList',
  'image',
  'video',
  'audio',
  'attachment',
  'callout',
  'panel',
  'details',
  'embed',
  'mathBlock',
  'table',
  'drawio',
  'excalidraw',
  'pdf',
  'subpages',
  'columns',
  'youtube',
] as const;

export type TransclusionSourceAllowedNodeType =
  (typeof TRANSCLUSION_SOURCE_ALLOWED_NODE_TYPES)[number];

export const TRANSCLUSION_SOURCE_CONTENT_EXPRESSION = `(${TRANSCLUSION_SOURCE_ALLOWED_NODE_TYPES.join(' | ')})+`;
