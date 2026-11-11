import { KnowledgeCapsuleRepo } from './knowledge-capsule.repo';
import {
  CamelCasePlugin,
  CompiledQuery,
  DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';
import { DbInterface } from '@akasha/db/types/db.interface';
import { describeKnowledgeCompilationError } from '../../../common/helpers/knowledge-compilation-error';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly results: Record<string, unknown[]> = {}) {}

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  selectAll(...args: unknown[]) {
    this.calls.push({ method: 'selectAll', args });
    return this;
  }

  innerJoin(...args: unknown[]) {
    this.calls.push({ method: 'innerJoin', args });
    return this;
  }

  leftJoin(...args: unknown[]) {
    this.calls.push({ method: 'leftJoin', args });
    return this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  whereRef(...args: unknown[]) {
    this.calls.push({ method: 'whereRef', args });
    return this;
  }

  distinct() {
    return this;
  }

  $if(condition: boolean, callback: (query: this) => this) {
    return condition ? callback(this) : this;
  }

  orderBy(...args: unknown[]) {
    this.calls.push({ method: 'orderBy', args });
    return this;
  }

  updateTable(...args: unknown[]) {
    this.calls.push({ method: 'updateTable', args });
    return this;
  }

  insertInto(...args: unknown[]) {
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  deleteFrom(...args: unknown[]) {
    this.calls.push({ method: 'deleteFrom', args });
    return this;
  }

  values(...args: unknown[]) {
    this.calls.push({ method: 'values', args });
    return this;
  }

  onConflict(...args: unknown[]) {
    this.calls.push({ method: 'onConflict', args });
    const callback = args[0];
    if (typeof callback === 'function') {
      callback({
        column: () => ({
          doUpdateSet: (values: unknown) => {
            this.calls.push({ method: 'doUpdateSet', args: [values] });
            return this;
          },
        }),
      });
    }
    return this;
  }

  returningAll(...args: unknown[]) {
    this.calls.push({ method: 'returningAll', args });
    return this;
  }

  returning(...args: unknown[]) {
    this.calls.push({ method: 'returning', args });
    return this;
  }

  limit(...args: unknown[]) {
    this.calls.push({ method: 'limit', args });
    return this;
  }

  set(...args: unknown[]) {
    this.calls.push({ method: 'set', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    const lastTableCall = [...this.calls]
      .reverse()
      .find((call) =>
        ['selectFrom', 'updateTable', 'insertInto'].includes(call.method),
      );
    return this.results[String(lastTableCall?.args[0])] ?? [];
  }

  async executeTakeFirstOrThrow() {
    this.calls.push({ method: 'executeTakeFirstOrThrow', args: [] });
    const lastTableCall = [...this.calls]
      .reverse()
      .find((call) => call.method === 'insertInto');
    return this.results[String(lastTableCall?.args[0])]?.[0];
  }
}

function createRepo(query: FakeKyselyQuery) {
  return new KnowledgeCapsuleRepo(query as never);
}

function basePage(id: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'page',
    title: id,
    slug: id,
    body: 'body',
    compiledAt: new Date('2026-06-16T00:00:00.000Z'),
    compilerVersion: 'compiler@1',
  };
}

function basePageSource(knowledgePageId: string, sourcePageId: string) {
  return {
    workspaceId: 'workspace-1',
    knowledgePageId,
    sourcePageId,
    sourceVersion: 'v1',
    contentHash: `${sourcePageId}-hash`,
    provenanceKind: 'synthesis_lineage',
  };
}

describe('KnowledgeCapsuleRepo', () => {
  it('retains the attempted artifact id when a knowledge-page upsert fails', async () => {
    const query = new FakeKyselyQuery();
    const error = new Error('unique constraint violation');
    jest.spyOn(query, 'executeTakeFirstOrThrow').mockRejectedValue(error);
    await expect(
      createRepo(query).upsertCompiledArtifacts([
        { page: basePage('incoming-artifact-id') },
      ]),
    ).rejects.toBe(error);
    expect(describeKnowledgeCompilationError(error)).toMatchObject({
      operation: 'import.upsert_knowledge_page',
      artifactId: 'incoming-artifact-id',
    });
  });

  it('discovers active source artifacts without requiring semantic contributions', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findSourceArtifactScopes({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });

    const query = queries[0];
    expect(query.sql).toContain('"knowledge_pages"."stale_at" is null');
    expect(query.sql).toContain('"knowledge_pages"."workspace_id" =');
    expect(query.sql).toContain('"knowledge_page_sources"."workspace_id" =');
    expect(query.sql).not.toContain('knowledge_artifact_contributions');
    expect(query.parameters).toEqual(
      expect.arrayContaining([
        'workspace-1',
        'page-1',
        'source_summary',
        'original_source',
      ]),
    );
  });

  it('retires source-owned artifacts and all their children only in the old Space', async () => {
    const query = new FakeKyselyQuery({
      knowledgePages: [{ id: 'old-original' }],
    });
    const repo = createRepo(query);

    await repo.markSourceArtifactsStaleBySourcePageIds({
      workspaceId: 'workspace-1',
      spaceId: 'space-old',
      sourcePageIds: ['page-1'],
    });

    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['knowledgePages.spaceId', '=', 'space-old'],
    });
    expect(
      query.calls
        .filter((call) => call.method === 'updateTable')
        .map((call) => call.args[0]),
    ).toEqual(
      expect.arrayContaining([
        'knowledgePages',
        'knowledgeParentSections',
        'knowledgeChunks',
        'knowledgeLinks',
      ]),
    );
    expect(query.calls.filter((call) => call.method === 'set')).toHaveLength(4);
    expect(
      query.calls
        .filter((call) => call.method === 'set')
        .every(
          (call) =>
            (call.args[0] as { staleAt: unknown }).staleAt instanceof Date,
        ),
    ).toBe(true);
  });

  it('ranks a bounded compiler Catalog in SQL without returning bodies', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findCompilerCatalogCandidates({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      signals: ['Event sourcing'],
      explicitSourcePageIds: ['11111111-1111-4111-8111-111111111111'],
      limit: 64,
    });

    const query = queries[0].sql.toLowerCase().replace(/\s+/g, ' ');
    expect(query).toContain('knowledge_artifact_contributions');
    expect(query).toContain('join lateral');
    expect(query).toContain('page.title % signal.value');
    expect(query).toContain('similarity(page.title, signal.value)');
    expect(query).toContain(
      'search_tsv_zh @@ knowledge_zh_tsquery(signal.value, true)',
    );
    expect(query).toContain('union all');
    expect(query).toContain('order by "explicitmatch" desc');
    expect(query).toContain('"canonicalexactmatch" desc');
    expect(query.indexOf('"trigramscore" desc')).toBeLessThan(
      query.indexOf('"ftsmatch" desc'),
    );
    expect(query).not.toContain('page.body');
    expect(query).not.toContain('chunk.content');
    expect(queries[0].parameters).toEqual(
      expect.arrayContaining(['event sourcing', 64]),
    );
  });

  it('applies complete-source authorization before dense candidate limits', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findDenseChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [
        { principalType: 'user', principalId: 'user-visible' },
        { principalType: 'group', principalId: 'group-visible' },
      ],
      embedding: {
        vector: [0.1, 0.2, 0.3],
        profile: 'a'.repeat(64),
        model: 'bge-m3',
        dimensions: 3,
      },
      limit: 12,
    });

    const sql = queries
      .find((query) => query.sql.startsWith('select'))!
      .sql.toLowerCase()
      .replace(/\s+/g, ' ');
    expect(sql).toContain(`embedding_profile = '${'a'.repeat(64)}'`);
    expect(sql).toContain('embedding_dimensions = 3');
    expect(sql).toContain('embedding::vector(3) <=>');
    expect(sql).toContain('knowledge_source_access_policy');
    expect(sql).toContain('knowledge_source_access_requirements');
    expect(sql).toContain('knowledge_source_access_principals');
    expect(sql).toContain('restricted_ancestor_count > 0');
    expect(sql).toContain(
      'not exists ( select 1 from knowledge_source_access_requirements',
    );
    expect(sql).toContain('exists ( select');
    expect(sql).toContain('not exists ( select');
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('limit'));
    expect(
      queries.find((query) => query.sql.startsWith('select'))!.parameters,
    ).toEqual(expect.arrayContaining(['user-visible', 'group-visible']));
  });

  it('supports bounded final-authorization fallback without treating it as policy-filtered', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      authorizationMode: 'final-authorization-fallback',
      query: 'Akasha wiki',
      limit: 10,
    });

    const sql = lexicalCandidateQuery(queries)
      .sql.toLowerCase()
      .replace(/\s+/g, ' ');
    expect(sql).toContain('knowledge_chunk_sources as source_presence');
    expect(sql).not.toContain('knowledge_source_access_policy');
    expect(sql.indexOf('source_presence')).toBeLessThan(sql.indexOf('limit'));
  });

  it('enables iterative HNSW scanning for filtered enterprise retrieval', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findDenseChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      embedding: {
        vector: [0.1, 0.2, 0.3],
        profile: 'a'.repeat(64),
        model: 'bge-m3',
        dimensions: 3,
      },
      limit: 12,
    });

    const statements = queries.map((query) => query.sql.toLowerCase());
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining('set local hnsw.ef_search = 200'),
        expect.stringContaining('set local hnsw.iterative_scan = strict_order'),
      ]),
    );
  });

  it('does not pay HNSW transaction overhead for unsupported exact-only dimensions', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findDenseChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      embedding: {
        vector: Array.from({ length: 2001 }, () => 0.1),
        profile: 'a'.repeat(64),
        model: 'large-embedding',
        dimensions: 2001,
      },
      limit: 12,
    });

    expect(
      queries.some((query) =>
        query.sql.toLowerCase().includes('set local hnsw'),
      ),
    ).toBe(false);
  });

  it('uses jieba-segmented FTS after complete-source authorization', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: '  合同什么时候批准的  ',
      limit: 10,
    });

    // Term statistics: segmented once, document frequency bounded by the
    // common-term threshold within the same scope.
    const stats = queries[0];
    const statsSql = stats.sql.toLowerCase().replace(/\s+/g, ' ');
    expect(statsSql).toContain('unnest(knowledge_zh_query_terms($');
    expect(statsSql).toContain('chunk.search_tsv_zh @@ term');
    expect(statsSql).toContain('limit settings.threshold + 1');
    expect(stats.parameters).toEqual(
      expect.arrayContaining(['合同什么时候批准的', 20, 0.05]),
    );

    const candidate = lexicalCandidateQuery(queries);
    const sql = candidate.sql.toLowerCase().replace(/\s+/g, ' ');
    expect(sql).toContain('knowledge_chunks.search_tsv_zh @@ $');
    expect(sql).not.toContain("'simple'");
    expect(sql).not.toContain('knowledge_zh_tsquery(');
    expect(sql).toContain('ts_rank_cd(knowledge_chunks.search_tsv_zh, $');
    expect(candidate.parameters).toContain("'akasha'");
    expect(sql).toContain('not exists ( select');
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('limit'));
  });

  it('never lets common terms alone qualify a lexical candidate', async () => {
    const { repo, queries } = createSqlRepo([
      { term: "'配置'", document_frequency: 71, threshold: 70 },
    ]);

    const lexical = await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: '请问配置在哪里',
      limit: 10,
    });

    expect(lexical).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('requires rare terms only and lets common terms affect ranking', async () => {
    const { repo, queries } = createSqlRepo([
      { term: "'数据库'", document_frequency: 71, threshold: 70 },
      { term: "'失败'", document_frequency: 3, threshold: 70 },
      { term: "'排查'", document_frequency: 4, threshold: 70 },
      { term: "'连接'", document_frequency: 55, threshold: 70 },
    ]);

    await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: '数据库连接失败怎么排查',
      limit: 10,
    });

    const candidate = lexicalCandidateQuery(queries);
    // Filter and coverage use rare terms; three rare terms -> floor(3*0.75)=2.
    expect(candidate.parameters).toContain("'失败' | '排查' | '连接'");
    expect(candidate.parameters).toContainEqual(["'失败'", "'排查'", "'连接'"]);
    expect(candidate.parameters).toContain(2);
    // Ranking still sees the common term.
    expect(candidate.parameters).toContain(
      "'数据库' | '失败' | '排查' | '连接'",
    );
  });

  it('returns no lexical candidates when the query has no searchable terms', async () => {
    const { repo, queries } = createSqlRepo([]);

    const lexical = await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: '请问',
      limit: 10,
    });

    expect(lexical).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it('applies OR page-label filtering to every chunk source before candidate limits', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      labelNames: ['项目计划', 'kafka'],
      query: 'Akasha wiki',
      limit: 10,
    });

    const compiled = lexicalCandidateQuery(queries);
    const sql = compiled.sql.toLowerCase().replace(/\s+/g, ' ');
    expect(sql).toContain('knowledge_chunk_sources as label_source');
    expect(sql).toContain('page_labels as matching_page_label');
    expect(sql).toContain('labels as matching_label');
    expect(sql).toContain('matching_label.name in');
    expect(sql.indexOf('label_source')).toBeLessThan(sql.indexOf('limit'));
    expect(compiled.parameters).toEqual(
      expect.arrayContaining(['项目计划', 'kafka']),
    );
  });

  it('normalizes titles and authorizes every source before title limits', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findExactTitleChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: '  Akasha   Wiki ',
      limit: 8,
    });

    const sql = queries[0].sql.toLowerCase().replace(/\s+/g, ' ');
    expect(sql).toContain('regexp_replace');
    expect(sql).toContain('lower');
    expect(sql).toContain('not exists ( select');
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('limit'));
  });

  it('excludes unreadable pages before the display node limit', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findGraphCandidatesForSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 3000,
      readableSourcePageIds: ['source-readable'],
    });

    const sql = queries[0].sql.toLowerCase().replace(/\s+/g, ' ');
    expect(sql).toContain('knowledge_page_sources" as "quota_source"');
    expect(sql).toContain('not exists');
    expect(sql.indexOf('quota_source')).toBeLessThan(sql.indexOf('limit'));
  });

  it('excludes original index containers from graph candidates', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findGraphCandidatesForSpace({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 100,
    });

    const sql = queries[0].sql.toLowerCase().replace(/\s+/g, ' ');
    expect(sql).toContain('"page_type" != $3');
    expect(queries[0].parameters).toContain('original_source');
  });

  it('scopes dense recall to the graph window and authorizes before the limit', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findDenseChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      embedding: {
        vector: [0.1, 0.2, 0.3],
        profile: 'a'.repeat(64),
        model: 'model-1',
        dimensions: 3,
      },
      knowledgePageIds: ['knowledge-page-1', 'knowledge-page-2'],
      limit: 8,
    });

    const sql = queries
      .map((query) => query.sql.toLowerCase().replace(/\s+/g, ' '))
      .find((statement) => statement.includes('from "knowledge_chunks"'));
    expect(sql).toBeDefined();
    expect(sql).toContain('"knowledge_chunks"."knowledge_page_id" in');
    expect(sql).toContain('order by knowledge_chunks.embedding');
    expect(sql).toContain('knowledge_source_access_policy');
    expect(sql!.indexOf('knowledge_source_access_policy')).toBeLessThan(
      sql!.indexOf('limit'),
    );
  });

  it('restricts lexical recall to the graph window', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: 'akasha',
      knowledgePageIds: ['knowledge-page-1'],
      limit: 8,
    });

    const sql = lexicalCandidateQuery(queries)
      .sql.toLowerCase()
      .replace(/\s+/g, ' ');
    expect(sql).toContain('"knowledge_chunks"."knowledge_page_id" in');
    expect(sql).toContain('ts_rank_cd');
  });

  it('returns no rows when the graph window is empty', async () => {
    const { repo, queries } = createSqlRepo();

    const lexical = await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      principals: [{ principalType: 'user', principalId: 'user-visible' }],
      query: 'akasha',
      knowledgePageIds: [],
      limit: 8,
    });

    expect(lexical).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('selects graph traversal edges in one statement with ACL and same-space pushed down', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findGraphTraversalEdges({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      seeds: [{ knowledgePageId: 'knowledge-page-1', weight: 0.9 }],
      readableSourcePageIds: ['source-page-1'],
      limit: 40,
    });

    expect(queries).toHaveLength(1);
    const sql = queries[0].sql
      .toLowerCase()
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ');
    expect(sql).toContain('knowledge_links');
    expect(sql).not.toContain('knowledge_graph_edges');
    expect(sql).toContain('knowledge_page_sources');
    expect(sql.match(/limit/g) ?? []).toHaveLength(1);
    expect(sql.indexOf('readable_source')).toBeLessThan(
      sql.lastIndexOf('limit'),
    );
    expect(sql).toContain('from_page.space_id = l.space_id');
    expect(sql).toContain('bool_and');
    expect(sql.indexOf('group by')).toBeLessThan(
      sql.lastIndexOf('all_sources_readable'),
    );
    const sharedSourcePairCte = sql.slice(
      sql.indexOf('shared_source_pair as'),
      sql.indexOf('shared_source_edge as'),
    );
    expect(sharedSourcePairCte).not.toContain('limit');
  });

  it('fails closed when no provenance source is readable', async () => {
    const { repo, queries } = createSqlRepo();

    const edges = await repo.findGraphTraversalEdges({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      seeds: [{ knowledgePageId: 'knowledge-page-1', weight: 0.9 }],
      readableSourcePageIds: [],
      limit: 40,
    });

    expect(edges).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('batch upserts pages before relationship rows so new pages can link each other', async () => {
    const query = new FakeKyselyQuery({
      knowledgePages: [{ id: 'knowledge-page-1' }, { id: 'knowledge-page-2' }],
    });
    const repo = createRepo(query);

    await repo.upsertCompiledArtifacts([
      {
        page: basePage('knowledge-page-1'),
        pageSources: [basePageSource('knowledge-page-1', 'source-1')],
        links: [
          {
            id: 'link-1',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            fromKnowledgePageId: 'knowledge-page-1',
            toKnowledgePageId: 'knowledge-page-2',
            targetPageId: 'source-2',
            targetSpaceId: 'space-1',
            linkText: 'Page 2',
            linkType: 'same_space_reference',
            isDangling: false,
          },
        ],
      },
      {
        page: basePage('knowledge-page-2'),
        pageSources: [basePageSource('knowledge-page-2', 'source-2')],
        links: [
          {
            id: 'link-2',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            fromKnowledgePageId: 'knowledge-page-2',
            toKnowledgePageId: 'knowledge-page-1',
            targetPageId: 'source-1',
            targetSpaceId: 'space-1',
            linkText: 'Page 1',
            linkType: 'same_space_reference',
            isDangling: false,
          },
        ],
      },
    ]);

    const pageInsertIndexes = query.calls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          call.method === 'insertInto' && call.args[0] === 'knowledgePages',
      )
      .map(({ index }) => index);
    const linkInsertIndex = query.calls.findIndex(
      (call) =>
        call.method === 'insertInto' && call.args[0] === 'knowledgeLinks',
    );

    expect(pageInsertIndexes).toHaveLength(2);
    expect(linkInsertIndex).toBeGreaterThan(Math.max(...pageInsertIndexes));
  });

  it('splits large child collections into bounded inserts', async () => {
    const query = new FakeKyselyQuery({
      knowledgePages: [{ id: 'knowledge-page-1' }],
    });
    const repo = createRepo(query);
    const links = Array.from({ length: 1_001 }, (_, index) => ({
      id: `link-${index}`,
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      fromKnowledgePageId: 'knowledge-page-1',
      toKnowledgePageId: null,
      targetPageId: null,
      targetSpaceId: 'space-1',
      linkText: `Page ${index}`,
      linkType: 'catalog_entry',
      isDangling: true,
    }));

    await repo.upsertCompiledArtifacts([
      {
        page: basePage('knowledge-page-1'),
        links,
      },
    ]);

    const linkInsertBatchSizes = query.calls.flatMap((call, index) => {
      if (call.method !== 'insertInto' || call.args[0] !== 'knowledgeLinks') {
        return [];
      }
      const valuesCall = query.calls
        .slice(index + 1)
        .find((candidate) => candidate.method === 'values');
      const rows = valuesCall?.args[0];
      return [Array.isArray(rows) ? rows.length : 1];
    });

    expect(linkInsertBatchSizes).toEqual([1_000, 1]);
  });

  it('upserts the compiled page and dependency rows for an artifact', async () => {
    const row = { id: 'knowledge-page-1', workspaceId: 'workspace-1' };
    const query = new FakeKyselyQuery({ knowledgePages: [row] });
    const repo = createRepo(query);

    await expect(
      repo.upsertCompiledArtifacts([
        {
          page: {
            id: 'knowledge-page-1',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            compileScope: 'page',
            title: 'Compiled',
            slug: 'compiled',
            body: 'body',
            compiledAt: new Date('2026-06-16T00:00:00.000Z'),
            compilerVersion: 'compiler@1',
          },
          pageSources: [
            {
              workspaceId: 'workspace-1',
              knowledgePageId: 'knowledge-page-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
            },
          ],
          chunks: [
            {
              id: 'chunk-1',
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              knowledgePageId: 'knowledge-page-1',
              text: 'Kafka is used for events.',
              contentHash: 'chunk-hash-1',
              embedding: null,
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
            },
          ],
          chunkSources: [
            {
              workspaceId: 'workspace-1',
              chunkId: 'chunk-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
            },
          ],
          links: [
            {
              id: 'link-1',
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              fromKnowledgePageId: 'knowledge-page-1',
              toKnowledgePageId: null,
              targetPageId: null,
              targetSpaceId: 'space-2',
              linkText: 'External page',
              linkType: 'cross_space_reference',
              isDangling: true,
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
            },
          ],
          linkSources: [
            {
              workspaceId: 'workspace-1',
              linkId: 'link-1',
              sourcePageId: 'source-1',
              sourceVersion: 'v1',
              contentHash: 'hash-1',
              provenanceKind: 'synthesis_lineage',
            },
          ],
        },
      ]),
    ).resolves.toEqual([row]);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'deleteFrom', args: ['knowledgeLinks'] },
        { method: 'deleteFrom', args: ['knowledgeChunks'] },
        { method: 'deleteFrom', args: ['knowledgePageSources'] },
        { method: 'insertInto', args: ['knowledgePages'] },
        { method: 'onConflict', args: [expect.any(Function)] },
        { method: 'insertInto', args: ['knowledgePageSources'] },
        { method: 'insertInto', args: ['knowledgeChunks'] },
        { method: 'insertInto', args: ['knowledgeChunkSources'] },
        { method: 'insertInto', args: ['knowledgeLinks'] },
        { method: 'insertInto', args: ['knowledgeLinkSources'] },
      ]),
    );
    expect(
      query.calls.some(
        (call) =>
          ['deleteFrom', 'insertInto', 'selectFrom', 'updateTable'].includes(
            call.method,
          ) && String(call.args[0]).startsWith('knowledgeGraphEdge'),
      ),
    ).toBe(false);
  });

  it('updates compilation scope and generation mode when a stable artifact is republished', async () => {
    const query = new FakeKyselyQuery({
      knowledgePages: [{ id: 'knowledge-page-1' }],
    });
    const repo = createRepo(query);

    await repo.upsertCompiledArtifacts([
      {
        page: {
          ...basePage('knowledge-page-1'),
          compileScope: 'page',
          generationMode: 'semantic',
        },
      },
    ]);

    expect(query.calls).toContainEqual({
      method: 'doUpdateSet',
      args: [
        expect.objectContaining({
          compileScope: 'page',
          generationMode: 'semantic',
        }),
      ],
    });
  });

  it('does not query dependency sources when knowledgePageIds is empty', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await expect(
      repo.findDependencySourcePageIds({
        workspaceId: 'workspace-1',
        knowledgePageIds: [],
      }),
    ).resolves.toEqual([]);

    expect(query.calls).toEqual([]);
  });

  it('finds pages by ids preserving the requested ranking order', async () => {
    const rows = [
      { id: 'kp-1', workspaceId: 'workspace-1' },
      { id: 'kp-2', workspaceId: 'workspace-1' },
    ];
    const query = new FakeKyselyQuery({ knowledgePages: rows });
    const repo = createRepo(query);

    await expect(
      repo.findPagesByIds({
        workspaceId: 'workspace-1',
        knowledgePageIds: ['kp-2', 'kp-1'],
      }),
    ).resolves.toEqual([
      { id: 'kp-2', workspaceId: 'workspace-1' },
      { id: 'kp-1', workspaceId: 'workspace-1' },
    ]);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgePages'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['id', 'in', ['kp-2', 'kp-1']] },
      { method: 'where', args: ['staleAt', 'is', null] },
      { method: 'execute', args: [] },
    ]);
  });

  it('aggregates unique dependency source page ids from all source tables', async () => {
    const query = new FakeKyselyQuery({
      knowledgePageSources: [
        { sourcePageId: 'source-1' },
        { sourcePageId: 'source-2' },
      ],
      knowledgeChunkSources: [{ sourcePageId: 'source-4' }],
      knowledgeLinkSources: [{ sourcePageId: 'source-5' }],
    });
    const repo = createRepo(query);

    await expect(
      repo.findDependencySourcePageIds({
        workspaceId: 'workspace-1',
        knowledgePageIds: ['kp-1', 'kp-2'],
      }),
    ).resolves.toEqual(['source-1', 'source-2', 'source-4', 'source-5']);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'selectFrom', args: ['knowledgePageSources'] },
        {
          method: 'where',
          args: ['knowledgePageSources.workspaceId', '=', 'workspace-1'],
        },
        {
          method: 'where',
          args: [
            'knowledgePageSources.knowledgePageId',
            'in',
            ['kp-1', 'kp-2'],
          ],
        },
        { method: 'selectFrom', args: ['knowledgeChunkSources'] },
        {
          method: 'innerJoin',
          args: [
            'knowledgeChunks',
            'knowledgeChunkSources.chunkId',
            'knowledgeChunks.id',
          ],
        },
        { method: 'selectFrom', args: ['knowledgeLinkSources'] },
        {
          method: 'innerJoin',
          args: [
            'knowledgeLinks',
            'knowledgeLinkSources.linkId',
            'knowledgeLinks.id',
          ],
        },
      ]),
    );
  });

  it('finds chunk dependency source page ids in one batch preserving requested chunk ids', async () => {
    const query = new FakeKyselyQuery({
      knowledgeChunkSources: [
        { chunkId: 'chunk-1', sourcePageId: 'source-1' },
        { chunkId: 'chunk-1', sourcePageId: 'source-2' },
        { chunkId: 'chunk-2', sourcePageId: 'source-3' },
      ],
    });
    const repo = createRepo(query);

    await expect(
      repo.findChunkSourcePageIdsByChunkIds({
        workspaceId: 'workspace-1',
        chunkIds: ['chunk-2', 'chunk-1', 'chunk-empty'],
      }),
    ).resolves.toEqual([
      { chunkId: 'chunk-2', sourcePageIds: ['source-3'] },
      { chunkId: 'chunk-1', sourcePageIds: ['source-1', 'source-2'] },
      { chunkId: 'chunk-empty', sourcePageIds: [] },
    ]);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeChunkSources'] },
      {
        method: 'select',
        args: [
          [
            'knowledgeChunkSources.chunkId',
            'knowledgeChunkSources.sourcePageId',
          ],
        ],
      },
      {
        method: 'where',
        args: ['knowledgeChunkSources.workspaceId', '=', 'workspace-1'],
      },
      {
        method: 'where',
        args: [
          'knowledgeChunkSources.chunkId',
          'in',
          ['chunk-2', 'chunk-1', 'chunk-empty'],
        ],
      },
      { method: 'execute', args: [] },
    ]);
  });

  it('expands a parent only when its lineage is covered by the child lineage', async () => {
    const chunk = (id: string, parentSectionId: string | null) => ({
      id,
      workspaceId: 'workspace-1',
      knowledgePageId: 'concept-1',
      parentSectionId,
      staleAt: null,
    });
    const lineage = (sourcePageId: string) => ({
      sourcePageId,
      sourceVersion: 'v1',
      contentHash: `${sourcePageId}-hash`,
    });
    const query = new FakeKyselyQuery({
      knowledgeChunks: [
        chunk('child-b-own-parent', 'parent-b'),
        chunk('child-b-foreign-parent', 'parent-a'),
        chunk('child-no-parent-lineage', 'parent-empty'),
      ],
      knowledgePages: [basePage('concept-1')],
      knowledgeParentSections: [
        { id: 'parent-a', knowledgePageId: 'concept-1', text: 'A text' },
        { id: 'parent-b', knowledgePageId: 'concept-1', text: 'B text' },
        { id: 'parent-empty', knowledgePageId: 'concept-1', text: 'x' },
      ],
      knowledgeChunkSources: [
        { chunkId: 'child-b-own-parent', ...lineage('source-b') },
        { chunkId: 'child-b-foreign-parent', ...lineage('source-b') },
        { chunkId: 'child-no-parent-lineage', ...lineage('source-b') },
      ],
      knowledgeParentSectionSources: [
        { parentSectionId: 'parent-a', ...lineage('source-a') },
        { parentSectionId: 'parent-b', ...lineage('source-b') },
      ],
    });
    const repo = createRepo(query) as unknown as {
      hydrateRankedChunkCandidates: (
        rows: Array<{ chunkId: string; score: number }>,
        signal: string,
        input: { workspaceId: string; spaceIds: string[]; principals: [] },
      ) => Promise<
        Array<{ chunk: { id: string }; parentSection?: { id: string } }>
      >;
    };

    const result = await repo.hydrateRankedChunkCandidates(
      [
        { chunkId: 'child-b-own-parent', score: 0.1 },
        { chunkId: 'child-b-foreign-parent', score: 0.2 },
        { chunkId: 'child-no-parent-lineage', score: 0.3 },
      ],
      'semantic',
      { workspaceId: 'workspace-1', spaceIds: ['space-1'], principals: [] },
    );

    expect(
      result.map((entry) => [entry.chunk.id, entry.parentSection?.id ?? null]),
    ).toEqual([
      ['child-b-own-parent', 'parent-b'],
      // Same knowledge page, but parent A carries lineage child B does not:
      // the authorized child is returned without A's parent text.
      ['child-b-foreign-parent', null],
      ['child-no-parent-lineage', null],
    ]);
  });

  it('finds chunk source refs with ranges and quote hashes in one batch', async () => {
    const query = new FakeKyselyQuery({
      knowledgeChunkSources: [
        {
          chunkId: 'chunk-1',
          sourcePageId: 'source-1',
          sourceVersion: 'v1',
          contentHash: 'sha256:source-1',
          sourceRange: { startOffset: 5, endOffset: 12 },
          quoteHash: 'sha256:quote-1',
        },
        {
          chunkId: 'chunk-1',
          sourcePageId: 'source-2',
          sourceVersion: 'v2',
          contentHash: 'sha256:source-2',
          sourceRange: null,
          quoteHash: null,
        },
      ],
    });
    const repo = createRepo(query);

    await expect(
      repo.findChunkSourceRefsByChunkIds({
        workspaceId: 'workspace-1',
        chunkIds: ['chunk-2', 'chunk-1'],
      }),
    ).resolves.toEqual([
      { chunkId: 'chunk-2', sources: [] },
      {
        chunkId: 'chunk-1',
        sources: [
          {
            sourcePageId: 'source-1',
            sourceVersion: 'v1',
            contentHash: 'sha256:source-1',
            sourceRange: { startOffset: 5, endOffset: 12 },
            quoteHash: 'sha256:quote-1',
          },
          {
            sourcePageId: 'source-2',
            sourceVersion: 'v2',
            contentHash: 'sha256:source-2',
            sourceRange: null,
            quoteHash: null,
          },
        ],
      },
    ]);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeChunkSources'] },
      {
        method: 'select',
        args: [
          [
            'knowledgeChunkSources.chunkId',
            'knowledgeChunkSources.sourcePageId',
            'knowledgeChunkSources.sourceVersion',
            'knowledgeChunkSources.contentHash',
            'knowledgeChunkSources.sourceRange',
            'knowledgeChunkSources.quoteHash',
          ],
        ],
      },
      {
        method: 'where',
        args: ['knowledgeChunkSources.workspaceId', '=', 'workspace-1'],
      },
      {
        method: 'where',
        args: ['knowledgeChunkSources.chunkId', 'in', ['chunk-2', 'chunk-1']],
      },
      { method: 'execute', args: [] },
    ]);
  });

  it('does not query stale updates when sourcePageIds is empty', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await repo.markCapsulesStaleBySourcePageIds({
      workspaceId: 'workspace-1',
      sourcePageIds: [],
    });

    expect(query.calls).toEqual([]);
  });

  it('marks each capsule table stale by dependency source page ids', async () => {
    const query = new FakeKyselyQuery({
      knowledgePageSources: [{ knowledgePageId: 'kp-1' }],
      knowledgeChunkSources: [{ chunkId: 'chunk-1' }],
      knowledgeLinkSources: [{ linkId: 'link-1' }],
    });
    const repo = createRepo(query);

    await repo.markCapsulesStaleBySourcePageIds({
      workspaceId: 'workspace-1',
      sourcePageIds: ['source-1'],
    });

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'updateTable', args: ['knowledgePages'] },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['id', 'in', ['kp-1']] },
        { method: 'updateTable', args: ['knowledgeChunks'] },
        { method: 'where', args: ['id', 'in', ['chunk-1']] },
        { method: 'updateTable', args: ['knowledgeLinks'] },
        { method: 'where', args: ['id', 'in', ['link-1']] },
      ]),
    );
  });
});

