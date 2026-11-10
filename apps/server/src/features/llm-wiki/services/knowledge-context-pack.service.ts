import { Injectable } from '@nestjs/common';
import { KnowledgeChunk, KnowledgePage } from '@akasha/db/types/entity.types';
import { KnowledgeSourceRange } from '../types/knowledge.types';
import {
  KNOWLEDGE_COMPLETENESS_NOTICE,
  KnowledgeRetrievalAuthorizationMode,
  KnowledgeRetrievalOrigin,
  KnowledgeRetrievalResult,
} from './knowledge-retrieval.service';

const MAX_CONTEXT_LENGTH = 12_000;

export type KnowledgeCitation = {
  sourcePageId: string;
  title: string;
  url: string;
};

/**
 * Image attached to a query-API citation. Only produced at the
 * `/api/llm-wiki/query` response boundary; never part of the shared
 * `KnowledgeCitation` / `KnowledgeSourceWindow` / evidence types.
 */
export type KnowledgeQueryCitationImage = {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  url: string;
  description: string;
};

/**
 * Citation shape returned exclusively by `/api/llm-wiki/query`. Derives from
 * the base `KnowledgeCitation` and always carries an `images` array (possibly
 * empty). Kept separate so adding images never leaks into `sourceWindows`,
 * `retrievedSources` or `citationEvidence`.
 */
export type KnowledgeQueryCitation = KnowledgeCitation & {
  images: KnowledgeQueryCitationImage[];
};

export type KnowledgeSourceWindow = KnowledgeCitation & {
  text: string;
  sourceRange: KnowledgeSourceRange;
  quoteHash: string;
};

export type KnowledgeContextPrimary = {
  id: string;
  kind: 'capsule' | 'chunk';
  /** chunk 所属的 knowledge page；capsule 本身就是 page，取自身 id。 */
  knowledgePageId: string;
  /** 检索路径：直接召回还是图扩展。与 retrievalReasons 的匹配方式正交。 */
  origin: KnowledgeRetrievalOrigin;
  /** 授权路径：策略放行还是最终兜底。同样与匹配方式正交。 */
  authorizationMode: KnowledgeRetrievalAuthorizationMode;
  title: string;
  text: string;
  citationSourcePageIds: string[];
  retrievalReasons: string[];
  sourceWindows: KnowledgeSourceWindow[];
};

export type KnowledgeContextBudget = {
  maxContextLength: number;
  usedContextLength: number;
  remainingContextLength: number;
  includedItemCount: number;
  omittedItemCount: number;
  responseReserve: number;
  perItemMaxLength: number;
};

export type KnowledgeContextPackingItem = {
  itemId: string;
  kind: 'chunk' | 'capsule';
  sourcePageIds?: string[];
  disposition: 'included' | 'clipped' | 'omitted';
  originalChars: number;
  includedChars: number;
};

export type KnowledgeContextPackInput = {
  budget?: {
    totalContextLength?: number;
    responseReserve?: number;
    perItemMaxLength?: number;
  };
  capsules?: Array<{
    capsule: KnowledgeRetrievalResult['capsules'][number] | KnowledgePage;
    citations?: KnowledgeCitation[];
    retrievalReasons?: string[];
    warnings?: string[];
    sourceWindows?: KnowledgeSourceWindow[];
  }>;
  chunks?: Array<{
    chunk: KnowledgeChunk;
    pageTitle: string;
    origin?: KnowledgeRetrievalOrigin;
    authorizationMode?: KnowledgeRetrievalAuthorizationMode;
    citations?: KnowledgeCitation[];
    retrievalReasons?: string[];
    warnings?: string[];
    sourceWindows?: KnowledgeSourceWindow[];
  }>;
};

export type KnowledgeContextPack = {
  context: string;
  primary: KnowledgeContextPrimary[];
  citations: KnowledgeCitation[];
  warnings: string[];
  budget: KnowledgeContextBudget;
  packing: { items: KnowledgeContextPackingItem[] };
  completenessNotice: typeof KNOWLEDGE_COMPLETENESS_NOTICE;
};

@Injectable()
export class KnowledgeContextPackService {
  buildContextPack(input: KnowledgeContextPackInput): KnowledgeContextPack {
    const entries = input.chunks?.length
      ? input.chunks.map(chunkEntry)
      : (input.capsules ?? []).map(capsuleEntry);
    const budgetConfig = resolveBudget(input.budget);
    const bounded = buildBoundedContext(entries, budgetConfig);
    const citationsBySource = new Map<string, KnowledgeCitation>();

    for (const entry of bounded.includedEntries) {
      for (const citation of entry.citations ?? []) {
        citationsBySource.set(citation.sourcePageId, citation);
      }
    }

    return {
      context: bounded.context,
      primary: bounded.primary,
      citations: [...citationsBySource.values()],
      warnings: unique(
        bounded.includedEntries.flatMap((entry) => [
          ...entry.warnings,
          ...(entry.staleAt ? ['Some retrieved knowledge may be stale.'] : []),
        ]),
      ),
      budget: {
        maxContextLength: budgetConfig.maxContextLength,
        usedContextLength: bounded.context.length,
        remainingContextLength: Math.max(
          0,
          budgetConfig.maxContextLength - bounded.context.length,
        ),
        includedItemCount: bounded.includedEntries.length,
        omittedItemCount: entries.length - bounded.includedEntries.length,
        responseReserve: budgetConfig.responseReserve,
        perItemMaxLength: budgetConfig.perItemMaxLength,
      },
      packing: { items: bounded.packingItems },
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
    };
  }
}

