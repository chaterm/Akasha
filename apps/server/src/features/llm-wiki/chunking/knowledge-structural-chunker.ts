import { createHash } from 'node:crypto';
import { SerializedKnowledgeSourceBlock } from '../types/source-snapshot.types';

export type StructuralChildChunk = {
  stableKey: string;
  text: string;
  embeddingText: string;
  startOffset: number;
  endOffset: number;
  quoteHash: string;
};

export type StructuralParentSection = {
  stableKey: string;
  headingPath: string[];
  text: string;
  startOffset: number;
  endOffset: number;
  quoteHash: string;
  children: StructuralChildChunk[];
};

type SourceBlock = {
  text: string;
  startOffset: number;
  endOffset: number;
  headingLevel?: number;
  headingText?: string;
  atomic?: boolean;
};

const DEFAULT_MAX_CHILD_CHARACTERS = 900;

type OccurrenceRange = { startOffset: number; endOffset: number };

export function chunkKnowledgeSource(input: {
  pageTitle: string;
  text: string;
  content?: unknown;
  maxChildCharacters?: number;
  attachmentOccurrences?: OccurrenceRange[];
  /** Trusted structural blocks from the attachment serializer's text basis. */
  sourceBlocks?: SerializedKnowledgeSourceBlock[];
  stableKeyNamespace?: string;
}): StructuralParentSection[] {
  const maxChildCharacters =
    input.maxChildCharacters ?? DEFAULT_MAX_CHILD_CHARACTERS;
  if (!Number.isInteger(maxChildCharacters) || maxChildCharacters <= 0) {
    throw new Error('maxChildCharacters must be a positive integer');
  }
  if (input.text.length === 0) return [];

  const occurrences = normalizeOccurrences(input.attachmentOccurrences);
  const stableKeyOf = (identity: string): string => {
    if (!input.stableKeyNamespace) return digest(identity);
    // Stable keys are persisted in varchar(64). Preserve a readable source
    // namespace for diagnostics while retaining a deterministic digest suffix.
    const prefix = `${input.stableKeyNamespace}:`;
    return `${prefix}${digest(identity).slice(0, 64 - prefix.length)}`;
  };

  const serializedBlocks = blocksFromSerializedSource(
    input.sourceBlocks,
    input.text,
  );
  const structuredBlocks = blocksFromProseMirror(input.content, input.text);
  const blocks =
    serializedBlocks.length > 0
      ? serializedBlocks
      : structuredBlocks.length > 0
        ? structuredBlocks
        : blocksFromMarkdown(input.text);
  const sections = sectionBlocks(blocks, input.text.length);
  const pathOccurrences = new Map<string, number>();

  return sections.flatMap((section) => {
    const bounds = trimRange(
      input.text,
      section.startOffset,
      section.endOffset,
    );
    if (bounds.startOffset >= bounds.endOffset) return [];

    const pathIdentity = section.headingPath.join('\u001f') || '(intro)';
    const occurrence = (pathOccurrences.get(pathIdentity) ?? 0) + 1;
    pathOccurrences.set(pathIdentity, occurrence);
    const stableKey = stableKeyOf(`parent|${pathIdentity}|${occurrence}`);
    const children = buildChildren({
      blocks: section.contentBlocks,
      source: input.text,
      pageTitle: input.pageTitle,
      headingPath: section.headingPath,
      parentStableKey: stableKey,
      maxChildCharacters,
      occurrences,
      stableKeyOf,
    });
    const text = cleanMarkers(
      input.text,
      bounds.startOffset,
      bounds.endOffset,
      occurrences,
    );

    return [
      {
        stableKey,
        headingPath: section.headingPath,
        text,
        startOffset: bounds.startOffset,
        endOffset: bounds.endOffset,
        quoteHash: quoteHash(text),
        children,
      },
    ];
  });
}

