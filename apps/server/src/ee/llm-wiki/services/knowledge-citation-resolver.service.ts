import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  KnowledgeCapsuleRepo,
  KnowledgeChunkSourceRef,
} from '@docmost/db/repos/llm-wiki/knowledge-capsule.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { KnowledgeChunk, KnowledgePage } from '@docmost/db/types/entity.types';
import {
  KnowledgeCitation,
  KnowledgeSourceWindow,
} from './knowledge-context-pack.service';
import { KnowledgeSourceRange } from '../types/knowledge.types';
import { KnowledgeRetrievalResult } from './knowledge-retrieval.service';
import { KnowledgeSourceAuthorizationService } from './knowledge-source-authorization.service';

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

    return input.chunks.map((entry) => ({
      chunk: entry.chunk,
      pageTitle: entry.page.title,
      retrievalReasons: entry.rankReasons,
      warnings: [],
      citations: entry.sourcePageIds
        .map((sourcePageId) => pagesById.get(sourcePageId))
        .filter(Boolean)
        .map((page) => citationForPage(page)),
      sourceWindows: buildSourceWindows(
        sourceRefsByChunkId.get(entry.chunk.id) ?? [],
        pagesById,
      ),
    }));
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
