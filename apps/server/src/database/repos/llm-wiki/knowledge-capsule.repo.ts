import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { dbOrTx } from '@akasha/db/utils';
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
export type KnowledgeRetrievalSignal = 'semantic' | 'lexical' | 'exact-title';
export type KnowledgeChunkCandidate = {
  chunk: KnowledgeChunk;
  page: KnowledgePage;
  sourcePageIds: string[];
  signals: KnowledgeRetrievalSignal[];
  lexicalScore?: number | null;
  signalScore?: number | null;
  parentSection?: KnowledgeParentSection;
};
export type AuthorizedCandidateInput = {
  workspaceId: string;
  spaceIds: string[];
  eligibleSourcePageIds: string[];
  retrievalChannel?: 'evidence' | 'memory';
};
type RankedChunkId = { chunkId: string; score: number | null };
export type KnowledgeChunkSourceRef = {
  sourcePageId: string;
  sourceVersion: string;
  contentHash: string;
  sourceRange: unknown;
  quoteHash: string | null;
};

@Injectable()
export class KnowledgeCapsuleRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

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
          pageType: input.page.pageType ?? null,
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
    const tables = [
      'knowledgeClaims',
      'knowledgeChunks',
      'knowledgeLinks',
      'knowledgeGraphEdges',
    ] as const;

    await db
      .updateTable('knowledgePages')
      .set({ staleAt: new Date() })
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('compileScope', '=', 'space')
      .execute();

    await Promise.all(
      tables.map((table) =>
        db
          .updateTable(table)
          .set({ staleAt: new Date() })
          .where('workspaceId', '=', input.workspaceId)
          .where('spaceId', '=', input.spaceId)
          .execute(),
      ),
    );
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

    const db = dbOrTx(this.db, trx);
    const dimensions = sql.raw(String(input.embedding.dimensions));
    const queryVector = vectorToSql(input.embedding.vector);
    const distance = sql<number>`knowledge_chunks.embedding::vector(${dimensions}) <=> ${queryVector}::vector`;
    let query = db
      .selectFrom('knowledgeChunks')
      .select(['knowledgeChunks.id as chunkId', distance.as('score')])
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .where('knowledgeChunks.embeddingProfile', '=', input.embedding.profile)
      .where(
        'knowledgeChunks.embeddingDimensions',
        '=',
        input.embedding.dimensions,
      )
      .where('knowledgeChunks.embedding', 'is not', null);
    if (input.retrievalChannel) {
      query = query.where(
        'knowledgeChunks.retrievalChannel',
        '=',
        input.retrievalChannel,
      );
    }
    const rows = await this.applyAuthorizedChunkScope(
      query,
      input.eligibleSourcePageIds,
    )
      .orderBy(distance, 'asc')
      .limit(input.limit)
      .execute();

    return this.hydrateRankedChunkCandidates(
      rows as RankedChunkId[],
      'semantic',
      input,
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
    const rows = await this.applyAuthorizedChunkScope(
      query,
      input.eligibleSourcePageIds,
    )
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
    const rows = await this.applyAuthorizedChunkScope(
      query,
      input.eligibleSourcePageIds,
    )
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

  async findCandidateDependencySourcePageIds(
    input: {
      workspaceId: string;
      spaceIds: string[];
      query: string;
      signals: KnowledgeRetrievalSignal[];
      sourceCandidateLimit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    if (input.spaceIds.length === 0) return [];

    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunkSources')
      .innerJoin(
        'knowledgeChunks',
        'knowledgeChunkSources.chunkId',
        'knowledgeChunks.id',
      )
      .select('knowledgeChunkSources.sourcePageId')
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .limit(input.sourceCandidateLimit)
      .execute();

    return unique(rows.map((row) => row.sourcePageId));
  }

  async findDependencySourcePageIdsForSpaces(
    input: { workspaceId: string; spaceIds: string[] },
    trx?: KyselyTransaction,
  ): Promise<string[]> {
    if (input.spaceIds.length === 0) return [];

    const rows = await dbOrTx(this.db, trx)
      .selectFrom('knowledgeChunkSources')
      .innerJoin(
        'knowledgeChunks',
        'knowledgeChunkSources.chunkId',
        'knowledgeChunks.id',
      )
      .select('knowledgeChunkSources.sourcePageId')
      .distinct()
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .execute();

    return rows.map((row) => row.sourcePageId);
  }

  async findSidecarEligibleChunks(
    input: {
      workspaceId: string;
      spaceIds: string[];
      query: string;
      eligibleSourcePageIds: string[];
      signals: KnowledgeRetrievalSignal[];
      limit: number;
    },
    trx?: KyselyTransaction,
  ): Promise<KnowledgeChunkCandidate[]> {
    if (
      input.spaceIds.length === 0 ||
      input.eligibleSourcePageIds.length === 0 ||
      input.signals.length === 0
    ) {
      return [];
    }

    const db = dbOrTx(this.db, trx);
    const chunkRows = await db
      .selectFrom('knowledgeChunks')
      .innerJoin(
        'knowledgeChunkSources',
        'knowledgeChunks.id',
        'knowledgeChunkSources.chunkId',
      )
      .selectAll('knowledgeChunks')
      .where('knowledgeChunks.workspaceId', '=', input.workspaceId)
      .where('knowledgeChunks.spaceId', 'in', input.spaceIds)
      .where('knowledgeChunks.staleAt', 'is', null)
      .where(
        'knowledgeChunkSources.sourcePageId',
        'in',
        input.eligibleSourcePageIds,
      )
      .limit(Math.max(input.limit * 10, input.limit))
      .execute();
    const chunks = uniqueById(chunkRows as KnowledgeChunk[]);
    if (chunks.length === 0) return [];

    const [pages, sourceRows] = await Promise.all([
      this.findPagesByIds(
        {
          workspaceId: input.workspaceId,
          knowledgePageIds: unique(
            chunks.map((chunk) => chunk.knowledgePageId),
          ),
        },
        trx,
      ),
      this.findChunkSourcePageIdsByChunkIds(
        {
          workspaceId: input.workspaceId,
          chunkIds: chunks.map((chunk) => chunk.id),
        },
        trx,
      ),
    ]);
    const pagesById = new Map(pages.map((page) => [page.id, page]));
    const sourcesByChunkId = new Map(
      sourceRows.map((row) => [row.chunkId, row.sourcePageIds]),
    );
    const eligibleSet = new Set(input.eligibleSourcePageIds);

    const candidates: KnowledgeChunkCandidate[] = [];
    for (const chunk of chunks) {
      const page = pagesById.get(chunk.knowledgePageId);
      if (!page) continue;

      const sourcePageIds = sourcesByChunkId.get(chunk.id) ?? [];
      if (
        sourcePageIds.length === 0 ||
        sourcePageIds.some((sourcePageId) => !eligibleSet.has(sourcePageId))
      ) {
        continue;
      }

      const signals = resolveSignals(input, chunk, page);
      if (signals.length === 0) continue;

      candidates.push({
        chunk,
        page,
        sourcePageIds,
        signals,
        lexicalScore: lexicalScore(input.query, chunk, page),
      });

      if (candidates.length >= input.limit) break;
    }

    return candidates;
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
    eligibleSourcePageIds: string[],
  ): T {
    return (query as any)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('knowledgeChunkSources as eligibleSources')
            .select('eligibleSources.chunkId')
            .whereRef('eligibleSources.chunkId', '=', 'knowledgeChunks.id')
            .where('eligibleSources.sourcePageId', 'in', eligibleSourcePageIds),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('knowledgeChunkSources as hiddenSources')
              .select('hiddenSources.chunkId')
              .whereRef('hiddenSources.chunkId', '=', 'knowledgeChunks.id')
              .where(
                'hiddenSources.sourcePageId',
                'not in',
                eligibleSourcePageIds,
              ),
          ),
        ),
      );
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
    const eligibleSet = new Set(input.eligibleSourcePageIds);
    const parentById = new Map(
      parentSections.map((parent) => [parent.id, parent]),
    );

    return rows.flatMap((row) => {
      const chunk = chunkById.get(row.chunkId);
      if (!chunk) return [];
      const page = pageById.get(chunk.knowledgePageId);
      const sourcePageIds = sourcesByChunkId.get(row.chunkId) ?? [];
      if (
        !page ||
        sourcePageIds.length === 0 ||
        sourcePageIds.some((sourcePageId) => !eligibleSet.has(sourcePageId))
      ) {
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

function hasCandidateScope(input: AuthorizedCandidateInput): boolean {
  return input.spaceIds.length > 0 && input.eligibleSourcePageIds.length > 0;
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const uniqueValues: T[] = [];

  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    uniqueValues.push(value);
  }

  return uniqueValues;
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

function resolveSignals(
  input: {
    query: string;
    signals: KnowledgeRetrievalSignal[];
  },
  chunk: KnowledgeChunk,
  page: KnowledgePage,
): KnowledgeRetrievalSignal[] {
  const signals: KnowledgeRetrievalSignal[] = [];
  const requested = new Set(input.signals);
  const normalizedQuery = input.query.trim().toLowerCase();

  if (requested.has('semantic') && chunk.embedding) {
    signals.push('semantic');
  }
  if (
    requested.has('lexical') &&
    normalizedQuery &&
    hasTokenOverlap(input.query, `${chunk.text}\n${page.body ?? ''}`)
  ) {
    signals.push('lexical');
  }
  if (
    requested.has('exact-title') &&
    normalizedQuery &&
    hasTokenOverlap(input.query, page.title)
  ) {
    signals.push('exact-title');
  }

  return signals;
}

function lexicalScore(
  query: string,
  chunk: KnowledgeChunk,
  page: KnowledgePage,
): number | null {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return null;

  const haystackTerms = tokenize(
    `${page.title}\n${chunk.text}\n${page.body ?? ''}`,
  );
  const termCounts = new Map<string, number>();
  for (const term of haystackTerms) {
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
  }

  return queryTerms.reduce(
    (score, term) => score + (termCounts.get(term) ?? 0),
    0,
  );
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const latinTerms = normalized.match(/[a-z0-9]+/g) ?? [];
  const hanChars = normalized.match(/\p{Script=Han}/gu) ?? [];
  const hanBigrams = hanChars.slice(0, -1).map((char, index) => {
    return `${char}${hanChars[index + 1]}`;
  });

  return [...latinTerms, ...hanChars, ...hanBigrams];
}

function hasTokenOverlap(query: string, text: string): boolean {
  const textTerms = new Set(tokenize(text));
  return tokenize(query).some((term) => textTerms.has(term));
}