function sectionBlocks(blocks: SourceBlock[], sourceEnd: number) {
  const sections: Array<{
    headingPath: string[];
    startOffset: number;
    endOffset: number;
    contentBlocks: SourceBlock[];
  }> = [];
  const headingStack: string[] = [];
  let current: (typeof sections)[number] | undefined;

  for (const block of blocks) {
    if (block.headingLevel && block.headingText) {
      if (current) current.endOffset = block.startOffset;
      headingStack.length = Math.max(0, block.headingLevel - 1);
      headingStack[block.headingLevel - 1] = block.headingText;
      current = {
        headingPath: headingStack.filter(Boolean),
        startOffset: block.startOffset,
        endOffset: sourceEnd,
        contentBlocks: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = {
        headingPath: [],
        startOffset: block.startOffset,
        endOffset: sourceEnd,
        contentBlocks: [],
      };
      sections.push(current);
    }
    current.contentBlocks.push(block);
  }

  return sections;
}

function buildChildren(input: {
  blocks: SourceBlock[];
  source: string;
  pageTitle: string;
  headingPath: string[];
  parentStableKey: string;
  maxChildCharacters: number;
  occurrences: OccurrenceRange[];
  stableKeyOf: (identity: string) => string;
}): StructuralChildChunk[] {
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];
  let group: { startOffset: number; endOffset: number } | undefined;

  const flush = () => {
    if (group) ranges.push(group);
    group = undefined;
  };

  for (const block of input.blocks) {
    const bounds = trimRange(input.source, block.startOffset, block.endOffset);
    if (bounds.startOffset >= bounds.endOffset) continue;
    const length = bounds.endOffset - bounds.startOffset;

    if (length > input.maxChildCharacters) {
      flush();
      ranges.push(
        ...splitRange(
          input.source,
          bounds,
          input.maxChildCharacters,
          input.occurrences,
        ),
      );
      continue;
    }

    if (!group) {
      group = bounds;
      continue;
    }
    const combinedLength = bounds.endOffset - group.startOffset;
    if (block.atomic || combinedLength > input.maxChildCharacters) {
      flush();
      group = bounds;
    } else {
      group.endOffset = bounds.endOffset;
    }
  }
  flush();

  const childOccurrences = new Map<string, number>();
  return ranges.map((range) => {
    const text = cleanMarkers(
      input.source,
      range.startOffset,
      range.endOffset,
      input.occurrences,
    );
    const textIdentity = normalizeStableText(text);
    const occurrence = (childOccurrences.get(textIdentity) ?? 0) + 1;
    childOccurrences.set(textIdentity, occurrence);
    const stableKey = input.stableKeyOf(
      `child|${input.parentStableKey}|${textIdentity}|${occurrence}`,
    );
    const breadcrumb = [input.pageTitle, ...input.headingPath]
      .filter(Boolean)
      .join(' > ');

    return {
      stableKey,
      text,
      embeddingText: breadcrumb ? `${breadcrumb}\n\n${text}` : text,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      quoteHash: quoteHash(text),
    };
  });
}

function splitRange(
  source: string,
  range: { startOffset: number; endOffset: number },
  maxLength: number,
  occurrences: OccurrenceRange[] = [],
): Array<{ startOffset: number; endOffset: number }> {
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];
  let startOffset = range.startOffset;

  while (startOffset < range.endOffset) {
    let endOffset = Math.min(startOffset + maxLength, range.endOffset);
    if (endOffset < range.endOffset) {
      const window = source.slice(startOffset, endOffset);
      const preferredBreak = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('。') + 1,
        window.lastIndexOf('. ') + 1,
        window.lastIndexOf('；') + 1,
      );
      if (preferredBreak >= Math.floor(maxLength * 0.5)) {
        endOffset = startOffset + preferredBreak;
      }
    }
    // A marker is an unsplittable unit: never cut inside an occurrence. Move
    // the boundary before the marker when possible, otherwise past it.
    endOffset = avoidSplittingOccurrences(endOffset, startOffset, occurrences);
    const trimmed = trimRange(source, startOffset, endOffset);
    if (trimmed.startOffset < trimmed.endOffset) ranges.push(trimmed);
    startOffset = endOffset;
  }

  return ranges;
}

