import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  KnowledgeCapsuleRepo,
  KnowledgeChunkSourceRef,
} from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { KnowledgeChunk, KnowledgePage } from '@akasha/db/types/entity.types';
import {
  KnowledgeCitation,
  KnowledgeSourceWindow,
} from './knowledge-context-pack.service';
import { KnowledgeSourceRange } from '../types/knowledge.types';
import { KnowledgeRetrievalResult } from './knowledge-retrieval.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeSourceChunk } from '@akasha/db/types/entity.types';
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';

const MIN_RAW_EVIDENCE_SCORE = 2;

type CapsuleCitationEntry = {
  capsule: KnowledgePage;
  citations: KnowledgeCitation[];
};

type ChunkCitationEntry = {
  chunk: KnowledgeChunk;
  pageTitle: string;
  citations: KnowledgeCitation[];
  retrievalReasons: string[];
  sourceWindows: KnowledgeSourceWindow[];
  warnings: string[];
};

type ReadableSourcePage = {
  id: string;
  title: string;
  slugId: string;
  textContent?: string | null;
};

@Injectable()
export class KnowledgeCitationResolverService {
  constructor(
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly sourceAuthorization: KnowledgeSourceAuthorizationService,
    private readonly pageRepo: PageRepo,
    @Optional() private readonly sourceRepo?: KnowledgeSourceRepo,
  ) {}

  async resolveForCapsules(input: {
    workspaceId: string;
    userId: string;
    capsules: KnowledgePage[];
  }): Promise<CapsuleCitationEntry[]> {
    const readableSourceIdsByCapsule = new Map<string, string[]>();
    const allReadableSourceIds = new Set<string>();

    for (const capsule of input.capsules) {
      const sourcePageIds = await this.capsuleRepo.findDependencySourcePageIds({
        workspaceId: input.workspaceId,
        knowledgePageIds: [capsule.id],
      });
      const readableSourcePageIds =
        await this.sourceAuthorization.filterReadableSources({
          workspaceId: input.workspaceId,
          userId: input.userId,
          sourcePageIds,
        });

      readableSourceIdsByCapsule.set(capsule.id, readableSourcePageIds);
      readableSourcePageIds.forEach((sourceId) =>
        allReadableSourceIds.add(sourceId),
      );
    }

    const pagesById = await this.findReadableSourcePages(
      [...allReadableSourceIds],
      input.workspaceId,
      false,
    );

    return input.capsules.map((capsule) => ({
      capsule,
      citations: (readableSourceIdsByCapsule.get(capsule.id) ?? [])
        .map((sourcePageId) => pagesById.get(sourcePageId))
        .filter(Boolean)
        .map((page) => ({
          sourcePageId: page.id,
          title: page.title,
          url: `/p/${page.slugId}`,
        })),
    }));
  }

  async resolveForChunks(input: {
    workspaceId: string;
    query?: string;
    chunks: KnowledgeRetrievalResult['chunks'];
  }): Promise<ChunkCitationEntry[]> {
    const allSourcePageIds = unique(
      input.chunks.flatMap((entry) => entry.sourcePageIds),
    );
    const pagesById = await this.findReadableSourcePages(
      allSourcePageIds,
      input.workspaceId,
      true,
    );
    const sourceRefsByChunkId = await this.findChunkSourceRefsByChunkId({
      workspaceId: input.workspaceId,
      chunks: input.chunks,
      readableSourcePageIds: allSourcePageIds,
    });
    const rawSourceWindowsByPageId = await this.findRawSourceWindows({
      workspaceId: input.workspaceId,
      query: input.query ?? '',
      sourcePageIds: allSourcePageIds,
      pagesById,
    });

    return input.chunks.map((entry) => ({
      chunk: entry.parentSection
        ? { ...entry.chunk, text: entry.parentSection.text }
        : entry.chunk,
      pageTitle: entry.page.title,
      retrievalReasons: entry.rankReasons,
      warnings: [],
      citations: entry.sourcePageIds
        .map((sourcePageId) => pagesById.get(sourcePageId))
        .filter(Boolean)
        .map((page) => citationForPage(page)),
      sourceWindows: mergeSourceWindows([
        ...buildSourceWindows(
          sourceRefsByChunkId.get(entry.chunk.id) ?? [],
          pagesById,
        ),
        ...entry.sourcePageIds.flatMap(
          (sourcePageId) => rawSourceWindowsByPageId.get(sourcePageId) ?? [],
        ),
      ]),
    }));
  }

