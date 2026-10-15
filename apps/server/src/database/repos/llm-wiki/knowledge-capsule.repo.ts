import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx, executeTx } from '@akasha/db/utils';
import {
  InsertableKnowledgePage,
  InsertableKnowledgePageSource,
  InsertableKnowledgeParentSection,
  InsertableKnowledgeParentSectionSource,
  InsertableKnowledgeClaim,
  InsertableKnowledgeClaimSource,
  InsertableKnowledgeChunk,
  InsertableKnowledgeChunkSource,
  InsertableKnowledgeChunkAttachment,
  InsertableKnowledgeLink,
  InsertableKnowledgeLinkSource,
  InsertableKnowledgeGraphEdge,
  InsertableKnowledgeGraphEdgeSource,
  KnowledgeChunk,
  KnowledgeGraphEdge,
  KnowledgeGraphEdgeSource,
  KnowledgeLink,
  KnowledgeLinkSource,
  KnowledgePage,
  KnowledgePageSource,
  KnowledgeParentSection,
  KnowledgeParentSectionSource,
} from '@akasha/db/types/entity.types';
import { sql } from 'kysely';
import { toSql as vectorToSql } from 'pgvector';

type SourcePageRow = { sourcePageId: string };
type ChunkSourcePageRow = { chunkId: string; sourcePageId: string };
type ChunkSourceRefRow = {
  chunkId: string;
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  sourceRange: unknown;
  quoteHash: string | null;
};
type OwnerRow<K extends string> = Record<K, string>;
const CHILD_INSERT_BATCH_SIZE = 1_000;
export type UpsertCompiledArtifactInput = {
  page: InsertableKnowledgePage;
  pageSources?: InsertableKnowledgePageSource[];
  parentSections?: InsertableKnowledgeParentSection[];
  parentSectionSources?: InsertableKnowledgeParentSectionSource[];
  claims?: InsertableKnowledgeClaim[];
  claimSources?: InsertableKnowledgeClaimSource[];
  chunks?: InsertableKnowledgeChunk[];
  chunkSources?: InsertableKnowledgeChunkSource[];
  chunkAttachments?: InsertableKnowledgeChunkAttachment[];
  links?: InsertableKnowledgeLink[];
  linkSources?: InsertableKnowledgeLinkSource[];
  graphEdges?: InsertableKnowledgeGraphEdge[];
  graphEdgeSources?: InsertableKnowledgeGraphEdgeSource[];
};
export type KnowledgeGraphCandidates = {
  pages: KnowledgePage[];
  pageSources: KnowledgePageSource[];
  parentSections: KnowledgeParentSection[];
  parentSectionSources: KnowledgeParentSectionSource[];
  links: KnowledgeLink[];
  linkSources: KnowledgeLinkSource[];
  graphEdges: KnowledgeGraphEdge[];
  graphEdgeSources: KnowledgeGraphEdgeSource[];
};
export type KnowledgeRetrievalSignal =
  | 'semantic'
  | 'lexical'
  | 'exact-title'
  | 'graph';
export type KnowledgeChunkCandidate = {
  chunk: KnowledgeChunk;
  page: KnowledgePage;
  sourcePageIds: string[];
  signals: KnowledgeRetrievalSignal[];
  lexicalScore?: number | null;
  signalScore?: number | null;
  parentSection?: KnowledgeParentSection;
};
export type KnowledgeAccessPrincipal = {
  principalType: 'user' | 'group';
  principalId: string;
};
export type AuthorizedCandidateInput = {
  workspaceId: string;
  spaceIds: string[];
  principals: KnowledgeAccessPrincipal[];
  /** Normalized page label names. A source page may match any supplied label. */
  labelNames?: string[];
  retrievalChannel?: 'evidence' | 'memory';
  authorizationMode?: 'policy' | 'final-authorization-fallback';
};
type RankedChunkId = { chunkId: string; score: number | null };
export type KnowledgeChunkSourceRef = {
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  sourceRange: unknown;
  quoteHash: string | null;
};

export type KnowledgeGraphEdgeType = 'semantic' | 'link' | 'shared-source';

export const KNOWLEDGE_GRAPH_EDGE_TYPE_WEIGHT: Record<
  KnowledgeGraphEdgeType,
  number
> = {
  semantic: 1.0,
  link: 0.7,
  'shared-source': 0.2,
};

export type KnowledgeGraphTraversalEdge = {
  id: string;
  fromKnowledgePageId: string;
  toKnowledgePageId: string;
  type: KnowledgeGraphEdgeType;
  weight: number;
  sourcePageIds: string[];
};

export type KnowledgeGraphTraversalSeed = {
  knowledgePageId: string;
  weight: number;
};

export type CompilerCatalogCandidateRow = {
  artifactId: string;
  artifactKind: string;
  canonicalKey: string;
  title: string;
  explicitMatch: boolean;
  canonicalExactMatch: boolean;
  titleExactMatch: boolean;
  exactMatch: boolean;
  trigramScore: number;
  ftsMatch: boolean;
};