type LexicalTermRow = {
  term: string;
  document_frequency: number;
  threshold: number;
};

// Default term statistics: one rare term, so lexical recall reaches the main
// candidate query. Tests that exercise term classification pass their own.
const DEFAULT_LEXICAL_TERMS: LexicalTermRow[] = [
  { term: "'akasha'", document_frequency: 3, threshold: 20 },
];

function createSqlRepo(
  lexicalTerms: LexicalTermRow[] = DEFAULT_LEXICAL_TERMS,
): {
  repo: KnowledgeCapsuleRepo;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery) =>
      ({
        rows: query.sql.includes('knowledge_zh_query_terms(')
          ? lexicalTerms
          : [],
      }) as unknown as QueryResult<R>,
    streamQuery: () => {
      throw new Error('not supported');
    },
  };
  const dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () =>
      Object.assign(new DummyDriver(), {
        acquireConnection: async () => connection,
      }),
    createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  const db = new Kysely<DbInterface>({
    dialect,
    plugins: [new CamelCasePlugin()],
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });

  return { repo: new KnowledgeCapsuleRepo(db), queries };
}

/** The lexical candidate query, i.e. not the term-statistics query. */
function lexicalCandidateQuery(queries: CompiledQuery[]): CompiledQuery {
  const query = queries.find(
    (item) => !item.sql.includes('knowledge_zh_query_terms('),
  );
  if (!query) throw new Error('lexical candidate query was not issued');
  return query;
}