  private async findRawSourceWindows(input: {
    workspaceId: string;
    query: string;
    sourcePageIds: string[];
    pagesById: Map<string, ReadableSourcePage>;
  }): Promise<Map<string, KnowledgeSourceWindow[]>> {
    if (!input.query.trim() || input.sourcePageIds.length === 0) {
      return new Map();
    }

    const storedChunks = this.sourceRepo
      ? await this.sourceRepo.findSourceChunksByPageIds({
          workspaceId: input.workspaceId,
          sourcePageIds: input.sourcePageIds,
          limit: 200,
        })
      : [];
    const storedPageIds = new Set(
      storedChunks.map((chunk) => chunk.sourcePageId),
    );
    const fallbackChunks = input.sourcePageIds.flatMap((sourcePageId) => {
      if (storedPageIds.has(sourcePageId)) return [];
      const page = input.pagesById.get(sourcePageId);
      if (!page || typeof page.textContent !== 'string') return [];
      return chunkKnowledgeSource({
        pageTitle: page.title,
        text: page.textContent,
      }).flatMap((parent) =>
        parent.children.map(
          (child): KnowledgeSourceChunk => ({
            id: `${sourcePageId}:${child.stableKey}`,
            workspaceId: input.workspaceId,
            sourceId: sourcePageId,
            sourcePageId,
            text: child.text,
            contentHash: child.quoteHash,
            sourceRange: {
              startOffset: child.startOffset,
              endOffset: child.endOffset,
            },
            quoteHash: child.quoteHash,
            createdAt: new Date(0),
          }),
        ),
      );
    });

    return rankRawSourceWindows(
      input.query,
      [...storedChunks, ...fallbackChunks],
      input.pagesById,
    );
  }

  private async findChunkSourceRefsByChunkId(input: {
    workspaceId: string;
    chunks: KnowledgeRetrievalResult['chunks'];
    readableSourcePageIds: string[];
  }): Promise<Map<string, KnowledgeChunkSourceRef[]>> {
    if (input.chunks.length === 0 || input.readableSourcePageIds.length === 0) {
      return new Map();
    }

    const readableSourceSet = new Set(input.readableSourcePageIds);
    const rows = await this.capsuleRepo.findChunkSourceRefsByChunkIds({
      workspaceId: input.workspaceId,
      chunkIds: input.chunks.map((entry) => entry.chunk.id),
    });

    return new Map(
      rows.map((row) => [
        row.chunkId,
        row.sources.filter((source) =>
          readableSourceSet.has(source.sourcePageId),
        ),
      ]),
    );
  }

