import { Injectable } from '@nestjs/common';
import { KnowledgeChunk, KnowledgePage } from '@akasha/db/types/entity.types';
import { KnowledgeSourceRange } from '../types/knowledge.types';
import {
  KNOWLEDGE_COMPLETENESS_NOTICE,
  KnowledgeRetrievalResult,
} from './knowledge-retrieval.service';

const MAX_CONTEXT_LENGTH = 12_000;

export type KnowledgeCitation = {
  sourcePageId: string;
  title: string;
  url: string;
};

export type KnowledgeSourceWindow = KnowledgeCitation & {
  text: string;
  sourceRange: KnowledgeSourceRange;
  quoteHash: string;
};

export type KnowledgeContextPrimary = {
  id: string;
  kind: 'capsule' | 'chunk';
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
  retrievalReasons: string[];
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
      retrievalReasons: unique(
        bounded.includedEntries.flatMap((entry) => entry.retrievalReasons),
      ),
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
} {
  const sections: string[] = [];
  const includedEntries: ContextEntry[] = [];
  const primary: KnowledgeContextPrimary[] = [];
  let remaining = budgetConfig.maxContextLength;

  for (const entry of entries) {
    const title = `# ${entry.title}`;
    const separatorLength = sections.length === 0 ? 0 : 2;
    if (remaining <= title.length + separatorLength) break;

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
      title: entry.title,
      text: clippedBody,
      citationSourcePageIds: unique(
        entry.citations.map((citation) => citation.sourcePageId),
      ),
      retrievalReasons: unique(entry.retrievalReasons),
      sourceWindows: entry.sourceWindows,
    });
    remaining -= section.length + separatorLength;
  }

  return {
    context: sections.join('\n\n').slice(0, budgetConfig.maxContextLength),
    includedEntries,
    primary,
  };
}

function chunkEntry(
  entry: NonNullable<KnowledgeContextPackInput['chunks']>[number],
): ContextEntry {
  return {
    id: entry.chunk.id,
    kind: 'chunk',
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