@Injectable()
export class KnowledgeCapsuleRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /**
   * Searches canonical artifact identities entirely in PostgreSQL. Bodies and
   * source lineage are used only for ranking and are never returned to Node or
   * sent to the compiler model.
   */
  async findCompilerCatalogCandidates(input: {
    workspaceId: string;
    spaceId: string;
    signals: string[];
    explicitSourcePageIds?: string[];
    limit: number;
  }): Promise<CompilerCatalogCandidateRow[]> {
    const signals = [...new Set(input.signals.map(normalizeCatalogSignal))]
      .filter(Boolean)
      .slice(0, 64);
    const explicitSourcePageIds = [
      ...new Set(input.explicitSourcePageIds ?? []),
    ].slice(0, 64);
    if (signals.length === 0 && explicitSourcePageIds.length === 0) return [];
    const signalValues =
      signals.length > 0
        ? sql`ARRAY[${sql.join(signals)}]::text[]`
        : sql`ARRAY[]::text[]`;
    const explicitValues =
      explicitSourcePageIds.length > 0
        ? sql`ARRAY[${sql.join(explicitSourcePageIds)}]::uuid[]`
        : sql`ARRAY[]::uuid[]`;
    const boundedLimit = Math.min(Math.max(input.limit, 1), 512);
    const result = await sql<CompilerCatalogCandidateRow>`
      WITH signals(value) AS (
        SELECT unnest(${signalValues})
      ), explicit_candidates AS (
        SELECT
          page.id AS "artifactId",
          page.page_type AS "artifactKind",
          page.canonical_key AS "canonicalKey",
          page.title,
          true AS "explicitMatch",
          false AS "canonicalExactMatch",
          false AS "titleExactMatch",
          false AS "exactMatch",
          0::float8 AS "trigramScore",
          false AS "ftsMatch"
        FROM knowledge_artifact_contributions contribution
        JOIN knowledge_pages page
          ON page.workspace_id = contribution.workspace_id
         AND page.space_id = contribution.space_id
         AND page.id = contribution.artifact_id
        WHERE contribution.workspace_id = ${input.workspaceId}::uuid
          AND contribution.space_id = ${input.spaceId}::uuid
          AND contribution.source_page_id = ANY(${explicitValues})
          AND page.stale_at IS NULL
          AND page.canonical_key IS NOT NULL
          AND page.page_type IN ('source_summary', 'concept', 'entity', 'comparison')
        LIMIT ${boundedLimit}
      ), canonical_exact_candidates AS (
        SELECT
          page.id AS "artifactId",
          page.page_type AS "artifactKind",
          page.canonical_key AS "canonicalKey",
          page.title,
          false AS "explicitMatch",
          true AS "canonicalExactMatch",
          false AS "titleExactMatch",
          true AS "exactMatch",
          0::float8 AS "trigramScore",
          false AS "ftsMatch"
        FROM signals signal
        JOIN knowledge_pages page
          ON page.workspace_id = ${input.workspaceId}::uuid
         AND page.space_id = ${input.spaceId}::uuid
         AND page.page_type IN ('source_summary', 'concept', 'entity', 'comparison')
         AND page.canonical_key = signal.value
         AND page.stale_at IS NULL
        LIMIT ${boundedLimit}
      ), title_exact_candidates AS (
        SELECT
          page.id AS "artifactId",
          page.page_type AS "artifactKind",
          page.canonical_key AS "canonicalKey",
          page.title,
          false AS "explicitMatch",
          false AS "canonicalExactMatch",
          true AS "titleExactMatch",
          true AS "exactMatch",
          0::float8 AS "trigramScore",
          false AS "ftsMatch"
        FROM signals signal
        JOIN knowledge_pages page
          ON page.workspace_id = ${input.workspaceId}::uuid
         AND page.space_id = ${input.spaceId}::uuid
         AND page.page_type IN ('source_summary', 'concept', 'entity', 'comparison')
         AND regexp_replace(lower(trim(page.title)), '\\s+', ' ', 'g') = signal.value
         AND page.stale_at IS NULL
        LIMIT ${boundedLimit}
      ), trigram_candidates AS (
        SELECT
          match.id AS "artifactId",
          match.page_type AS "artifactKind",
          match.canonical_key AS "canonicalKey",
          match.title,
          false AS "explicitMatch",
          false AS "canonicalExactMatch",
          false AS "titleExactMatch",
          false AS "exactMatch",
          match.score AS "trigramScore",
          false AS "ftsMatch"
        FROM signals signal
        JOIN LATERAL (
          SELECT
            page.id,
            page.page_type,
            page.canonical_key,
            page.title,
            similarity(page.title, signal.value)::float8 AS score
          FROM knowledge_pages page
          WHERE page.workspace_id = ${input.workspaceId}::uuid
            AND page.space_id = ${input.spaceId}::uuid
            AND page.stale_at IS NULL
            AND page.canonical_key IS NOT NULL
            AND page.page_type IN ('source_summary', 'concept', 'entity', 'comparison')
            AND page.title % signal.value
          ORDER BY similarity(page.title, signal.value) DESC, page.id ASC
          LIMIT 8
        ) match ON true
      ), fts_candidates AS (
        SELECT
          match.id AS "artifactId",
          match.page_type AS "artifactKind",
          match.canonical_key AS "canonicalKey",
          match.title,
          false AS "explicitMatch",
          false AS "canonicalExactMatch",
          false AS "titleExactMatch",
          false AS "exactMatch",
          0::float8 AS "trigramScore",
          true AS "ftsMatch"
        FROM signals signal
        JOIN LATERAL (
          SELECT DISTINCT
            page.id,
            page.page_type,
            page.canonical_key,
            page.title
          FROM knowledge_chunks chunk
          JOIN knowledge_pages page
            ON page.workspace_id = chunk.workspace_id
           AND page.space_id = chunk.space_id
           AND page.id = chunk.knowledge_page_id
          WHERE chunk.workspace_id = ${input.workspaceId}::uuid
            AND chunk.space_id = ${input.spaceId}::uuid
            AND chunk.stale_at IS NULL
            AND chunk.search_tsv_zh @@ knowledge_zh_tsquery(signal.value, true)
            AND page.stale_at IS NULL
            AND page.canonical_key IS NOT NULL
            AND page.page_type IN ('source_summary', 'concept', 'entity', 'comparison')
          ORDER BY page.id ASC
          LIMIT 8
        ) match ON true
      ), candidates AS (
        SELECT * FROM explicit_candidates
        UNION ALL SELECT * FROM canonical_exact_candidates
        UNION ALL SELECT * FROM title_exact_candidates
        UNION ALL SELECT * FROM trigram_candidates
        UNION ALL SELECT * FROM fts_candidates
      ), ranked AS (
        SELECT
          "artifactId",
          "artifactKind",
          "canonicalKey",
          title,
          bool_or("explicitMatch") AS "explicitMatch",
          bool_or("canonicalExactMatch") AS "canonicalExactMatch",
          bool_or("titleExactMatch") AS "titleExactMatch",
          bool_or("exactMatch") AS "exactMatch",
          max("trigramScore") AS "trigramScore",
          bool_or("ftsMatch") AS "ftsMatch"
        FROM candidates
        GROUP BY "artifactId", "artifactKind", "canonicalKey", title
      )
      SELECT *
      FROM ranked
      ORDER BY
        "explicitMatch" DESC,
        "canonicalExactMatch" DESC,
        "titleExactMatch" DESC,
        "trigramScore" DESC,
        "ftsMatch" DESC,
        "artifactKind" ASC,
        "canonicalKey" ASC,
        "artifactId" ASC
      LIMIT ${boundedLimit}
    `.execute(this.db);
    return result.rows;
  }

  async resolveCanonicalLinks(
    input: { workspaceId: string; spaceId: string },
    trx?: KyselyTransaction,
  ): Promise<{ resolvedLinkCount: number }> {
    const resolve = async (db: KyselyDB | KyselyTransaction) => {
      const result = await sql<{ id: string }>`
        UPDATE knowledge_links AS link
        SET
          to_knowledge_page_id = target.id,
          is_dangling = false
        FROM knowledge_pages AS target
        WHERE link.workspace_id = ${input.workspaceId}::uuid
          AND link.space_id = ${input.spaceId}::uuid
          AND link.stale_at IS NULL
          AND link.is_dangling = true
          AND link.target_artifact_kind IS NOT NULL
          AND link.target_canonical_key IS NOT NULL
          AND target.workspace_id = link.workspace_id
          AND target.space_id = link.space_id
          AND target.page_type = link.target_artifact_kind
          AND target.canonical_key = link.target_canonical_key
          AND target.stale_at IS NULL
        RETURNING link.id
      `.execute(db);
      return { resolvedLinkCount: result.rows.length };
    };

    return trx ? resolve(trx) : executeTx(this.db, resolve);
  }

  async resolveCanonicalGraphEdges(
    input: {
      workspaceId: string;
      spaceId: string;
    },
    trx?: KyselyTransaction,
  ): Promise<{ resolvedEdgeCount: number }> {
    const result = await sql<{ id: string }>`
      WITH resolvable AS (
        SELECT
          edge.id AS edge_id,
          min(target.id::text)::uuid AS target_id,
          min(target.page_type) AS target_artifact_kind
        FROM knowledge_graph_edges AS edge
        INNER JOIN knowledge_pages AS target
          ON target.workspace_id = edge.workspace_id
          AND target.space_id = edge.space_id
          AND target.canonical_key = edge.target_canonical_key
          AND target.stale_at IS NULL
          AND (
            edge.target_artifact_kind IS NULL
            OR target.page_type = edge.target_artifact_kind
          )
        WHERE edge.workspace_id = ${input.workspaceId}::uuid
          AND edge.space_id = ${input.spaceId}::uuid
          AND edge.stale_at IS NULL
          AND edge.is_dangling = true
          AND edge.target_canonical_key IS NOT NULL
        GROUP BY edge.id
        HAVING count(*) = 1
      )
      UPDATE knowledge_graph_edges AS edge
      SET
        to_knowledge_page_id = resolvable.target_id,
        target_artifact_kind = resolvable.target_artifact_kind,
        is_dangling = false
      FROM resolvable
      WHERE edge.id = resolvable.edge_id
      RETURNING edge.id
    `.execute(trx ?? this.db);
    return { resolvedEdgeCount: result.rows.length };
  }

  async resolveCanonicalReferences(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<{ resolvedLinkCount: number; resolvedEdgeCount: number }> {
    return executeTx(this.db, async (trx) => {
      const links = await this.resolveCanonicalLinks(input, trx);
      const graphEdges = await this.resolveCanonicalGraphEdges(input, trx);
      return {
        resolvedLinkCount: links.resolvedLinkCount,
        resolvedEdgeCount: graphEdges.resolvedEdgeCount,
      };
    });
  }

  async upsertCompiledArtifact(
    input: UpsertCompiledArtifactInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgePage> {
    const [page] = await this.upsertCompiledArtifacts([input], trx);

    return page;
  }

  async upsertCompiledArtifacts(
    inputs: UpsertCompiledArtifactInput[],
    trx?: KyselyTransaction,
  ): Promise<KnowledgePage[]> {
    if (inputs.length === 0) return [];

    const db = dbOrTx(this.db, trx);

    for (const input of inputs) {
      await this.deleteChildArtifacts(input.page.id, trx);
    }

    const pages: KnowledgePage[] = [];
    for (const input of inputs) {
      pages.push(await this.upsertCompiledPage(input, trx));
    }

    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.pageSources ?? []),
      'knowledgePageSources',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.parentSections ?? []),
      'knowledgeParentSections',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.parentSectionSources ?? []),
      'knowledgeParentSectionSources',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.claims ?? []),
      'knowledgeClaims',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.claimSources ?? []),
      'knowledgeClaimSources',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.chunks ?? []),
      'knowledgeChunks',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.chunkSources ?? []),
      'knowledgeChunkSources',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.chunkAttachments ?? []),
      'knowledgeChunkAttachments',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.links ?? []),
      'knowledgeLinks',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.linkSources ?? []),
      'knowledgeLinkSources',
    );
    const graphEdgeRows = inputs.flatMap((input) => input.graphEdges ?? []);
    await this.assertGraphEdgesWithinSpace(db, graphEdgeRows);
    await this.insertArtifactChildren(db, graphEdgeRows, 'knowledgeGraphEdges');
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.graphEdgeSources ?? []),
      'knowledgeGraphEdgeSources',
    );

    return pages;
  }

  private async upsertCompiledPage(
    input: UpsertCompiledArtifactInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgePage> {
    return await dbOrTx(this.db, trx)
      .insertInto('knowledgePages')
      .values({
        ...input.page,
        staleAt: null,
        updatedAt: new Date(),
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          title: input.page.title,
          slug: input.page.slug,
          compileScope: input.page.compileScope,
          generationMode: input.page.generationMode ?? 'legacy',
          pageType: input.page.pageType ?? null,
          canonicalKey: input.page.canonicalKey ?? null,
          body: input.page.body,
          summary: input.page.summary ?? null,
          compiledAt: input.page.compiledAt,
          compilerVersion: input.page.compilerVersion,
          compilerRunId: input.page.compilerRunId ?? null,
          compileTaskId: input.page.compileTaskId ?? null,
          staleAt: null,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async assertGraphEdgesWithinSpace(
    db: KyselyDB | KyselyTransaction,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (rows.length === 0) return;

    const endpointIds = unique(
      rows.flatMap((row) =>
        [row.fromKnowledgePageId, row.toKnowledgePageId].filter(
          (value): value is string => typeof value === 'string',
        ),
      ),
    );
    if (endpointIds.length === 0) return;

    const pages = await db
      .selectFrom('knowledgePages')
      .select(['id', 'spaceId'])
      .where('id', 'in', endpointIds)
      .execute();
    const spaceByPageId = new Map(pages.map((page) => [page.id, page.spaceId]));

    for (const row of rows) {
      const spaceId = row.spaceId;
      const fromSpaceId = spaceByPageId.get(row.fromKnowledgePageId as string);
      const toSpaceId = spaceByPageId.get(row.toKnowledgePageId as string);
      if (
        (fromSpaceId !== undefined && fromSpaceId !== spaceId) ||
        (toSpaceId !== undefined && toSpaceId !== spaceId)
      ) {
        throw new Error(
          'cross_space_graph_edge_disallowed: graph edge endpoints must be in the edge space',
        );
      }
    }
  }

  private async insertArtifactChildren<T extends Record<string, unknown>>(
    db: KyselyDB | KyselyTransaction,
    rows: T[],
    table:
      | 'knowledgePageSources'
      | 'knowledgeParentSections'
      | 'knowledgeParentSectionSources'
      | 'knowledgeClaims'
      | 'knowledgeClaimSources'
      | 'knowledgeChunks'
      | 'knowledgeChunkSources'
      | 'knowledgeChunkAttachments'
      | 'knowledgeLinks'
      | 'knowledgeLinkSources'
      | 'knowledgeGraphEdges'
      | 'knowledgeGraphEdgeSources',
  ): Promise<void> {
    if (rows.length === 0) return;

    for (
      let offset = 0;
      offset < rows.length;
      offset += CHILD_INSERT_BATCH_SIZE
    ) {
      await db
        .insertInto(table)
        .values(rows.slice(offset, offset + CHILD_INSERT_BATCH_SIZE) as never)
        .execute();
    }
  }

  async markArtifactsStaleByIds(
    input: { workspaceId: string; spaceId?: string; artifactIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.artifactIds.length === 0) return;
    const db = dbOrTx(this.db, trx);
    let scopedIds = input.artifactIds;
    if (input.spaceId) {
      const rows = await db
        .selectFrom('knowledgePages')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('id', 'in', input.artifactIds)
        .execute();
      scopedIds = rows.map((row) => row.id);
      if (scopedIds.length === 0) return;
    }
    const staleAt = new Date();
    await Promise.all([
      db
        .updateTable('knowledgePages')
        .set({ staleAt })
        .where('workspaceId', '=', input.workspaceId)
        .where('id', 'in', scopedIds)
        .execute(),
      db
        .updateTable('knowledgeParentSections')
        .set({ staleAt })
        .where('workspaceId', '=', input.workspaceId)
        .where('knowledgePageId', 'in', scopedIds)
        .execute(),
      ...(
        [
          ['knowledgeClaims', 'knowledgePageId'],
          ['knowledgeChunks', 'knowledgePageId'],
          ['knowledgeLinks', 'fromKnowledgePageId'],
          ['knowledgeGraphEdges', 'fromKnowledgePageId'],
        ] as const
      ).map(([table, ownerColumn]) =>
        db
          .updateTable(table)
          .set({ staleAt })
          .where('workspaceId', '=', input.workspaceId)
          .where(ownerColumn, 'in', scopedIds)
          .execute(),
      ),
    ]);
  }

  async findPageCandidates(
    input: {
      workspaceId: string;
      spaceIds: string[];
      query: string;
      limit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgePage[]> {
    if (input.spaceIds.length === 0) return [];

    const normalizedQuery = `%${input.query.trim()}%`;

    return dbOrTx(this.db, trx)
      .selectFrom('knowledgePages')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', 'in', input.spaceIds)
      .where('staleAt', 'is', null)
      .where((eb) =>
        eb(sql`title`, 'ilike', normalizedQuery).or(
          sql`body`,
          'ilike',
          normalizedQuery,
        ),
      )
      .limit(input.limit)
      .execute();
  }

  async findEmbeddedChunkCandidates(
    input: {
      workspaceId: string;
      spaceIds: string[];
      limit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunk[]> {
    if (input.spaceIds.length === 0) return [];

    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunks')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', 'in', input.spaceIds)
      .where('staleAt', 'is', null)
      .where('embedding', 'is not', null)
      .limit(input.limit)
      .execute();
  }

  async findDenseChunkCandidates(
    input: AuthorizedCandidateInput & {
      embedding: {
        vector: number[];
        profile: string;
        model: string;
        dimensions: number;
      };
      limit: number;
      knowledgePageIds?: string[];
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (!hasCandidateScope(input) || input.embedding.vector.length === 0) {
      return [];
    }
    if (input.knowledgePageIds && input.knowledgePageIds.length === 0)
      return [];
    if (
      !Number.isInteger(input.embedding.dimensions) ||
      input.embedding.dimensions <= 0 ||
      input.embedding.vector.length !== input.embedding.dimensions
    ) {
      return [];
    }
    if (!/^[a-f0-9]{64}$/.test(input.embedding.profile)) return [];

    const runQuery = async (
      activeDb: KyselyDB | KyselyTransaction,
      hydrationTrx?: KyselyTransaction,
    ): Promise<KnowledgeChunkCandidate[]> => {
      const dimensions = sql.raw(String(input.embedding.dimensions));
      const profile = input.embedding.profile;
      const profileLiteral = sql.raw(`'${profile}'`);
      const queryVector = vectorToSql(input.embedding.vector);
      const distance = sql<number>`knowledge_chunks.embedding::vector(${dimensions}) <=> ${queryVector}::vector`;
      let query = activeDb
        .selectFrom('knowledgeChunks')
        .select(['knowledgeChunks.id as chunkId', distance.as('score')])
        .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
        .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
        .where('knowledgeChunks.staleAt', 'is', null)
        .where(
          sql<boolean>`knowledge_chunks.embedding_profile = ${profileLiteral}`,
        )
        .where(
          sql<boolean>`knowledge_chunks.embedding_dimensions = ${dimensions}`,
        )
        .where('knowledgeChunks.embedding', 'is not', null);
      if (input.retrievalChannel) {
        query = query.where(
          'knowledgeChunks.retrievalChannel',
          '=',
          input.retrievalChannel,
        );
      }
      if (input.knowledgePageIds) {
        query = query.where(
          'knowledgeChunks.knowledgePageId',
          'in',
          input.knowledgePageIds,
        );
      }
      const rows = await this.applyAuthorizedChunkScope(query, input)
        .orderBy(distance, 'asc')
        .limit(input.limit)
        .execute();

      return this.hydrateRankedChunkCandidates(
        rows as RankedChunkId[],
        'semantic',
        input,
        hydrationTrx,
      );
    };

    if (input.embedding.dimensions > 2000) {
      return runQuery(dbOrTx(this.db, trx), trx);
    }

    return executeTx(
      this.db,
      async (activeTrx) => {
        await sql.raw('SET LOCAL hnsw.ef_search = 200').execute(activeTrx);
        await sql
          .raw('SET LOCAL hnsw.iterative_scan = strict_order')
          .execute(activeTrx);
        return runQuery(activeTrx, activeTrx);
      },
      trx,
    );
  }

  async findLexicalChunkCandidates(
    input: AuthorizedCandidateInput & {
      query: string;
      limit: number;
      knowledgePageIds?: string[];
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (!hasCandidateScope(input) || input.query.trim().length === 0) return [];
    if (input.knowledgePageIds && input.knowledgePageIds.length === 0)
      return [];

    const db = dbOrTx(this.db, trx);
    // jieba-segmented FTS (see migration 20261015T100000): `simple` does not
    // split Han text, so Chinese queries used to match almost nothing.
    const terms = await this.classifyLexicalQueryTerms(input, trx);
    const rareTerms = terms.filter((term) => !term.common);
    // A lexical hit bypasses the semantic-distance gate, so only rare terms
    // may make a chunk relevant (ES common-terms query): a query left with
    // only common words (请问配置在哪里 -> 配置) is handed to dense recall.
    if (rareTerms.length === 0) return [];

    // Terms are passed as tsquery literals, not re-segmented per row; a
    // per-row function call is re-evaluated on every recheck (≈15x slower).
    const rareQuery = rareTerms.map((term) => term.term).join(' | ');
    const allQuery = terms.map((term) => term.term).join(' | ');
    const rareTermArray = sql`${rareTerms.map((term) => term.term)}::tsquery[]`;
    // Minimum-should-match over rare terms; coverage ranks first, and
    // ts_rank_cd over all terms (common ones included) breaks ties.
    const coverage = sql<number>`(
      SELECT count(*)::int
      FROM unnest(${rareTermArray}) AS term
      WHERE knowledge_chunks.search_tsv_zh @@ term
    )`;
    const rank = sql<number>`(${coverage} + ts_rank_cd(knowledge_chunks.search_tsv_zh, ${allQuery}::tsquery, 32))`;
    let query = db
      .selectFrom('knowledgeChunks')
      .select(['knowledgeChunks.id as chunkId', rank.as('score')])
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .where(
        sql<boolean>`knowledge_chunks.search_tsv_zh @@ ${rareQuery}::tsquery`,
      )
      .where(
        sql<boolean>`${coverage} >= ${minimumShouldMatch(rareTerms.length)}`,
      );
    if (input.retrievalChannel) {
      query = query.where(
        'knowledgeChunks.retrievalChannel',
        '=',
        input.retrievalChannel,
      );
    }
    if (input.knowledgePageIds) {
      query = query.where(
        'knowledgeChunks.knowledgePageId',
        'in',
        input.knowledgePageIds,
      );
    }
    const rows = await this.applyAuthorizedChunkScope(query, input)
      .orderBy(rank, 'desc')
      .limit(input.limit)
      .execute();

    return this.hydrateRankedChunkCandidates(
      rows as RankedChunkId[],
      'lexical',
      input,
      trx,
    );
  }

  // Segments the query (knowledge_zh_query_terms) and measures each term's
  // document frequency within the candidate scope. Document frequency ignores
  // ACLs: it is a corpus statistic, not a visibility decision. Counts stop at
  // the threshold, so a very common term costs at most `threshold` index hits.
  private async classifyLexicalQueryTerms(
    input: AuthorizedCandidateInput & {
      query: string;
      knowledgePageIds?: string[];
    },
    trx?: KyselyTransaction,
  ): Promise<{ term: string; documentFrequency: number; common: boolean }[]> {
    const scope = sql.join(
      [
        sql`chunk.workspace_id = ${input.workspaceId}::uuid`,
        sql`chunk.space_id = ANY(${input.spaceIds}::uuid[])`,
        sql`chunk.stale_at IS NULL`,
        ...(input.retrievalChannel
          ? [sql`chunk.retrieval_channel = ${input.retrievalChannel}`]
          : []),
        ...(input.knowledgePageIds
          ? [
              sql`chunk.knowledge_page_id = ANY(${input.knowledgePageIds}::uuid[])`,
            ]
          : []),
      ],
      sql` AND `,
    );
    const result = await sql<{
      term: string;
      documentFrequency: number;
      threshold: number;
    }>`
      WITH scope_size AS (
        SELECT count(*)::int AS total FROM knowledge_chunks chunk WHERE ${scope}
      ), settings AS (
        SELECT greatest(
          ${LEXICAL_COMMON_TERM_MIN_DOCUMENTS}::int,
          ceil(total * ${LEXICAL_COMMON_TERM_RATIO}::float8)::int
        ) AS threshold
        FROM scope_size
      )
      SELECT term::text AS term, frequency.n AS document_frequency, settings.threshold
      FROM settings,
           unnest(knowledge_zh_query_terms(${input.query.trim()})) AS term,
           LATERAL (
             SELECT count(*)::int AS n FROM (
               SELECT 1 FROM knowledge_chunks chunk
               WHERE ${scope} AND chunk.search_tsv_zh @@ term
               LIMIT settings.threshold + 1
             ) hits
           ) frequency
    `.execute(dbOrTx(this.db, trx));
    return result.rows.map((row) => ({
      term: row.term,
      documentFrequency: Number(row.documentFrequency),
      common: Number(row.documentFrequency) > Number(row.threshold),
    }));
  }

  async findExactTitleChunkCandidates(
    input: AuthorizedCandidateInput & { query: string; limit: number },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (!hasCandidateScope(input)) return [];
    const normalizedQuery = normalizeTitle(input.query);
    if (!normalizedQuery) return [];

    const db = dbOrTx(this.db, trx);
    const normalizedTitle = sql<string>`regexp_replace(lower(trim(knowledge_pages.title)), '\\s+', ' ', 'g')`;
    const titleScore = sql<number>`CASE
      WHEN ${normalizedTitle} = ${normalizedQuery} THEN 1
      ELSE 0.5
    END`;
    let query = db
      .selectFrom('knowledgeChunks')
      .innerJoin(
        'knowledgePages',
        'knowledgePages.id',
        'knowledgeChunks.knowledgePageId',
      )
      .select(['knowledgeChunks.id as chunkId', titleScore.as('score')])
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .where('knowledgePages.staleAt', 'is', null)
      .where(normalizedTitle, 'like', `${normalizedQuery}%`);
    if (input.retrievalChannel) {
      query = query.where(
        'knowledgeChunks.retrievalChannel',
        '=',
        input.retrievalChannel,
      );
    }
    const rows = await this.applyAuthorizedChunkScope(query, input)
      .orderBy(titleScore, 'desc')
      .orderBy('knowledgeChunks.id', 'asc')
      .limit(input.limit)
      .execute();

    return this.hydrateRankedChunkCandidates(
      rows as RankedChunkId[],
      'exact-title',
      input,
      trx,
    );
  }

  async findGraphFrontierSourceIds(
    input: {
      workspaceId: string;
      spaceIds: string[];
      knowledgePageIds: string[];
    },
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    if (input.spaceIds.length === 0 || input.knowledgePageIds.length === 0) {
      return [];
    }

    const db = dbOrTx(this.db, trx);
    const frontier = input.knowledgePageIds;
    const spaceIds = input.spaceIds;
    const rows = await db
      .selectFrom('knowledgeGraphEdgeSources')
      .select('sourcePageId')
      .where('workspaceId', '=', input.workspaceId)
      .where('graphEdgeId', 'in', (eb) =>
        eb
          .selectFrom('knowledgeGraphEdges')
          .select('id')
          .where('workspaceId', '=', input.workspaceId)
          .where('spaceId', 'in', spaceIds)
          .where('staleAt', 'is', null)
          .where((inner) =>
            inner.or([
              inner('fromKnowledgePageId', 'in', frontier),
              inner('toKnowledgePageId', 'in', frontier),
            ]),
          ),
      )
      .union((eb) =>
        eb
          .selectFrom('knowledgeLinkSources')
          .select('sourcePageId')
          .where('workspaceId', '=', input.workspaceId)
          .where('linkId', 'in', (inner) =>
            inner
              .selectFrom('knowledgeLinks')
              .select('id')
              .where('workspaceId', '=', input.workspaceId)
              .where('spaceId', 'in', spaceIds)
              .where('staleAt', 'is', null)
              .where((link) =>
                link.or([
                  link('fromKnowledgePageId', 'in', frontier),
                  link('toKnowledgePageId', 'in', frontier),
                ]),
              ),
          ),
      )
      .union((eb) =>
        eb
          .selectFrom('knowledgePageSources')
          .select('sourcePageId')
          .where('workspaceId', '=', input.workspaceId)
          .where('knowledgePageId', 'in', frontier),
      )
      .execute();

    return unique(rows.map((row) => row.sourcePageId));
  }

  async findGraphTraversalEdges(
    input: {
      workspaceId: string;
      spaceIds: string[];
      seeds: KnowledgeGraphTraversalSeed[];
      readableSourcePageIds: string[];
      limit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeGraphTraversalEdge[]> {
    if (
      input.spaceIds.length === 0 ||
      input.seeds.length === 0 ||
      input.limit <= 0
    ) {
      return [];
    }
    if (input.readableSourcePageIds.length === 0) return [];

    const db = dbOrTx(this.db, trx);
    const seedIds = input.seeds.map((seed) => seed.knowledgePageId);
    const seedWeights = input.seeds.map((seed) => seed.weight);
    const readableSources = input.readableSourcePageIds;
    const spaceIds = input.spaceIds;
    const sharedSourceCap = Math.max(1, Math.floor(input.limit / 4));
    const reservePerType = Math.max(1, Math.floor(input.limit / 4));
    const weightOf = KNOWLEDGE_GRAPH_EDGE_TYPE_WEIGHT;

    const rows = await sql<{
      id: string;
      fromKnowledgePageId: string;
      toKnowledgePageId: string;
      type: KnowledgeGraphEdgeType;
      sourcePageIds: string[];
    }>`
      WITH seed AS (
        SELECT *
        FROM unnest(
          ${sql.val(seedIds)}::uuid[],
          ${sql.val(seedWeights)}::double precision[]
        ) AS s(knowledge_page_id, weight)
      ),
      readable_source AS (
        SELECT unnest(${sql.val(readableSources)}::uuid[]) AS source_page_id
      ),
      link_edge AS (
        SELECT
          l.id::text AS id,
          l.from_knowledge_page_id,
          l.to_knowledge_page_id,
          'link' AS type,
          ${weightOf.link}::double precision AS type_weight,
          ARRAY(
            SELECT DISTINCT ls.source_page_id
            FROM knowledge_link_sources AS ls
            WHERE ls.workspace_id = l.workspace_id
              AND ls.link_id = l.id
            ORDER BY ls.source_page_id
          ) AS source_page_ids
        FROM knowledge_links AS l
        INNER JOIN knowledge_pages AS from_page
          ON from_page.id = l.from_knowledge_page_id
        INNER JOIN knowledge_pages AS to_page
          ON to_page.id = l.to_knowledge_page_id
        WHERE l.workspace_id = ${input.workspaceId}
          AND l.space_id IN (${sql.join(spaceIds)})
          AND l.link_type != 'catalog_entry'
          AND l.to_knowledge_page_id IS NOT NULL
          AND l.is_dangling = false
          AND l.stale_at IS NULL
          AND from_page.stale_at IS NULL
          AND to_page.stale_at IS NULL
          AND from_page.space_id = l.space_id
          AND to_page.space_id = l.space_id
          AND (
            l.from_knowledge_page_id IN (SELECT knowledge_page_id FROM seed)
            OR l.to_knowledge_page_id IN (SELECT knowledge_page_id FROM seed)
          )
          AND EXISTS (
            SELECT 1 FROM knowledge_link_sources AS ls
            WHERE ls.workspace_id = l.workspace_id AND ls.link_id = l.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_link_sources AS ls
            WHERE ls.workspace_id = l.workspace_id
              AND ls.link_id = l.id
              AND ls.source_page_id NOT IN (
                SELECT source_page_id FROM readable_source
              )
          )
      ),
      semantic_edge AS (
        SELECT
          e.id::text AS id,
          e.from_knowledge_page_id,
          e.to_knowledge_page_id,
          'semantic' AS type,
          ${weightOf.semantic}::double precision AS type_weight,
          ARRAY(
            SELECT DISTINCT es.source_page_id
            FROM knowledge_graph_edge_sources AS es
            WHERE es.workspace_id = e.workspace_id
              AND es.graph_edge_id = e.id
            ORDER BY es.source_page_id
          ) AS source_page_ids
        FROM knowledge_graph_edges AS e
        INNER JOIN knowledge_pages AS from_page
          ON from_page.id = e.from_knowledge_page_id
        INNER JOIN knowledge_pages AS to_page
          ON to_page.id = e.to_knowledge_page_id
        WHERE e.workspace_id = ${input.workspaceId}
          AND e.space_id IN (${sql.join(spaceIds)})
          AND e.relation != 'catalog_entry'
          AND e.is_dangling = false
          AND e.to_knowledge_page_id IS NOT NULL
          AND e.stale_at IS NULL
          AND from_page.stale_at IS NULL
          AND to_page.stale_at IS NULL
          AND from_page.space_id = e.space_id
          AND to_page.space_id = e.space_id
          AND (
            e.from_knowledge_page_id IN (SELECT knowledge_page_id FROM seed)
            OR e.to_knowledge_page_id IN (SELECT knowledge_page_id FROM seed)
          )
          AND EXISTS (
            SELECT 1 FROM knowledge_graph_edge_sources AS es
            WHERE es.workspace_id = e.workspace_id AND es.graph_edge_id = e.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_graph_edge_sources AS es
            WHERE es.workspace_id = e.workspace_id
              AND es.graph_edge_id = e.id
              AND es.source_page_id NOT IN (
                SELECT source_page_id FROM readable_source
              )
          )
      ),
      shared_source_pair AS (
        SELECT
          least(seed_source.knowledge_page_id, neighbor_source.knowledge_page_id)
            AS from_knowledge_page_id,
          greatest(seed_source.knowledge_page_id, neighbor_source.knowledge_page_id)
            AS to_knowledge_page_id,
          array_agg(DISTINCT seed_source.source_page_id
            ORDER BY seed_source.source_page_id) AS source_page_ids,
          bool_and(
            seed_source.source_page_id IN (
              SELECT source_page_id FROM readable_source
            )
          ) AS all_sources_readable
        FROM knowledge_page_sources AS seed_source
        INNER JOIN knowledge_page_sources AS neighbor_source
          ON neighbor_source.workspace_id = seed_source.workspace_id
          AND neighbor_source.source_page_id = seed_source.source_page_id
          AND neighbor_source.knowledge_page_id != seed_source.knowledge_page_id
        INNER JOIN knowledge_pages AS from_page
          ON from_page.id = seed_source.knowledge_page_id
        INNER JOIN knowledge_pages AS to_page
          ON to_page.id = neighbor_source.knowledge_page_id
        WHERE seed_source.workspace_id = ${input.workspaceId}
          AND seed_source.knowledge_page_id IN (
            SELECT knowledge_page_id FROM seed
          )
          AND from_page.stale_at IS NULL
          AND to_page.stale_at IS NULL
          AND from_page.space_id IN (${sql.join(spaceIds)})
          AND to_page.space_id = from_page.space_id
        GROUP BY 1, 2
      ),
      shared_source_edge AS (
        SELECT
          'derived-shared:' || from_knowledge_page_id || ':' || to_knowledge_page_id
            AS id,
          from_knowledge_page_id,
          to_knowledge_page_id,
          'shared-source' AS type,
          ${weightOf['shared-source']}::double precision AS type_weight,
          source_page_ids
        FROM shared_source_pair
        WHERE all_sources_readable
          AND array_length(source_page_ids, 1) > 0
      ),
      candidate AS (
        SELECT * FROM link_edge
        UNION ALL
        SELECT * FROM semantic_edge
        UNION ALL
        SELECT * FROM shared_source_edge
      ),
      weighted AS (
        SELECT
          c.*,
          COALESCE((
            SELECT max(s.weight) FROM seed AS s
            WHERE s.knowledge_page_id = c.from_knowledge_page_id
              OR s.knowledge_page_id = c.to_knowledge_page_id
          ), 0) AS seed_weight
        FROM candidate AS c
      ),
      ranked AS (
        SELECT
          w.*,
          row_number() OVER (
            PARTITION BY w.type
            ORDER BY w.seed_weight DESC, w.type_weight DESC, w.id ASC
          ) AS type_rank
        FROM weighted AS w
      )
      SELECT
        id,
        from_knowledge_page_id AS "fromKnowledgePageId",
        to_knowledge_page_id AS "toKnowledgePageId",
        type,
        source_page_ids AS "sourcePageIds"
      FROM ranked
      WHERE type != 'shared-source' OR type_rank <= ${sharedSourceCap}
      ORDER BY
        (type IN ('semantic', 'link') AND type_rank <= ${reservePerType}) DESC,
        seed_weight DESC,
        type_weight DESC,
        id ASC
      LIMIT ${input.limit}
    `.execute(db);

    return rows.rows.map((row) => ({
      id: row.id,
      fromKnowledgePageId: row.fromKnowledgePageId,
      toKnowledgePageId: row.toKnowledgePageId,
      type: row.type,
      weight: KNOWLEDGE_GRAPH_EDGE_TYPE_WEIGHT[row.type],
      sourcePageIds: row.sourcePageIds ?? [],
    }));
  }

  async findPagesByIds(
    input: { workspaceId: string; knowledgePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<KnowledgePage[]> {
    if (input.knowledgePageIds.length === 0) return [];

    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgePages')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('id', 'in', input.knowledgePageIds)
      .where('staleAt', 'is', null)
      .execute();
    const rowById = new Map(rows.map((row) => [row.id, row]));

    return input.knowledgePageIds
      .map((id) => rowById.get(id))
      .filter(Boolean) as KnowledgePage[];
  }

  async findSpacePageSourceIds(
    input: { workspaceId: string; spaceId: string },
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgePageSources as spaceSource')
      .innerJoin(
        'knowledgePages',
        'knowledgePages.id',
        'spaceSource.knowledgePageId',
      )
      .select('spaceSource.sourcePageId')
      .distinct()
      .where('spaceSource.workspaceId', '=', input.workspaceId)
      .where('knowledgePages.spaceId', '=', input.spaceId)
      .where('knowledgePages.staleAt', 'is', null)
      .execute();

    return rows.map((row) => row.sourcePageId);
  }

  async findGraphCandidatesForSpace(
    input: {
      workspaceId: string;
      spaceId: string;
      limit: number;
      readableSourcePageIds?: string[];
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeGraphCandidates> {
    const db = dbOrTx(this.db, trx);
    let pageQuery = db
      .selectFrom('knowledgePages')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('staleAt', 'is', null);
    if (input.readableSourcePageIds) {
      const readable = input.readableSourcePageIds;
      pageQuery = pageQuery.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('knowledgePageSources as quotaSource')
              .select(sql`1`.as('present'))
              .whereRef('quotaSource.knowledgePageId', '=', 'knowledgePages.id')
              .where('quotaSource.workspaceId', '=', input.workspaceId)
              .where((inner) =>
                readable.length === 0
                  ? inner.val(true)
                  : inner('quotaSource.sourcePageId', 'not in', readable),
              ),
          ),
        ),
      );
    }
    const pages = await pageQuery
      .orderBy('updatedAt', 'desc')
      .limit(input.limit)
      .execute();

    const pageIds = pages.map((page) => page.id);
    if (pageIds.length === 0) {
      return {
        pages,
        pageSources: [],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      };
    }

    const [pageSources, parentSections, links, graphEdges] = await Promise.all([
      db
        .selectFrom('knowledgePageSources')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('knowledgePageId', 'in', pageIds)
        .execute(),
      db
        .selectFrom('knowledgeParentSections')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('knowledgePageId', 'in', pageIds)
        .where('staleAt', 'is', null)
        .orderBy('knowledgePageId')
        .orderBy('startOffset')
        .limit(input.limit * 8)
        .execute(),
      db
        .selectFrom('knowledgeLinks')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('fromKnowledgePageId', 'in', pageIds)
        .where('toKnowledgePageId', 'is not', null)
        .where('isDangling', '=', false)
        .where('staleAt', 'is', null)
        .execute(),
      db
        .selectFrom('knowledgeGraphEdges')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('fromKnowledgePageId', 'in', pageIds)
        .where('toKnowledgePageId', 'is not', null)
        .where('isDangling', '=', false)
        .where('staleAt', 'is', null)
        .execute(),
    ]);

    const parentSectionIds = parentSections.map((section) => section.id);
    const linkIds = links.map((link) => link.id);
    const graphEdgeIds = graphEdges.map((edge) => edge.id);
    const [parentSectionSources, linkSources, graphEdgeSources] =
      await Promise.all([
        parentSectionIds.length === 0
          ? []
          : db
              .selectFrom('knowledgeParentSectionSources')
              .selectAll()
              .where('workspaceId', '=', input.workspaceId)
              .where('parentSectionId', 'in', parentSectionIds)
              .execute(),
        linkIds.length === 0
          ? []
          : db
              .selectFrom('knowledgeLinkSources')
              .selectAll()
              .where('workspaceId', '=', input.workspaceId)
              .where('linkId', 'in', linkIds)
              .execute(),
        graphEdgeIds.length === 0
          ? []
          : db
              .selectFrom('knowledgeGraphEdgeSources')
              .selectAll()
              .where('workspaceId', '=', input.workspaceId)
              .where('graphEdgeId', 'in', graphEdgeIds)
              .execute(),
      ]);

    return {
      pages,
      pageSources,
      parentSections,
      parentSectionSources,
      links,
      linkSources,
      graphEdges,
      graphEdgeSources,
    };
  }

  async findDependencySourcePageIds(
    input: { workspaceId: string; knowledgePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    if (input.knowledgePageIds.length === 0) return [];

    const db = dbOrTx(this.db, trx);
    const rows = await Promise.all([
      db
        .selectFrom('knowledgePageSources')
        .select('knowledgePageSources.sourcePageId')
        .where('knowledgePageSources.workspaceId', '=', input.workspaceId)
        .where(
          'knowledgePageSources.knowledgePageId',
          'in',
          input.knowledgePageIds,
        )
        .execute(),
      db
        .selectFrom('knowledgeClaimSources')
        .innerJoin(
          'knowledgeClaims',
          'knowledgeClaimSources.claimId',
          'knowledgeClaims.id',
        )
        .select('knowledgeClaimSources.sourcePageId')
        .where('knowledgeClaims.workspaceId', '=', input.workspaceId)
        .where('knowledgeClaims.knowledgePageId', 'in', input.knowledgePageIds)
        .execute(),
      db
        .selectFrom('knowledgeChunkSources')
        .innerJoin(
          'knowledgeChunks',
          'knowledgeChunkSources.chunkId',
          'knowledgeChunks.id',
        )
        .select('knowledgeChunkSources.sourcePageId')
        .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
        .where('knowledgeChunks.knowledgePageId', 'in', input.knowledgePageIds)
        .execute(),
      db
        .selectFrom('knowledgeLinkSources')
        .innerJoin(
          'knowledgeLinks',
          'knowledgeLinkSources.linkId',
          'knowledgeLinks.id',
        )
        .select('knowledgeLinkSources.sourcePageId')
        .where('knowledgeLinks.workspaceId', '=', input.workspaceId)
        .where(
          'knowledgeLinks.fromKnowledgePageId',
          'in',
          input.knowledgePageIds,
        )
        .execute(),
      db
        .selectFrom('knowledgeGraphEdgeSources')
        .innerJoin(
          'knowledgeGraphEdges',
          'knowledgeGraphEdgeSources.graphEdgeId',
          'knowledgeGraphEdges.id',
        )
        .select('knowledgeGraphEdgeSources.sourcePageId')
        .where('knowledgeGraphEdges.workspaceId', '=', input.workspaceId)
        .where(
          'knowledgeGraphEdges.fromKnowledgePageId',
          'in',
          input.knowledgePageIds,
        )
        .execute(),
    ]);

    return unique(
      rows.flat().map((row) => (row as SourcePageRow).sourcePageId),
    );
  }

  async findChunkSourcePageIds(
    input: { workspaceId: string; chunkId: string },
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunkSources')
      .select('knowledgeChunkSources.sourcePageId')
      .where('knowledgeChunkSources.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunkSources.chunkId', '=', input.chunkId)
      .execute();

    return unique(rows.map((row) => row.sourcePageId));
  }

  async findChunkSourcePageIdsByChunkIds(
    input: { workspaceId: string; chunkIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<Array<{ chunkId: string; sourcePageIds: string[] }>> {
    if (input.chunkIds.length === 0) return [];

    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunkSources')
      .select([
        'knowledgeChunkSources.chunkId',
        'knowledgeChunkSources.sourcePageId',
      ])
      .where('knowledgeChunkSources.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunkSources.chunkId', 'in', input.chunkIds)
      .execute();
    const sourcesByChunkId = groupBy(
      rows as ChunkSourcePageRow[],
      (row) => row.chunkId,
    );

    return input.chunkIds.map((chunkId) => ({
      chunkId,
      sourcePageIds: unique(
        (sourcesByChunkId.get(chunkId) ?? []).map((row) => row.sourcePageId),
      ),
    }));
  }

  async findChunkSourceRefsByChunkIds(
    input: { workspaceId: string; chunkIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<Array<{ chunkId: string; sources: KnowledgeChunkSourceRef[] }>> {
    if (input.chunkIds.length === 0) return [];

    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunkSources')
      .select([
        'knowledgeChunkSources.chunkId',
        'knowledgeChunkSources.sourcePageId',
        'knowledgeChunkSources.sourceVersion',
        'knowledgeChunkSources.contentHash',
        'knowledgeChunkSources.sourceRange',
        'knowledgeChunkSources.quoteHash',
      ])
      .where('knowledgeChunkSources.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunkSources.chunkId', 'in', input.chunkIds)
      .execute();
    const sourcesByChunkId = groupBy(
      rows as ChunkSourceRefRow[],
      (row) => row.chunkId,
    );

    return input.chunkIds.map((chunkId) => ({
      chunkId,
      sources: (sourcesByChunkId.get(chunkId) ?? []).map((row) => ({
        sourcePageId: row.sourcePageId,
        sourceVersion: row.sourceVersion,
        contentHash: row.contentHash,
        sourceRange: row.sourceRange,
        quoteHash: row.quoteHash,
      })),
    }));
  }

  async findChunkAttachmentsByChunkIds(
    input: { workspaceId: string; chunkIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<
    Array<{
      chunkId: string;
      attachments: Array<{
        occurrenceOrder: number;
        attachmentId: string;
        sourcePageId: string;
        sourceVersion: string;
        sourceContentHash: string;
        attachmentUpdatedAt: Date;
      }>;
    }>
  > {
    if (input.chunkIds.length === 0) return [];

    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunkAttachments')
      .select([
        'knowledgeChunkAttachments.chunkId',
        'knowledgeChunkAttachments.occurrenceOrder',
        'knowledgeChunkAttachments.attachmentId',
        'knowledgeChunkAttachments.sourcePageId',
        'knowledgeChunkAttachments.sourceVersion',
        'knowledgeChunkAttachments.sourceContentHash',
        'knowledgeChunkAttachments.attachmentUpdatedAt',
      ])
      .where('knowledgeChunkAttachments.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunkAttachments.chunkId', 'in', input.chunkIds)
      .orderBy('knowledgeChunkAttachments.occurrenceOrder', 'asc')
      .execute();
    const attachmentsByChunkId = groupBy(rows, (row) => row.chunkId);

    return input.chunkIds.map((chunkId) => ({
      chunkId,
      attachments: (attachmentsByChunkId.get(chunkId) ?? [])
        .slice()
        .sort((a, b) => a.occurrenceOrder - b.occurrenceOrder)
        .map((row) => ({
          occurrenceOrder: row.occurrenceOrder,
          attachmentId: row.attachmentId,
          sourcePageId: row.sourcePageId,
          sourceVersion: row.sourceVersion,
          sourceContentHash: row.sourceContentHash,
          attachmentUpdatedAt: new Date(row.attachmentUpdatedAt),
        })),
    }));
  }

  async markCapsulesStaleBySourcePageIds(
    input: { workspaceId: string; sourcePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.sourcePageIds.length === 0) return;

    const db = dbOrTx(this.db, trx);
    const [pageRows, claimRows, chunkRows, linkRows, graphEdgeRows] =
      await Promise.all([
        db
          .selectFrom('knowledgePageSources')
          .select('knowledgePageSources.knowledgePageId')
          .where('knowledgePageSources.workspaceId', '=', input.workspaceId)
          .where('knowledgePageSources.sourcePageId', 'in', input.sourcePageIds)
          .execute(),
        db
          .selectFrom('knowledgeClaimSources')
          .select('knowledgeClaimSources.claimId')
          .where('knowledgeClaimSources.workspaceId', '=', input.workspaceId)
          .where(
            'knowledgeClaimSources.sourcePageId',
            'in',
            input.sourcePageIds,
          )
          .execute(),
        db
          .selectFrom('knowledgeChunkSources')
          .select('knowledgeChunkSources.chunkId')
          .where('knowledgeChunkSources.workspaceId', '=', input.workspaceId)
          .where(
            'knowledgeChunkSources.sourcePageId',
            'in',
            input.sourcePageIds,
          )
          .execute(),
        db
          .selectFrom('knowledgeLinkSources')
          .select('knowledgeLinkSources.linkId')
          .where('knowledgeLinkSources.workspaceId', '=', input.workspaceId)
          .where('knowledgeLinkSources.sourcePageId', 'in', input.sourcePageIds)
          .execute(),
        db
          .selectFrom('knowledgeGraphEdgeSources')
          .select('knowledgeGraphEdgeSources.graphEdgeId')
          .where(
            'knowledgeGraphEdgeSources.workspaceId',
            '=',
            input.workspaceId,
          )
          .where(
            'knowledgeGraphEdgeSources.sourcePageId',
            'in',
            input.sourcePageIds,
          )
          .execute(),
      ]);

    await Promise.all([
      this.markStale(
        'knowledgePages',
        unique(
          pageRows.map(
            (row) => (row as OwnerRow<'knowledgePageId'>).knowledgePageId,
          ),
        ),
        input.workspaceId,
        trx,
      ),
      this.markStale(
        'knowledgeClaims',
        unique(claimRows.map((row) => (row as OwnerRow<'claimId'>).claimId)),
        input.workspaceId,
        trx,
      ),
      this.markStale(
        'knowledgeChunks',
        unique(chunkRows.map((row) => (row as OwnerRow<'chunkId'>).chunkId)),
        input.workspaceId,
        trx,
      ),
      this.markStale(
        'knowledgeLinks',
        unique(linkRows.map((row) => (row as OwnerRow<'linkId'>).linkId)),
        input.workspaceId,
        trx,
      ),
      this.markStale(
        'knowledgeGraphEdges',
        unique(
          graphEdgeRows.map(
            (row) => (row as OwnerRow<'graphEdgeId'>).graphEdgeId,
          ),
        ),
        input.workspaceId,
        trx,
      ),
    ]);
  }

  async markSourceArtifactsStaleBySourcePageIds(
    input: { workspaceId: string; spaceId?: string; sourcePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.sourcePageIds.length === 0) return;

    const db = dbOrTx(this.db, trx);
    const pageRows = await db
      .selectFrom('knowledgePages')
      .innerJoin(
        'knowledgePageSources',
        'knowledgePageSources.knowledgePageId',
        'knowledgePages.id',
      )
      .select('knowledgePages.id')
      .distinct()
      .where('knowledgePages.workspaceId', '=', input.workspaceId)
      .$if(Boolean(input.spaceId), (query) =>
        query.where('knowledgePages.spaceId', '=', input.spaceId!),
      )
      .where('knowledgePages.pageType', '=', 'source_summary')
      .where('knowledgePageSources.sourcePageId', 'in', input.sourcePageIds)
      .execute();
    const knowledgePageIds = pageRows.map((row) => row.id);
    if (knowledgePageIds.length === 0) return;

    await Promise.all([
      db
        .updateTable('knowledgePages')
        .set({ staleAt: new Date() })
        .where('workspaceId', '=', input.workspaceId)
        .where('id', 'in', knowledgePageIds)
        .execute(),
      db
        .updateTable('knowledgeClaims')
        .set({ staleAt: new Date() })
        .where('workspaceId', '=', input.workspaceId)
        .where('knowledgePageId', 'in', knowledgePageIds)
        .execute(),
      db
        .updateTable('knowledgeChunks')
        .set({ staleAt: new Date() })
        .where('workspaceId', '=', input.workspaceId)
        .where('knowledgePageId', 'in', knowledgePageIds)
        .execute(),
      db
        .updateTable('knowledgeLinks')
        .set({ staleAt: new Date() })
        .where('workspaceId', '=', input.workspaceId)
        .where('fromKnowledgePageId', 'in', knowledgePageIds)
        .execute(),
      db
        .updateTable('knowledgeGraphEdges')
        .set({ staleAt: new Date() })
        .where('workspaceId', '=', input.workspaceId)
        .where('fromKnowledgePageId', 'in', knowledgePageIds)
        .execute(),
    ]);
  }

  private async markStale(
    table:
      | 'knowledgePages'
      | 'knowledgeClaims'
      | 'knowledgeChunks'
      | 'knowledgeLinks'
      | 'knowledgeGraphEdges',
    ids: string[],
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (ids.length === 0) return;

    await dbOrTx(this.db, trx)
      .updateTable(table)
      .set({ staleAt: new Date() })
      .where('workspaceId', '=', workspaceId)
      .where('id', 'in', ids)
      .execute();
  }

  private applyAuthorizedChunkScope<T>(
    query: T,
    input: AuthorizedCandidateInput,
  ): T {
    const principalMatch = sql<boolean>`(${sql.join(
      input.principals.map(
        (principal) => sql<boolean>`(
          acl_principal.principal_type = ${principal.principalType}
          AND acl_principal.principal_id = ${principal.principalId}
        )`,
      ),
      sql` OR `,
    )})`;

    const sourcePresence = sql<boolean>`
      EXISTS (
        SELECT 1
        FROM knowledge_chunk_sources AS source_presence
        WHERE source_presence.workspace_id = ${input.workspaceId}
          AND source_presence.chunk_id = knowledge_chunks.id
      )
    `;
    const labelScope =
      input.labelNames && input.labelNames.length > 0
        ? sql<boolean>`
            NOT EXISTS (
              SELECT 1
              FROM knowledge_chunk_sources AS label_source
              WHERE label_source.workspace_id = ${input.workspaceId}
                AND label_source.chunk_id = knowledge_chunks.id
                AND NOT EXISTS (
                  SELECT 1
                  FROM page_labels AS matching_page_label
                  INNER JOIN labels AS matching_label
                    ON matching_label.id = matching_page_label.label_id
                  WHERE matching_page_label.page_id = label_source.source_page_id
                    AND matching_label.workspace_id = ${input.workspaceId}
                    AND matching_label.type = 'page'
                    AND matching_label.name IN (${sql.join(input.labelNames)})
                )
            )
          `
        : sql<boolean>`TRUE`;
    if (input.authorizationMode === 'final-authorization-fallback') {
      return (query as any).where(sql<boolean>`
        ${sourcePresence} AND ${labelScope}
      `);
    }

    return (query as any).where(sql<boolean>`
      ${sourcePresence}
      AND ${labelScope}
      AND NOT EXISTS (
        SELECT 1
        FROM knowledge_chunk_sources AS acl_source
        WHERE acl_source.workspace_id = ${input.workspaceId}
          AND acl_source.chunk_id = knowledge_chunks.id
          AND (
            NOT EXISTS (
              SELECT 1
              FROM knowledge_source_access_policy AS acl_policy
              WHERE acl_policy.workspace_id = ${input.workspaceId}
                AND acl_policy.source_page_id = acl_source.source_page_id
                AND acl_policy.stale_at IS NULL
            )
            OR EXISTS (
              SELECT 1
              FROM knowledge_source_access_policy AS restricted_policy
              WHERE restricted_policy.workspace_id = ${input.workspaceId}
                AND restricted_policy.source_page_id = acl_source.source_page_id
                AND restricted_policy.stale_at IS NULL
                AND restricted_policy.restricted_ancestor_count > 0
                AND (
                  NOT EXISTS (
                    SELECT 1
                    FROM knowledge_source_access_requirements AS missing_requirement
                    WHERE missing_requirement.workspace_id = ${input.workspaceId}
                      AND missing_requirement.source_page_id = acl_source.source_page_id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM knowledge_source_access_requirements AS acl_requirement
                    WHERE acl_requirement.workspace_id = ${input.workspaceId}
                      AND acl_requirement.source_page_id = acl_source.source_page_id
                      AND NOT EXISTS (
                        SELECT 1
                        FROM knowledge_source_access_principals AS acl_principal
                        WHERE acl_principal.workspace_id = ${input.workspaceId}
                          AND acl_principal.source_page_id = acl_requirement.source_page_id
                          AND acl_principal.requirement_id = acl_requirement.requirement_id
                          AND ${principalMatch}
                      )
                  )
                )
            )
          )
      )
    `);
  }

  private async hydrateRankedChunkCandidates(
    rows: RankedChunkId[],
    signal: KnowledgeRetrievalSignal,
    input: AuthorizedCandidateInput,
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (rows.length === 0) return [];

    const chunkIds = rows.map((row) => row.chunkId);
    const [chunks, sourceRows] = await Promise.all([
      dbOrTx(this.db, trx)
        .selectFrom('knowledgeChunks')
        .selectAll()
        .where('workspaceId', '=', input.workspaceId)
        .where('id', 'in', chunkIds)
        .where('staleAt', 'is', null)
        .execute(),
      this.findChunkSourcePageIdsByChunkIds(
        { workspaceId: input.workspaceId, chunkIds },
        trx,
      ),
    ]);
    const pages = await this.findPagesByIds(
      {
        workspaceId: input.workspaceId,
        knowledgePageIds: unique(chunks.map((chunk) => chunk.knowledgePageId)),
      },
      trx,
    );
    const parentSectionIds = unique(
      chunks.flatMap((chunk) =>
        chunk.parentSectionId ? [chunk.parentSectionId] : [],
      ),
    );
    const parentSections = parentSectionIds.length
      ? await dbOrTx(this.db, trx)
          .selectFrom('knowledgeParentSections')
          .selectAll()
          .where('workspaceId', '=', input.workspaceId)
          .where('id', 'in', parentSectionIds)
          .where('staleAt', 'is', null)
          .execute()
      : [];
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const sourcesByChunkId = new Map(
      sourceRows.map((row) => [row.chunkId, row.sourcePageIds]),
    );
    const parentById = new Map(
      parentSections.map((parent) => [parent.id, parent]),
    );

    return rows.flatMap((row) => {
      const chunk = chunkById.get(row.chunkId);
      if (!chunk) return [];
      const page = pageById.get(chunk.knowledgePageId);
      const sourcePageIds = sourcesByChunkId.get(row.chunkId) ?? [];
      if (!page || sourcePageIds.length === 0) {
        return [];
      }

      const parentSection = chunk.parentSectionId
        ? parentById.get(chunk.parentSectionId)
        : undefined;
      return [
        {
          chunk,
          page,
          sourcePageIds,
          signals: [signal],
          lexicalScore: signal === 'lexical' ? row.score : null,
          signalScore: row.score,
          ...(parentSection ? { parentSection } : {}),
        },
      ];
    });
  }

  private async deleteChildArtifacts(
    knowledgePageId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);

    await db
      .deleteFrom('knowledgeGraphEdges')
      .where('fromKnowledgePageId', '=', knowledgePageId)
      .execute();
    await db
      .deleteFrom('knowledgeLinks')
      .where('fromKnowledgePageId', '=', knowledgePageId)
      .execute();
    await db
      .deleteFrom('knowledgeChunks')
      .where('knowledgePageId', '=', knowledgePageId)
      .execute();
    await db
      .deleteFrom('knowledgeParentSections')
      .where('knowledgePageId', '=', knowledgePageId)
      .execute();
    await db
      .deleteFrom('knowledgeClaims')
      .where('knowledgePageId', '=', knowledgePageId)
      .execute();
    await db
      .deleteFrom('knowledgePageSources')
      .where('knowledgePageId', '=', knowledgePageId)
      .execute();
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function orderedPair(first: string, second: string): [string, string] {
  return first.localeCompare(second) <= 0 ? [first, second] : [second, first];
}

function pairKey(first: string, second: string): string {
  return `${first}\u001f${second}`;
}

function normalizeCatalogSignal(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
}

function splitPairKey(key: string): [string, string] {
  const separator = key.indexOf('\u001f');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

// Lexical recall needs every rare term of a 1–2 term query and 75% (floored)
// of a longer one, roughly the old AND semantics but tolerant of extra words.
export const LEXICAL_MINIMUM_SHOULD_MATCH_RATIO = 0.75;
// A term in more than 5% of the scope's chunks (and more than 20 chunks) is a
// common term: it only affects ranking and never qualifies a chunk alone.
export const LEXICAL_COMMON_TERM_RATIO = 0.05;
export const LEXICAL_COMMON_TERM_MIN_DOCUMENTS = 20;

export function minimumShouldMatch(termCount: number): number {
  return termCount <= 2
    ? termCount
    : Math.floor(termCount * LEXICAL_MINIMUM_SHOULD_MATCH_RATIO);
}

function hasCandidateScope(input: AuthorizedCandidateInput): boolean {
  return input.spaceIds.length > 0 && input.principals.length > 0;
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}
