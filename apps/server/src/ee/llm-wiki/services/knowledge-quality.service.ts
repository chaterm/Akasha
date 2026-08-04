import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';

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

export type KnowledgeQualitySummary = {
  pageCount: number;
  compiledPageCount: number;
  stalePageCount: number;
  missingSourcePageCount: number;
  missingChunkPageCount: number;
  missingEmbeddingPageCount: number;
  healthScore: number;
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

export type KnowledgeQualityReport = {
  summary: KnowledgeQualitySummary;
  spaces: KnowledgeSpaceHealth[];
  topIssues: KnowledgeQualityIssue[];
};

export type KnowledgeQualityAggregateRow = {
  spaceId: string;
  spaceName: string;
  pageCount: unknown;
  compiledPageCount: unknown;
  stalePageCount: unknown;
  staleSourcePageCount: unknown;
  staleAccessPolicyPageCount: unknown;
  missingSourcePageCount: unknown;
  missingChunkPageCount: unknown;
  missingEmbeddingPageCount: unknown;
  oldestStaleSourceAt: Date | string | null;
  scoreSum: unknown;
};

@Injectable()
export class KnowledgeQualityService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getReport(input: {
    workspaceId: string;
    spaceIds: string[];
  }): Promise<KnowledgeQualityReport> {
    if (input.spaceIds.length === 0) {
      return buildKnowledgeQualityReport([], new Date());
    }

    const spaceIds = [...new Set(input.spaceIds)];
    const rows = await sql<KnowledgeQualityAggregateRow>`
      with scoped_pages as materialized (
        select p.id,
               p.workspace_id,
               p.space_id,
               s.name as space_name,
               coalesce(length(p.text_content), 0) > 0 as has_text
        from pages p
        inner join spaces s
          on s.id = p.space_id
         and s.workspace_id = p.workspace_id
         and s.deleted_at is null
        where p.workspace_id = ${input.workspaceId}
          and p.deleted_at is null
          and p.space_id in (${sql.join(spaceIds.map((id) => sql`${id}`))})
      ),
      source_stats as (
        select source.source_page_id,
               count(*)::integer as source_count,
               count(*) filter (where source.stale_at is not null)::integer
                 as stale_source_count,
               min(source.stale_at) filter (where source.stale_at is not null)
                 as oldest_stale_source_at
        from knowledge_sources source
        inner join scoped_pages page on page.id = source.source_page_id
        where source.workspace_id = ${input.workspaceId}
        group by source.source_page_id
      ),
      chunk_stats as (
        select source.source_page_id,
               count(*)::integer as chunk_count,
               count(*) filter (where chunk.embedding is null)::integer
                 as missing_embedding_count
        from knowledge_chunk_sources source
        inner join scoped_pages page on page.id = source.source_page_id
        inner join knowledge_chunks chunk
          on chunk.id = source.chunk_id
         and chunk.workspace_id = source.workspace_id
        where source.workspace_id = ${input.workspaceId}
        group by source.source_page_id
      ),
      access_stats as (
        select policy.source_page_id,
               count(*) filter (where policy.stale_at is not null)::integer
                 as stale_access_policy_count
        from knowledge_source_access_policy policy
        inner join scoped_pages page on page.id = policy.source_page_id
        where policy.workspace_id = ${input.workspaceId}
        group by policy.source_page_id
      ),
      page_health as (
        select page.space_id,
               page.space_name,
               coalesce(source.source_count, 0) > 0 as has_source,
               coalesce(chunk.chunk_count, 0) > 0 as has_chunks,
               coalesce(chunk.missing_embedding_count, 0) > 0
                 as has_missing_embeddings,
               coalesce(source.stale_source_count, 0) > 0
                 as has_stale_source,
               coalesce(access.stale_access_policy_count, 0) > 0
                 as has_stale_access_policy,
               source.oldest_stale_source_at,
               greatest(
                 0,
                 100
                   - case when coalesce(source.stale_source_count, 0) > 0
                               or coalesce(access.stale_access_policy_count, 0) > 0
                          then 30 else 0 end
                   - case when page.has_text and coalesce(source.source_count, 0) = 0
                          then 35 else 0 end
                   - case when page.has_text and coalesce(chunk.chunk_count, 0) = 0
                          then 35 else 0 end
                   - case when coalesce(chunk.missing_embedding_count, 0) > 0
                          then 40 else 0 end
               )::integer as health_score,
               page.has_text
        from scoped_pages page
        left join source_stats source on source.source_page_id = page.id
        left join chunk_stats chunk on chunk.source_page_id = page.id
        left join access_stats access on access.source_page_id = page.id
      )
      select space_id as "spaceId",
             max(space_name) as "spaceName",
             count(*)::integer as "pageCount",
             count(*) filter (where has_chunks)::integer as "compiledPageCount",
             count(*) filter (
               where has_stale_source or has_stale_access_policy
             )::integer as "stalePageCount",
             count(*) filter (where has_stale_source)::integer
               as "staleSourcePageCount",
             count(*) filter (where has_stale_access_policy)::integer
               as "staleAccessPolicyPageCount",
             count(*) filter (where has_text and not has_source)::integer
               as "missingSourcePageCount",
             count(*) filter (where has_text and not has_chunks)::integer
               as "missingChunkPageCount",
             count(*) filter (where has_missing_embeddings)::integer
               as "missingEmbeddingPageCount",
             min(oldest_stale_source_at) as "oldestStaleSourceAt",
             sum(health_score)::bigint as "scoreSum"
      from page_health
      group by space_id
      order by max(space_name), space_id
    `.execute(this.db);

    return buildKnowledgeQualityReport(rows.rows, new Date());
  }
}