/**
 * Returns an end boundary that does not fall strictly inside any occurrence. If
 * a boundary lands inside `[start, end)`, it is pulled back to the
 * occurrence's start; when that would produce an empty slice (the occurrence
 * begins at or before the chunk start), it is pushed past the occurrence end
 * so the whole marker stays in a single chunk.
 */
function avoidSplittingOccurrences(
  endOffset: number,
  startOffset: number,
  occurrences: OccurrenceRange[],
): number {
  let adjusted = endOffset;
  for (const occurrence of occurrences) {
    if (adjusted > occurrence.startOffset && adjusted < occurrence.endOffset) {
      adjusted =
        occurrence.startOffset > startOffset
          ? occurrence.startOffset
          : occurrence.endOffset;
    }
  }
  return adjusted;
}

function blocksFromProseMirror(
  content: unknown,
  source: string,
): SourceBlock[] {
  if (!isRecord(content) || !Array.isArray(content.content)) return [];

  const blocks: SourceBlock[] = [];
  let cursor = 0;
  for (const node of content.content) {
    if (!isRecord(node)) continue;
    const text = nodeText(node).trim();
    if (!text) continue;
    const startOffset = source.indexOf(text, cursor);
    if (startOffset < 0) return [];
    const endOffset = startOffset + text.length;
    cursor = endOffset;
    const level =
      node.type === 'heading' && isRecord(node.attrs)
        ? Number(node.attrs.level)
        : undefined;

    blocks.push({
      text,
      startOffset,
      endOffset,
      headingLevel:
        level && Number.isInteger(level) && level >= 1 && level <= 3
          ? level
          : undefined,
      headingText: node.type === 'heading' ? text : undefined,
      atomic: isAtomicNodeType(String(node.type ?? '')),
    });
  }

  return blocks;
}

function blocksFromSerializedSource(
  blocks: SerializedKnowledgeSourceBlock[] | undefined,
  source: string,
): SourceBlock[] {
  if (!blocks?.length) return [];

  const result: SourceBlock[] = [];
  let previousEnd = 0;
  for (const block of blocks) {
    if (
      !Number.isInteger(block.startOffset) ||
      !Number.isInteger(block.endOffset) ||
      block.startOffset < previousEnd ||
      block.endOffset <= block.startOffset ||
      block.endOffset > source.length
    ) {
      return [];
    }
    result.push({
      text: source.slice(block.startOffset, block.endOffset),
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      headingLevel: block.headingLevel,
      headingText: block.headingText,
      atomic: block.atomic,
    });
    previousEnd = block.endOffset;
  }
  return result;
}

function nodeText(node: Record<string, unknown>): string {
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  const separator = ['bulletList', 'orderedList', 'table'].includes(
    String(node.type),
  )
    ? '\n'
    : '';
  return node.content
    .filter(isRecord)
    .map(nodeText)
    .filter(Boolean)
    .join(separator);
}

function isAtomicNodeType(type: string): boolean {
  return [
    'table',
    'codeBlock',
    'callout',
    'blockquote',
    'details',
    'bulletList',
    'orderedList',
  ].includes(type);
}

