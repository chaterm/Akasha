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
  InsertableKnowledgeLink,
  InsertableKnowledgeLinkSource,
  InsertableKnowledgeGraphEdge,
  InsertableKnowledgeGraphEdgeSource,
  KnowledgeChunk,
  KnowledgeClaim,
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
export type UpsertCompiledArtifactInput = {
  page: InsertableKnowledgePage;
  pageSources?: InsertableKnowledgePageSource[];
  parentSections?: InsertableKnowledgeParentSection[];
  parentSectionSources?: InsertableKnowledgeParentSectionSource[];
  claims?: InsertableKnowledgeClaim[];
  claimSources?: InsertableKnowledgeClaimSource[];
  chunks?: InsertableKnowledgeChunk[];
  chunkSources?: InsertableKnowledgeChunkSource[];
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
  | 'graph-neighbor';
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

export type KnowledgeGraphTraversalEdge = {
  id: string;
  fromKnowledgePageId: string;
  toKnowledgePageId: string;
  type: 'link' | 'semantic';
  weight: number;
  sourcePageIds: string[];
};

export type ActiveKnowledgeArtifactCatalogRow = {
  artifactId: string;
  artifactKind: string;
  canonicalKey: string;
  title: string;
  body: string;
};

@Injectable()
export class KnowledgeCapsuleRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findActiveArtifactCatalog(input: {
    workspaceId: string;
    spaceId: string;
    limit?: number;
  }): Promise<ActiveKnowledgeArtifactCatalogRow[]> {
    return this.db
      .selectFrom('knowledgePages')
      .select([
        'id as artifactId',
        'pageType as artifactKind',
        'canonicalKey',
        'title',
        'body',
      ])
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('staleAt', 'is', null)
      .where('canonicalKey', 'is not', null)
      .where('pageType', 'in', [
        'source_summary',
        'concept',
        'entity',
        'comparison',
      ])
      .orderBy('pageType', 'asc')
      .orderBy('canonicalKey', 'asc')
      .limit(Math.min(Math.max(input.limit ?? 2_000, 1), 5_000))
      .execute() as Promise<ActiveKnowledgeArtifactCatalogRow[]>;
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
      inputs.flatMap((input) => input.links ?? []),
      'knowledgeLinks',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.linkSources ?? []),
      'knowledgeLinkSources',
    );
    await this.insertArtifactChildren(
      db,
      inputs.flatMap((input) => input.graphEdges ?? []),
      'knowledgeGraphEdges',
    );
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
      | 'knowledgeLinks'
      | 'knowledgeLinkSources'
      | 'knowledgeGraphEdges'
      | 'knowledgeGraphEdgeSources',
  ): Promise<void> {
    if (rows.length === 0) return;

    await db
      .insertInto(table)
      .values(rows as never)
      .execute();
  }

  async markCompileScopeStale(
    input: { workspaceId: string; spaceId: string },
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    const staleAt = new Date();
    const stalePages = await db
      .updateTable('knowledgePages')
      .set({ staleAt })
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('compileScope', '=', 'space')
      .returning('id')
      .execute();
    const artifactIds = stalePages.map((page) => page.id);
    if (artifactIds.length === 0) return;

    await Promise.all([
      db
        .updateTable('knowledgeParentSections')
        .set({ staleAt })
        .where('knowledgePageId', 'in', artifactIds)
        .execute(),
      db
        .updateTable('knowledgeClaims')
        .set({ staleAt })
        .where('knowledgePageId', 'in', artifactIds)
        .execute(),
      db
        .updateTable('knowledgeChunks')
        .set({ staleAt })
        .where('knowledgePageId', 'in', artifactIds)
        .execute(),
      db
        .updateTable('knowledgeLinks')
        .set({ staleAt })
        .where('fromKnowledgePageId', 'in', artifactIds)
        .execute(),
      db
        .updateTable('knowledgeGraphEdges')
        .set({ staleAt })
        .where('fromKnowledgePageId', 'in', artifactIds)
        .execute(),
    ]);
  }

  async markArtifactsStaleByIds(
    input: { workspaceId: string; artifactIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<void> {
    if (input.artifactIds.length === 0) return;
    const db = dbOrTx(this.db, trx);
    const staleAt = new Date();
    await Promise.all([
      db
        .updateTable('knowledgePages')
        .set({ staleAt })
        .where('workspaceId', '=', input.workspaceId)
        .where('id', 'in', input.artifactIds)
        .execute(),
      db
        .updateTable('knowledgeParentSections')
        .set({ staleAt })
        .where('workspaceId', '=', input.workspaceId)
        .where('knowledgePageId', 'in', input.artifactIds)
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
          .where(ownerColumn, 'in', input.artifactIds)
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
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (!hasCandidateScope(input) || input.embedding.vector.length === 0) {
      return [];
    }
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
    input: AuthorizedCandidateInput & { query: string; limit: number },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (!hasCandidateScope(input) || input.query.trim().length === 0) return [];

    const db = dbOrTx(this.db, trx);
    const tsQuery = sql`websearch_to_tsquery('simple', ${input.query.trim()})`;
    const rank = sql<number>`ts_rank_cd(knowledge_chunks.search_tsv, ${tsQuery})`;
    let query = db
      .selectFrom('knowledgeChunks')
      .select(['knowledgeChunks.id as chunkId', rank.as('score')])
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .where(sql<boolean>`knowledge_chunks.search_tsv @@ ${tsQuery}`);
    if (input.retrievalChannel) {
      query = query.where(
        'knowledgeChunks.retrievalChannel',
        '=',
        input.retrievalChannel,
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

  async findGraphChunkCandidates(
    input: AuthorizedCandidateInput & {
      knowledgePageIds: string[];
      limit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (
      !hasCandidateScope(input) ||
      input.knowledgePageIds.length === 0 ||
      input.limit <= 0
    ) {
      return [];
    }

    const db = dbOrTx(this.db, trx);
    const channelPriority = sql<number>`CASE
      WHEN knowledge_chunks.retrieval_channel = 'evidence' THEN 0
      ELSE 1
    END`;
    let query = db
      .selectFrom('knowledgeChunks')
      .distinctOn('knowledgeChunks.knowledgePageId')
      .select(['knowledgeChunks.id as chunkId', sql<number>`1`.as('score')])
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.knowledgePageId', 'in', input.knowledgePageIds)
      .where('knowledgeChunks.staleAt', 'is', null);
    if (input.retrievalChannel) {
      query = query.where(
        'knowledgeChunks.retrievalChannel',
        '=',
        input.retrievalChannel,
      );
    }
    const rows = await this.applyAuthorizedChunkScope(query, input)
      .orderBy('knowledgeChunks.knowledgePageId')
      .orderBy(channelPriority)
      .orderBy('chunkId')
      .limit(input.limit)
      .execute();

    return this.hydrateRankedChunkCandidates(
      rows as RankedChunkId[],
      'graph-neighbor',
      input,
      trx,
    );
  }

  async findGraphTraversalEdges(
    input: {
      workspaceId: string;
      spaceIds: string[];
      knowledgePageIds: string[];
      limit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeGraphTraversalEdge[]> {
    if (
      input.spaceIds.length === 0 ||
      input.knowledgePageIds.length === 0 ||
      input.limit <= 0
    ) {
      return [];
    }

    const db = dbOrTx(this.db, trx);
    const [links, graphEdges, sharedSourceEdges] = await Promise.all([
      db
        .selectFrom('knowledgeLinks')
        .innerJoin(
          'knowledgePages as traversalLinkFromPage',
          'traversalLinkFromPage.id',
          'knowledgeLinks.fromKnowledgePageId',
        )
        .innerJoin(
          'knowledgePages as traversalLinkToPage',
          'traversalLinkToPage.id',
          'knowledgeLinks.toKnowledgePageId',
        )
        .select([
          'knowledgeLinks.id',
          'knowledgeLinks.fromKnowledgePageId',
          'knowledgeLinks.toKnowledgePageId',
        ])
        .where('knowledgeLinks.workspaceId', '=', input.workspaceId)
        .where('knowledgeLinks.spaceId', 'in', input.spaceIds)
        .where('knowledgeLinks.linkType', '!=', 'catalog_entry')
        .where('knowledgeLinks.toKnowledgePageId', 'is not', null)
        .where('knowledgeLinks.isDangling', '=', false)
        .where('knowledgeLinks.staleAt', 'is', null)
        .where('traversalLinkFromPage.staleAt', 'is', null)
        .where('traversalLinkToPage.staleAt', 'is', null)
        .where('traversalLinkFromPage.spaceId', 'in', input.spaceIds)
        .where('traversalLinkToPage.spaceId', 'in', input.spaceIds)
        .where((expression) =>
          expression.or([
            expression(
              'knowledgeLinks.fromKnowledgePageId',
              'in',
              input.knowledgePageIds,
            ),
            expression(
              'knowledgeLinks.toKnowledgePageId',
              'in',
              input.knowledgePageIds,
            ),
          ]),
        )
        .limit(input.limit)
        .execute(),
      db
        .selectFrom('knowledgeGraphEdges')
        .innerJoin(
          'knowledgePages as traversalEdgeFromPage',
          'traversalEdgeFromPage.id',
          'knowledgeGraphEdges.fromKnowledgePageId',
        )
        .innerJoin(
          'knowledgePages as traversalEdgeToPage',
          'traversalEdgeToPage.id',
          'knowledgeGraphEdges.toKnowledgePageId',
        )
        .select([
          'knowledgeGraphEdges.id',
          'knowledgeGraphEdges.fromKnowledgePageId',
          'knowledgeGraphEdges.toKnowledgePageId',
        ])
        .where('knowledgeGraphEdges.workspaceId', '=', input.workspaceId)
        .where('knowledgeGraphEdges.spaceId', 'in', input.spaceIds)
        .where('knowledgeGraphEdges.relation', '!=', 'catalog_entry')
        .where('knowledgeGraphEdges.staleAt', 'is', null)
        .where('traversalEdgeFromPage.staleAt', 'is', null)
        .where('traversalEdgeToPage.staleAt', 'is', null)
        .where('traversalEdgeFromPage.spaceId', 'in', input.spaceIds)
        .where('traversalEdgeToPage.spaceId', 'in', input.spaceIds)
        .where((expression) =>
          expression.or([
            expression(
              'knowledgeGraphEdges.fromKnowledgePageId',
              'in',
              input.knowledgePageIds,
            ),
            expression(
              'knowledgeGraphEdges.toKnowledgePageId',
              'in',
              input.knowledgePageIds,
            ),
          ]),
        )
        .limit(input.limit)
        .execute(),
      db
        .selectFrom('knowledgePageSources as traversalSeedSource')
        .innerJoin('knowledgePageSources as traversalNeighborSource', (join) =>
          join
            .onRef(
              'traversalNeighborSource.workspaceId',
              '=',
              'traversalSeedSource.workspaceId',
            )
            .onRef(
              'traversalNeighborSource.sourcePageId',
              '=',
              'traversalSeedSource.sourcePageId',
            )
            .onRef(
              'traversalNeighborSource.knowledgePageId',
              '!=',
              'traversalSeedSource.knowledgePageId',
            ),
        )
        .innerJoin(
          'knowledgePages as traversalDerivedFromPage',
          'traversalDerivedFromPage.id',
          'traversalSeedSource.knowledgePageId',
        )
        .innerJoin(
          'knowledgePages as traversalDerivedToPage',
          'traversalDerivedToPage.id',
          'traversalNeighborSource.knowledgePageId',
        )
        .select([
          'traversalSeedSource.knowledgePageId as fromKnowledgePageId',
          'traversalNeighborSource.knowledgePageId as toKnowledgePageId',
          'traversalSeedSource.sourcePageId',
        ])
        .where('traversalSeedSource.workspaceId', '=', input.workspaceId)
        .where(
          'traversalSeedSource.knowledgePageId',
          'in',
          input.knowledgePageIds,
        )
        .where('traversalDerivedFromPage.staleAt', 'is', null)
        .where('traversalDerivedToPage.staleAt', 'is', null)
        .where('traversalDerivedFromPage.spaceId', 'in', input.spaceIds)
        .where('traversalDerivedToPage.spaceId', 'in', input.spaceIds)
        .limit(input.limit)
        .execute(),
    ]);
    const linkIds = links.map((link) => link.id);
    const graphEdgeIds = graphEdges.map((edge) => edge.id);
    const [linkSources, graphEdgeSources] = await Promise.all([
      linkIds.length === 0
        ? []
        : db
            .selectFrom('knowledgeLinkSources')
            .select(['linkId', 'sourcePageId'])
            .where('workspaceId', '=', input.workspaceId)
            .where('linkId', 'in', linkIds)
            .execute(),
      graphEdgeIds.length === 0
        ? []
        : db
            .selectFrom('knowledgeGraphEdgeSources')
            .select(['graphEdgeId', 'sourcePageId'])
            .where('workspaceId', '=', input.workspaceId)
            .where('graphEdgeId', 'in', graphEdgeIds)
            .execute(),
    ]);
    const linkSourcesById = groupBy(linkSources, (source) => source.linkId);
    const graphSourcesById = groupBy(
      graphEdgeSources,
      (source) => source.graphEdgeId,
    );

    const sharedSourcesByPair = new Map<string, string[]>();
    for (const edge of sharedSourceEdges) {
      const [from, to] = orderedPair(
        edge.fromKnowledgePageId,
        edge.toKnowledgePageId,
      );
      const key = pairKey(from, to);
      sharedSourcesByPair.set(
        key,
        unique([...(sharedSourcesByPair.get(key) ?? []), edge.sourcePageId]),
      );
    }

    return [
      ...links.flatMap((link) => {
        if (!link.toKnowledgePageId) return [];
        const sourcePageIds = unique(
          (linkSourcesById.get(link.id) ?? []).map(
            (source) => source.sourcePageId,
          ),
        );
        return sourcePageIds.length === 0
          ? []
          : [
              {
                id: link.id,
                fromKnowledgePageId: link.fromKnowledgePageId,
                toKnowledgePageId: link.toKnowledgePageId,
                type: 'link' as const,
                weight: 3,
                sourcePageIds,
              },
            ];
      }),
      ...graphEdges.flatMap((edge) => {
        const sourcePageIds = unique(
          (graphSourcesById.get(edge.id) ?? []).map(
            (source) => source.sourcePageId,
          ),
        );
        return sourcePageIds.length === 0
          ? []
          : [
              {
                id: edge.id,
                fromKnowledgePageId: edge.fromKnowledgePageId,
                toKnowledgePageId: edge.toKnowledgePageId,
                type: 'semantic' as const,
                weight: 2,
                sourcePageIds,
              },
            ];
      }),
      ...[...sharedSourcesByPair].map(([key, sourcePageIds]) => {
        const [fromKnowledgePageId, toKnowledgePageId] = splitPairKey(key);
        return {
          id: `derived-shared:${fromKnowledgePageId}:${toKnowledgePageId}`,
          fromKnowledgePageId,
          toKnowledgePageId,
          type: 'semantic' as const,
          weight: 4,
          sourcePageIds,
        };
      }),
    ]
      .sort(
        (left, right) =>
          right.weight - left.weight || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
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

  /**
   * 读取一批 knowledge page 的 claims(供 LLM Wiki review 阶段做论断级审查)。
   * 只读、不改任何编译产物;按 (knowledgePageId, position) 升序,保证每页 claims
   * 顺序与编译时一致。过滤 staleAt 与现有读取方法保持一致(只返回有效产物)。
   */
  async findClaimsByPageIds(
    input: { workspaceId: string; knowledgePageIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeClaim[]> {
    if (input.knowledgePageIds.length === 0) return [];

    return dbOrTx(this.db, trx)
      .selectFrom('knowledgeClaims')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('knowledgePageId', 'in', input.knowledgePageIds)
      .where('staleAt', 'is', null)
      .orderBy('knowledgePageId')
      .orderBy('position')
      .execute();
  }

  async findGraphCandidatesForSpace(
    input: { workspaceId: string; spaceId: string; limit: number },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeGraphCandidates> {
    const db = dbOrTx(this.db, trx);
    const pages = await db
      .selectFrom('knowledgePages')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('staleAt', 'is', null)
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
    input: { workspaceId: string; sourcePageIds: string[] },
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
    if (input.authorizationMode === 'final-authorization-fallback') {
      return (query as any).where(sourcePresence);
    }

    return (query as any).where(sql<boolean>`
      ${sourcePresence}
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

function splitPairKey(key: string): [string, string] {
  const separator = key.indexOf('\u001f');
  return [key.slice(0, separator), key.slice(separator + 1)];
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