export function buildKnowledgeQualityReport(
  rows: KnowledgeQualityAggregateRow[],
  now: Date,
): KnowledgeQualityReport {
  const totals = rows.reduce(
    (result, row) => {
      result.pageCount += numberValue(row.pageCount);
      result.compiledPageCount += numberValue(row.compiledPageCount);
      result.stalePageCount += numberValue(row.stalePageCount);
      result.staleSourcePageCount += numberValue(row.staleSourcePageCount);
      result.staleAccessPolicyPageCount += numberValue(
        row.staleAccessPolicyPageCount,
      );
      result.missingSourcePageCount += numberValue(row.missingSourcePageCount);
      result.missingChunkPageCount += numberValue(row.missingChunkPageCount);
      result.missingEmbeddingPageCount += numberValue(
        row.missingEmbeddingPageCount,
      );
      result.scoreSum += numberValue(row.scoreSum);
      return result;
    },
    {
      pageCount: 0,
      compiledPageCount: 0,
      stalePageCount: 0,
      staleSourcePageCount: 0,
      staleAccessPolicyPageCount: 0,
      missingSourcePageCount: 0,
      missingChunkPageCount: 0,
      missingEmbeddingPageCount: 0,
      scoreSum: 0,
    },
  );

  return {
    summary: {
      pageCount: totals.pageCount,
      compiledPageCount: totals.compiledPageCount,
      stalePageCount: totals.stalePageCount,
      missingSourcePageCount: totals.missingSourcePageCount,
      missingChunkPageCount: totals.missingChunkPageCount,
      missingEmbeddingPageCount: totals.missingEmbeddingPageCount,
      healthScore: averageScore(totals.scoreSum, totals.pageCount),
    },
    spaces: rows.map((row) => {
      const pageCount = numberValue(row.pageCount);
      return {
        spaceId: row.spaceId,
        spaceName: row.spaceName,
        pageCount,
        compiledPageCount: numberValue(row.compiledPageCount),
        stalePageCount: numberValue(row.stalePageCount),
        missingChunkPageCount: numberValue(row.missingChunkPageCount),
        missingEmbeddingPageCount: numberValue(row.missingEmbeddingPageCount),
        oldestStaleSourceAgeHours: staleAgeHours(row.oldestStaleSourceAt, now),
        healthScore: averageScore(numberValue(row.scoreSum), pageCount),
      };
    }),
    topIssues: [
      issue(
        'missing_chunks',
        'high',
        'Some pages have no compiled chunks.',
        totals.missingChunkPageCount,
      ),
      issue(
        'missing_sources',
        'high',
        'Some pages have not been exported into knowledge sources.',
        totals.missingSourcePageCount,
      ),
      issue(
        'missing_embeddings',
        'medium',
        'Some compiled chunks are missing embeddings.',
        totals.missingEmbeddingPageCount,
      ),
      issue(
        'stale_sources',
        'medium',
        'Some sources changed after compilation.',
        totals.staleSourcePageCount,
      ),
      issue(
        'stale_access_policy',
        'medium',
        'Some access sidecar policies are stale.',
        totals.staleAccessPolicyPageCount,
      ),
    ].filter((item) => item.affectedPageCount > 0),
  };
}

function issue(
  code: KnowledgeQualityIssue['code'],
  severity: KnowledgeQualitySeverity,
  message: string,
  affectedPageCount: number,
): KnowledgeQualityIssue {
  return { code, severity, message, affectedPageCount };
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function averageScore(scoreSum: number, pageCount: number): number {
  return pageCount === 0 ? 100 : Math.round(scoreSum / pageCount);
}

function staleAgeHours(value: Date | string | null, now: Date): number | null {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 3_600_000));
}