function blocksFromMarkdown(source: string): SourceBlock[] {
  const lines = sourceLines(source);
  const blocks: SourceBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].text.trim().length === 0) {
      index++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[index].text);
    if (heading) {
      blocks.push({
        text: lines[index].text,
        startOffset: lines[index].startOffset,
        endOffset: lines[index].contentEndOffset,
        headingLevel: heading[1].length,
        headingText: heading[2],
      });
      index++;
      continue;
    }

    const start = index;
    let atomic = false;
    if (/^\s*```/.test(lines[index].text)) {
      atomic = true;
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index].text))
        index++;
      if (index < lines.length) index++;
    } else if (/^\s*\|/.test(lines[index].text)) {
      atomic = true;
      while (index < lines.length && /^\s*\|/.test(lines[index].text)) index++;
    } else if (/^\s*>/.test(lines[index].text)) {
      atomic = true;
      while (index < lines.length && /^\s*>/.test(lines[index].text)) index++;
    } else if (/^\s*(?:[-*+] |\d+[.)] )/.test(lines[index].text)) {
      atomic = true;
      while (
        index < lines.length &&
        /^\s*(?:[-*+] |\d+[.)] )/.test(lines[index].text)
      )
        index++;
    } else {
      index++;
      while (
        index < lines.length &&
        lines[index].text.trim().length > 0 &&
        !/^(?:#{1,3})\s+/.test(lines[index].text) &&
        !/^\s*(?:```|\||>|[-*+] |\d+[.)] )/.test(lines[index].text)
      )
        index++;
    }

    const last = lines[index - 1];
    const startOffset = lines[start].startOffset;
    const endOffset = last.contentEndOffset;
    blocks.push({
      text: source.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      atomic,
    });
  }

  return blocks;
}

function sourceLines(source: string) {
  const lines: Array<{
    text: string;
    startOffset: number;
    contentEndOffset: number;
  }> = [];
  let startOffset = 0;
  for (const part of source.split('\n')) {
    lines.push({
      text: part,
      startOffset,
      contentEndOffset: startOffset + part.length,
    });
    startOffset += part.length + 1;
  }
  return lines;
}

function trimRange(source: string, startOffset: number, endOffset: number) {
  while (startOffset < endOffset && /\s/.test(source[startOffset]))
    startOffset++;
  while (endOffset > startOffset && /\s/.test(source[endOffset - 1]))
    endOffset--;
  return { startOffset, endOffset };
}

function normalizeStableText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

const ATTACHMENT_MARKER_PREFIX_WITH_SPACE = ' [[AKASHA_ATTACHMENT:v1:';
const ATTACHMENT_MARKER_SUFFIX = ']]';

/**
 * Removes compile-time attachment markers only from trusted occurrence ranges,
 * keeping the preceding file name and consuming the separator space. Marker-
 * shaped text typed by a user outside a real attachment node remains ordinary
 * content. Applied to both `text` and `embeddingText`; `quoteHash` is recomputed
 * from the cleaned text so display, hash and vector input stay consistent.
 */
function cleanMarkers(
  source: string,
  startOffset: number,
  endOffset: number,
  occurrences: OccurrenceRange[],
): string {
  let value = source.slice(startOffset, endOffset);
  const contained = occurrences
    .filter(
      (occurrence) =>
        occurrence.startOffset >= startOffset &&
        occurrence.endOffset <= endOffset,
    )
    .sort((a, b) => b.startOffset - a.startOffset);

  for (const occurrence of contained) {
    const localStart = occurrence.startOffset - startOffset;
    const localEnd = occurrence.endOffset - startOffset;
    const occurrenceText = value.slice(localStart, localEnd);
    const markerStart = occurrenceText.lastIndexOf(
      ATTACHMENT_MARKER_PREFIX_WITH_SPACE,
    );
    if (markerStart < 0 || !occurrenceText.endsWith(ATTACHMENT_MARKER_SUFFIX)) {
      continue;
    }
    value = value.slice(0, localStart + markerStart) + value.slice(localEnd);
  }
  return value;
}

function normalizeOccurrences(
  occurrences: OccurrenceRange[] | undefined,
): OccurrenceRange[] {
  if (!occurrences || occurrences.length === 0) return [];
  return [...occurrences].sort((a, b) => a.startOffset - b.startOffset);
}

function quoteHash(value: string): string {
  return `sha256:${digest(value)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
