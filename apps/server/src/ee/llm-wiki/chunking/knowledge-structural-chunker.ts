import { createHash } from 'node:crypto';

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

export function chunkKnowledgeSource(input: {
  pageTitle: string;
  text: string;
  content?: unknown;
  maxChildCharacters?: number;
}): StructuralParentSection[] {
  const maxChildCharacters =
    input.maxChildCharacters ?? DEFAULT_MAX_CHILD_CHARACTERS;
  if (!Number.isInteger(maxChildCharacters) || maxChildCharacters <= 0) {
    throw new Error('maxChildCharacters must be a positive integer');
  }
  if (input.text.length === 0) return [];

  const structuredBlocks = blocksFromProseMirror(input.content, input.text);
  const blocks =
    structuredBlocks.length > 0
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
    const stableKey = digest(`parent|${pathIdentity}|${occurrence}`);
    const children = buildChildren({
      blocks: section.contentBlocks,
      source: input.text,
      pageTitle: input.pageTitle,
      headingPath: section.headingPath,
      parentStableKey: stableKey,
      maxChildCharacters,
    });
    const text = input.text.slice(bounds.startOffset, bounds.endOffset);

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
        ...splitRange(input.source, bounds, input.maxChildCharacters),
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
    const text = input.source.slice(range.startOffset, range.endOffset);
    const textIdentity = normalizeStableText(text);
    const occurrence = (childOccurrences.get(textIdentity) ?? 0) + 1;
    childOccurrences.set(textIdentity, occurrence);
    const stableKey = digest(
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
    const trimmed = trimRange(source, startOffset, endOffset);
    if (trimmed.startOffset < trimmed.endOffset) ranges.push(trimmed);
    startOffset = endOffset;
  }

  return ranges;
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

function quoteHash(value: string): string {
  return `sha256:${digest(value)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
