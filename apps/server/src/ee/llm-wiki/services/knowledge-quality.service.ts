import { Injectable } from '@nestjs/common';
import type { KnowledgeDiagnosticsPage } from './knowledge-diagnostics.service';

export type KnowledgeQualitySeverity = 'high' | 'medium' | 'low';

export type KnowledgeQualityIssue = {
  code:
    | 'missing_chunks'
    | 'missing_sources'
    | 'missing_embeddings'
    | 'stale_sources'
    | 'stale_access_policy';
  severity: KnowledgeQualitySeverity;
  message: string;
  affectedPageCount: number;
};

export type KnowledgeSpaceHealth = {
  spaceId: string;
  spaceName: string;
  pageCount: number;
  compiledPageCount: number;
  stalePageCount: number;
  missingChunkPageCount: number;
  missingEmbeddingPageCount: number;
  oldestStaleSourceAgeHours: number | null;
  healthScore: number;
};

export type KnowledgeQualitySummary = {
  pageCount: number;
  compiledPageCount: number;
  stalePageCount: number;
  missingSourcePageCount: number;
  missingChunkPageCount: number;
  missingEmbeddingPageCount: number;
  healthScore: number;
};

export type KnowledgeQualityReport = {
  summary: KnowledgeQualitySummary;
  spaces: KnowledgeSpaceHealth[];
  topIssues: KnowledgeQualityIssue[];
};

@Injectable()
export class KnowledgeQualityService {
  evaluate(input: {
    pages: KnowledgeDiagnosticsPage[];
    now?: Date;
  }): KnowledgeQualityReport {
    const now = input.now ?? new Date();
    const activePages = input.pages.filter((page) => !page.deletedAt);
    const pageScores = activePages.map(scorePage);

    return {
      summary: {
        pageCount: activePages.length,
        compiledPageCount: activePages.filter(isCompiled).length,
        stalePageCount: activePages.filter(isStale).length,
        missingSourcePageCount: activePages.filter(hasMissingSources).length,
        missingChunkPageCount: activePages.filter(hasMissingChunks).length,
        missingEmbeddingPageCount:
          activePages.filter(hasMissingEmbeddings).length,
        healthScore: averageScore(pageScores),
      },
      spaces: buildSpaceHealth(activePages, now),
      topIssues: buildIssues(activePages),
    };
  }
}

function buildSpaceHealth(
  pages: KnowledgeDiagnosticsPage[],
  now: Date,
): KnowledgeSpaceHealth[] {
  const pagesBySpaceId = new Map<string, KnowledgeDiagnosticsPage[]>();
  for (const page of pages) {
    const spacePages = pagesBySpaceId.get(page.spaceId) ?? [];
    spacePages.push(page);
    pagesBySpaceId.set(page.spaceId, spacePages);
  }

  return [...pagesBySpaceId.entries()].map(([spaceId, spacePages]) => ({
    spaceId,
    spaceName: spacePages[0]?.spaceName ?? '',
    pageCount: spacePages.length,
    compiledPageCount: spacePages.filter(isCompiled).length,
    stalePageCount: spacePages.filter(isStale).length,
    missingChunkPageCount: spacePages.filter(hasMissingChunks).length,
    missingEmbeddingPageCount: spacePages.filter(hasMissingEmbeddings).length,
    oldestStaleSourceAgeHours: oldestStaleSourceAgeHours(spacePages, now),
    healthScore: averageScore(spacePages.map(scorePage)),
  }));
}

function buildIssues(
  pages: KnowledgeDiagnosticsPage[],
): KnowledgeQualityIssue[] {
  return [
    issue(
      'missing_chunks',
      'high',
      'Some pages have no compiled chunks.',
      pages.filter(hasMissingChunks).length,
    ),
    issue(
      'missing_sources',
      'high',
      'Some pages have not been exported into knowledge sources.',
      pages.filter(hasMissingSources).length,
    ),
    issue(
      'missing_embeddings',
      'medium',
      'Some compiled chunks are missing embeddings.',
      pages.filter(hasMissingEmbeddings).length,
    ),
    issue(
      'stale_sources',
      'medium',
      'Some sources changed after compilation.',
      pages.filter((page) => page.staleSourceCount > 0).length,
    ),
    issue(
      'stale_access_policy',
      'medium',
      'Some access sidecar policies are stale.',
      pages.filter((page) => page.staleAccessPolicyCount > 0).length,
    ),
  ].filter((item) => item.affectedPageCount > 0);
}

function issue(
  code: KnowledgeQualityIssue['code'],
  severity: KnowledgeQualitySeverity,
  message: string,
  affectedPageCount: number,
): KnowledgeQualityIssue {
  return { code, severity, message, affectedPageCount };
}

function scorePage(page: KnowledgeDiagnosticsPage): number {
  let score = 100;
  if (page.staleSourceCount > 0 || page.staleAccessPolicyCount > 0) {
    score -= 30;
  }
  if (hasMissingSources(page)) {
    score -= 35;
  }
  if (hasMissingChunks(page)) {
    score -= 35;
  }
  if (hasMissingEmbeddings(page)) {
    score -= 40;
  }
  return Math.max(0, score);
}

function isCompiled(page: KnowledgeDiagnosticsPage): boolean {
  return page.knowledgeChunkCount > 0;
}

function isStale(page: KnowledgeDiagnosticsPage): boolean {
  return page.staleSourceCount > 0 || page.staleAccessPolicyCount > 0;
}

function hasMissingSources(page: KnowledgeDiagnosticsPage): boolean {
  return page.knowledgeSourceCount === 0 && page.textLength > 0;
}

function hasMissingChunks(page: KnowledgeDiagnosticsPage): boolean {
  return page.knowledgeChunkCount === 0 && page.textLength > 0;
}

function hasMissingEmbeddings(page: KnowledgeDiagnosticsPage): boolean {
  return page.missingEmbeddingChunkCount > 0;
}

function oldestStaleSourceAgeHours(
  pages: KnowledgeDiagnosticsPage[],
  now: Date,
): number | null {
  const staleTimes = pages
    .map((page) => page.oldestStaleSourceAt)
    .filter((value): value is Date => value instanceof Date);
  if (staleTimes.length === 0) return null;

  const oldestTime = Math.min(...staleTimes.map((value) => value.getTime()));
  return Math.max(0, Math.floor((now.getTime() - oldestTime) / 3_600_000));
}

function averageScore(scores: number[]): number {
  if (scores.length === 0) return 100;
  return Math.round(
    scores.reduce((sum, score) => sum + score, 0) / scores.length,
  );
}