type BudgetConfig = {
  maxContextLength: number;
  responseReserve: number;
  perItemMaxLength: number;
};

type ContextEntry = {
  id: string;
  kind: KnowledgeContextPrimary['kind'];
  knowledgePageId: string;
  origin: KnowledgeRetrievalOrigin;
  authorizationMode: KnowledgeRetrievalAuthorizationMode;
  title: string;
  text: string;
  citations: KnowledgeCitation[];
  retrievalReasons: string[];
  warnings: string[];
  sourceWindows: KnowledgeSourceWindow[];
  staleAt: Date | null;
};

function buildBoundedContext(
  entries: ContextEntry[],
  budgetConfig: BudgetConfig,
): {
  context: string;
  includedEntries: ContextEntry[];
  primary: KnowledgeContextPrimary[];
  packingItems: KnowledgeContextPackingItem[];
} {
  const sections: string[] = [];
  const includedEntries: ContextEntry[] = [];
  const primary: KnowledgeContextPrimary[] = [];
  const packingItems: KnowledgeContextPackingItem[] = [];
  let remaining = budgetConfig.maxContextLength;

  for (const [entryIndex, entry] of entries.entries()) {
    const title = `# ${entry.title}`;
    const separatorLength = sections.length === 0 ? 0 : 2;
    if (remaining <= title.length + separatorLength) {
      packingItems.push(
        ...entries.slice(entryIndex).map((omittedEntry) => ({
          itemId: omittedEntry.id,
          kind: omittedEntry.kind,
          ...(omittedEntry.citations.length
            ? {
                sourcePageIds: unique(
                  omittedEntry.citations.map(
                    (citation) => citation.sourcePageId,
                  ),
                ),
              }
            : {}),
          disposition: 'omitted' as const,
          originalChars: omittedEntry.text.length,
          includedChars: 0,
        })),
      );
      break;
    }

    const bodyBudget = Math.min(
      budgetConfig.perItemMaxLength,
      remaining - title.length - separatorLength - 1,
    );
    const clippedBody = entry.text.slice(0, Math.max(0, bodyBudget));
    const section = [title, clippedBody].join('\n');
    sections.push(section);
    includedEntries.push(entry);
    primary.push({
      id: entry.id,
      kind: entry.kind,
      knowledgePageId: entry.knowledgePageId,
      origin: entry.origin,
      authorizationMode: entry.authorizationMode,
      title: entry.title,
      text: clippedBody,
      citationSourcePageIds: unique(
        entry.citations.map((citation) => citation.sourcePageId),
      ),
      retrievalReasons: unique(entry.retrievalReasons),
      sourceWindows: entry.sourceWindows,
    });
    packingItems.push({
      itemId: entry.id,
      kind: entry.kind,
      ...(entry.citations.length
        ? {
            sourcePageIds: unique(
              entry.citations.map((citation) => citation.sourcePageId),
            ),
          }
        : {}),
      disposition:
        clippedBody.length < entry.text.length ? 'clipped' : 'included',
      originalChars: entry.text.length,
      includedChars: clippedBody.length,
    });
    remaining -= section.length + separatorLength;
  }

  return {
    context: sections.join('\n\n').slice(0, budgetConfig.maxContextLength),
    includedEntries,
    primary,
    packingItems,
  };
}

function chunkEntry(
  entry: NonNullable<KnowledgeContextPackInput['chunks']>[number],
): ContextEntry {
  return {
    id: entry.chunk.id,
    kind: 'chunk',
    knowledgePageId: entry.chunk.knowledgePageId,
    origin: entry.origin ?? 'direct',
    authorizationMode: entry.authorizationMode ?? 'policy',
    title: entry.pageTitle,
    text: entry.chunk.text,
    citations: entry.citations ?? [],
    retrievalReasons: entry.retrievalReasons ?? [],
    warnings: entry.warnings ?? [],
    sourceWindows: entry.sourceWindows ?? [],
    staleAt: entry.chunk.staleAt,
  };
}

function capsuleEntry(
  entry: NonNullable<KnowledgeContextPackInput['capsules']>[number],
): ContextEntry {
  return {
    id: entry.capsule.id,
    kind: 'capsule',
    knowledgePageId: entry.capsule.id,
    origin: 'direct',
    authorizationMode: 'policy',
    title: entry.capsule.title,
    text: entry.capsule.body,
    citations: entry.citations ?? [],
    retrievalReasons: entry.retrievalReasons ?? [],
    warnings: entry.warnings ?? [],
    sourceWindows: entry.sourceWindows ?? [],
    staleAt: entry.capsule.staleAt,
  };
}

function resolveBudget(
  input: KnowledgeContextPackInput['budget'],
): BudgetConfig {
  const totalContextLength = positiveNumber(
    input?.totalContextLength,
    MAX_CONTEXT_LENGTH,
  );
  const responseReserve = Math.min(
    positiveNumber(input?.responseReserve, 0),
    totalContextLength,
  );
  const maxContextLength = Math.max(0, totalContextLength - responseReserve);

  return {
    maxContextLength,
    responseReserve,
    perItemMaxLength: Math.min(
      positiveNumber(input?.perItemMaxLength, maxContextLength),
      maxContextLength,
    ),
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
