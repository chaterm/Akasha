import { Attachment } from '@akasha/db/types/entity.types';
import {
  SerializedKnowledgeSource,
  SerializedKnowledgeSourceBlock,
  SourceAttachmentOccurrence,
} from '../types/source-snapshot.types';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { isImageAttachment } from './knowledge-attachment-image';
import { jsonToText } from '../../../collaboration/collaboration.util';
import { randomUUID } from 'node:crypto';

export const ATTACHMENT_MARKER_PREFIX = '[[AKASHA_ATTACHMENT:v1:';
export const ATTACHMENT_MARKER_SUFFIX = ']]';

export function attachmentMarker(attachmentId: string): string {
  return `${ATTACHMENT_MARKER_PREFIX}${attachmentId}${ATTACHMENT_MARKER_SUFFIX}`;
}

type SerializerPage = {
  id: string;
  workspaceId: string;
  spaceId: string;
  content: unknown;
};

const ATTACHMENT_NODE_TYPES = new Set([
  'attachment',
  'pdf',
  'audio',
  'video',
  'drawio',
  'excalidraw',
]);

export function serializeKnowledgeSource(input: {
  page: SerializerPage;
  attachmentsByPage: Attachment[];
}): SerializedKnowledgeSource {
  const { page } = input;
  const attachmentById = new Map(
    input.attachmentsByPage.map((attachment) => [attachment.id, attachment]),
  );

  const pendingOccurrences: PendingOccurrence[] = [];

  const transform = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    const type = typeof node.type === 'string' ? node.type : '';

    if (ATTACHMENT_NODE_TYPES.has(type)) {
      const attachment = resolveAttachment(node, attachmentById, page);
      if (attachment) {
        const ordinal = pendingOccurrences.length;
        const token = `AKASHA_SOURCE_ATTACHMENT_${ordinal}_${randomUUID()}`;
        const occurrence = {
          attachment,
          startToken: `\uE000${token}_START\uE001`,
          endToken: `\uE000${token}_END\uE001`,
        };
        pendingOccurrences.push(occurrence);
        return textBlock(
          `${occurrence.startToken}${attachment.fileName} ${attachmentMarker(attachment.id)}${occurrence.endToken}`,
        );
      }

      const attrs = isRecord(node.attrs) ? node.attrs : undefined;
      return typeof attrs?.name === 'string' ? textBlock(attrs.name) : node;
    }

    if (!Array.isArray(node.content)) return node;
    return { ...node, content: node.content.map(transform) };
  };

  if (!isRecord(page.content) || !Array.isArray(page.content.content)) {
    return { text: '', attachmentOccurrences: [], blocks: [] };
  }

  const transformedNodes = page.content.content.map(transform);
  const rawText = jsonToText({ type: 'doc', content: transformedNodes });
  const materialized = materializeOccurrences(
    rawText,
    pendingOccurrences,
    page.id,
  );
  const blocks = sourceBlocks({
    originalNodes: page.content.content,
    transformedNodes,
    pendingOccurrences,
    text: materialized.text,
  });

  return {
    text: materialized.text,
    attachmentOccurrences: materialized.occurrences,
    blocks,
  };
}

type PendingOccurrence = {
  attachment: Attachment;
  startToken: string;
  endToken: string;
};

function textBlock(text: string): Record<string, unknown> {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function materializeOccurrences(
  rawText: string,
  pending: PendingOccurrence[],
  sourcePageId: string,
): { text: string; occurrences: SourceAttachmentOccurrence[] } {
  const ordered = pending
    .map((occurrence) => ({
      occurrence,
      index: rawText.indexOf(occurrence.startToken),
    }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  const occurrences: SourceAttachmentOccurrence[] = [];
  let text = '';
  let cursor = 0;

  for (const { occurrence, index } of ordered) {
    if (index < cursor) continue;
    const payloadStart = index + occurrence.startToken.length;
    const payloadEnd = rawText.indexOf(occurrence.endToken, payloadStart);
    if (payloadEnd < 0) continue;
    text += rawText.slice(cursor, index);
    const startOffset = text.length;
    text += rawText.slice(payloadStart, payloadEnd);
    occurrences.push({
      attachmentId: occurrence.attachment.id,
      sourcePageId,
      attachmentUpdatedAt: occurrence.attachment.updatedAt.toISOString(),
      startOffset,
      endOffset: text.length,
    });
    cursor = payloadEnd + occurrence.endToken.length;
  }
  text += rawText.slice(cursor);
  return { text, occurrences };
}

function sourceBlocks(input: {
  originalNodes: unknown[];
  transformedNodes: unknown[];
  pendingOccurrences: PendingOccurrence[];
  text: string;
}): SerializedKnowledgeSourceBlock[] {
  const blocks: SerializedKnowledgeSourceBlock[] = [];
  let searchOffset = 0;

  for (const [index, node] of input.transformedNodes.entries()) {
    const rawBlock = jsonToText({ type: 'doc', content: [node] });
    const blockText = materializeOccurrences(
      rawBlock,
      input.pendingOccurrences,
      '',
    ).text;
    if (!blockText) continue;
    const startOffset = input.text.indexOf(blockText, searchOffset);
    if (startOffset < 0) {
      return [];
    }
    const endOffset = startOffset + blockText.length;
    blocks.push({
      startOffset,
      endOffset,
      ...sourceBlockMetadata(input.originalNodes[index], blockText),
    });
    searchOffset = endOffset;
  }
  return blocks;
}

const ATOMIC_BLOCK_TYPES = new Set([
  'table',
  'codeBlock',
  'callout',
  'blockquote',
  'details',
  'bulletList',
  'orderedList',
]);

function sourceBlockMetadata(
  node: unknown,
  serializedText: string,
): Omit<SerializedKnowledgeSourceBlock, 'startOffset' | 'endOffset'> {
  if (!isRecord(node)) return {};
  const type = typeof node.type === 'string' ? node.type : '';
  const attrs = isRecord(node.attrs) ? node.attrs : undefined;
  const level = type === 'heading' ? Number(attrs?.level) : NaN;

  return {
    ...(Number.isInteger(level) && level >= 1 && level <= 3
      ? { headingLevel: level, headingText: serializedText }
      : {}),
    ...(ATOMIC_BLOCK_TYPES.has(type) ? { atomic: true } : {}),
  };
}

function resolveAttachment(
  node: Record<string, unknown>,
  attachmentById: Map<string, Attachment>,
  page: SerializerPage,
): Attachment | undefined {
  const attrs = isRecord(node.attrs) ? node.attrs : undefined;
  const attachmentId =
    typeof attrs?.attachmentId === 'string' ? attrs.attachmentId.trim() : '';
  if (!attachmentId) return undefined;

  const attachment = attachmentById.get(attachmentId);
  if (
    !attachment ||
    attachment.type !== AttachmentType.File ||
    attachment.workspaceId !== page.workspaceId ||
    attachment.spaceId !== page.spaceId ||
    attachment.pageId !== page.id ||
    attachment.deletedAt ||
    isImageAttachment(attachment)
  ) {
    return undefined;
  }
  return attachment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