  private async findReadableSourcePages(
    sourcePageIds: string[],
    workspaceId: string,
    includeTextContent: boolean,
  ): Promise<Map<string, ReadableSourcePage>> {
    if (sourcePageIds.length === 0) {
      return new Map();
    }

    const pages = await this.pageRepo.findManyByIds(
      sourcePageIds,
      includeTextContent
        ? { workspaceId, includeTextContent: true }
        : { workspaceId },
    );

    return new Map(
      pages.map((page) => [
        page.id,
        {
          id: page.id,
          title: page.title ?? 'Untitled',
          slugId: page.slugId,
          textContent: page.textContent,
        },
      ]),
    );
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function buildSourceWindows(
  sourceRefs: KnowledgeChunkSourceRef[],
  pagesById: Map<string, ReadableSourcePage>,
): KnowledgeSourceWindow[] {
  const windows: KnowledgeSourceWindow[] = [];
  const seen = new Set<string>();

  for (const sourceRef of sourceRefs) {
    const page = pagesById.get(sourceRef.sourcePageId);
    const sourceRange = parseSourceRange(sourceRef.sourceRange);
    if (
      !page ||
      !sourceRange ||
      !sourceRef.quoteHash ||
      typeof page.textContent !== 'string' ||
      !isValidSourceRange(sourceRange, page.textContent)
    ) {
      continue;
    }

    const text = page.textContent.slice(
      sourceRange.startOffset,
      sourceRange.endOffset,
    );
    if (hashQuote(text) !== sourceRef.quoteHash) {
      continue;
    }

    const key = `${sourceRef.sourcePageId}:${sourceRange.startOffset}:${sourceRange.endOffset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({
      ...citationForPage(page),
      text,
      sourceRange,
      quoteHash: sourceRef.quoteHash,
    });
  }

  return windows;
}

function rankRawSourceWindows(
  query: string,
  chunks: KnowledgeSourceChunk[],
  pagesById: Map<string, ReadableSourcePage>,
): Map<string, KnowledgeSourceWindow[]> {
  const queryTerms = extractSearchTerms(query);
  const ranked = chunks
    .flatMap((chunk) => {
      const page = pagesById.get(chunk.sourcePageId);
      const sourceRange = parseSourceRange(chunk.sourceRange);
      if (
        !page ||
        !sourceRange ||
        !chunk.quoteHash ||
        typeof page.textContent !== 'string' ||
        !isValidSourceRange(sourceRange, page.textContent)
      ) {
        return [];
      }
      const text = page.textContent.slice(
        sourceRange.startOffset,
        sourceRange.endOffset,
      );
      if (hashQuote(text) !== chunk.quoteHash) return [];
      const score = scoreSearchText(queryTerms, text);
      if (score < MIN_RAW_EVIDENCE_SCORE) return [];

      return [
        {
          score,
          window: {
            ...citationForPage(page),
            text,
            sourceRange,
            quoteHash: chunk.quoteHash,
          },
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.window.sourceRange.startOffset -
          right.window.sourceRange.startOffset,
    );
  const result = new Map<string, KnowledgeSourceWindow[]>();
  for (const entry of ranked) {
    const windows = result.get(entry.window.sourcePageId) ?? [];
    if (windows.length >= 2) continue;
    windows.push(entry.window);
    result.set(entry.window.sourcePageId, windows);
  }
  return result;
}

function extractSearchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  const asciiStopWords = new Set([
    'and',
    'are',
    'for',
    'how',
    'is',
    'the',
    'what',
    'when',
    'where',
    'which',
    'who',
    'why',
  ]);
  const ascii = (normalized.match(/[a-z0-9_./:-]{2,}/g) ?? []).filter(
    (term) => !asciiStopWords.has(term),
  );
  const hanSegments = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const hanStopWords = new Set([
    '上的',
    '的是',
    '什么',
    '如何',
    '多少',
    '时候',
    '一下',
    '今天',
    '是多',
  ]);
  const hanBigrams = hanSegments.flatMap((segment) =>
    Array.from({ length: Math.max(0, segment.length - 1) }, (_, index) =>
      segment.slice(index, index + 2),
    ).filter((term) => !hanStopWords.has(term)),
  );
  return unique([...ascii, ...hanBigrams]);
}

function scoreSearchText(queryTerms: string[], text: string): number {
  if (queryTerms.length === 0) return 0;
  const normalized = normalizeSearchText(text);
  return queryTerms.reduce((score, term) => {
    if (!normalized.includes(term)) return score;
    const exactIdentifier = /[/_.:-]/.test(term) || /[a-z]+\d*/.test(term);
    return score + (exactIdentifier ? 4 : 1);
  }, 0);
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function mergeSourceWindows(
  windows: KnowledgeSourceWindow[],
): KnowledgeSourceWindow[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    const key = `${window.sourcePageId}:${window.sourceRange.startOffset}:${window.sourceRange.endOffset}:${window.quoteHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function citationForPage(page: ReadableSourcePage): KnowledgeCitation {
  return {
    sourcePageId: page.id,
    title: page.title,
    url: `/p/${page.slugId}`,
  };
}

function parseSourceRange(value: unknown): KnowledgeSourceRange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.startOffset) ||
    !Number.isInteger(record.endOffset)
  ) {
    return null;
  }

  return {
    startOffset: record.startOffset as number,
    endOffset: record.endOffset as number,
  };
}

function isValidSourceRange(
  range: KnowledgeSourceRange,
  text: string,
): boolean {
  return (
    range.startOffset >= 0 &&
    range.endOffset > range.startOffset &&
    range.endOffset <= text.length
  );
}

function hashQuote(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}
