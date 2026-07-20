import { KnowledgeCapsuleRepo } from './knowledge-capsule.repo';
import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { DbInterface } from '@akasha/db/types/db.interface';

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
    return this;
  }

  returningAll(...args: unknown[]) {
    this.calls.push({ method: 'returningAll', args });
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
    compileScope: 'space',
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
  it('applies complete-source authorization before dense candidate limits', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findDenseChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      eligibleSourcePageIds: ['source-visible'],
      embedding: {
        vector: [0.1, 0.2, 0.3],
        profile: 'a'.repeat(64),
        model: 'bge-m3',
        dimensions: 3,
      },
      limit: 12,
    });

    const sql = queries[0].sql;
    expect(sql).toContain('"embedding_profile" = $');
    expect(sql).toContain('"embedding_dimensions" = $');
    expect(sql).toContain('embedding::vector(3) <=>');
    expect(sql).toContain('exists (select');
    expect(sql).toContain('not exists (select');
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('limit'));
  });

  it('uses PostgreSQL FTS after complete-source authorization', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findLexicalChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      eligibleSourcePageIds: ['source-visible'],
      query: 'Akasha wiki',
      limit: 10,
    });

    const sql = queries[0].sql;
    expect(sql).toContain("websearch_to_tsquery('simple'");
    expect(sql).toContain('ts_rank_cd');
    expect(sql).toContain('not exists (select');
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('limit'));
  });

  it('normalizes titles and authorizes every source before title limits', async () => {
    const { repo, queries } = createSqlRepo();

    await repo.findExactTitleChunkCandidates({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      eligibleSourcePageIds: ['source-visible'],
      query: '  Akasha   Wiki ',
      limit: 8,
    });

    const sql = queries[0].sql;
    expect(sql).toContain('regexp_replace');
    expect(sql).toContain('lower');
    expect(sql).toContain('not exists (select');
    expect(sql.indexOf('not exists')).toBeLessThan(sql.indexOf('limit'));
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

  it('upserts the compiled page and dependency rows for an artifact', async () => {
    const row = { id: 'knowledge-page-1', workspaceId: 'workspace-1' };
    const query = new FakeKyselyQuery({ knowledgePages: [row] });
    const repo = createRepo(query);

    await expect(
      repo.upsertCompiledArtifact({
        page: {
          id: 'knowledge-page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          compileScope: 'space',
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
        claims: [
          {
            id: 'claim-1',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            knowledgePageId: 'knowledge-page-1',
            text: 'Kafka is used for events.',
            confidence: null,
            position: 0,
            compilerRunId: 'run-1',
            compileTaskId: 'task-1',
          },
        ],
        claimSources: [
          {
            workspaceId: 'workspace-1',
            claimId: 'claim-1',
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
            claimId: 'claim-1',
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
        graphEdges: [
          {
            id: 'edge-1',
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            fromKnowledgePageId: 'knowledge-page-1',
            toKnowledgePageId: 'knowledge-page-2',
            relation: 'depends_on',
            compilerRunId: 'run-1',
            compileTaskId: 'task-1',
          },
        ],
        graphEdgeSources: [
          {
            workspaceId: 'workspace-1',
            graphEdgeId: 'edge-1',
            sourcePageId: 'source-1',
            sourceVersion: 'v1',
            contentHash: 'hash-1',
            provenanceKind: 'synthesis_lineage',
          },
        ],
      }),
    ).resolves.toEqual(row);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'deleteFrom', args: ['knowledgeGraphEdges'] },
        { method: 'deleteFrom', args: ['knowledgeLinks'] },
        { method: 'deleteFrom', args: ['knowledgeChunks'] },
        { method: 'deleteFrom', args: ['knowledgeClaims'] },
        { method: 'deleteFrom', args: ['knowledgePageSources'] },
        { method: 'insertInto', args: ['knowledgePages'] },
        { method: 'onConflict', args: [expect.any(Function)] },
        { method: 'insertInto', args: ['knowledgePageSources'] },
        { method: 'insertInto', args: ['knowledgeClaims'] },
        { method: 'insertInto', args: ['knowledgeClaimSources'] },
        { method: 'insertInto', args: ['knowledgeChunks'] },
        { method: 'insertInto', args: ['knowledgeChunkSources'] },
        { method: 'insertInto', args: ['knowledgeLinks'] },
        { method: 'insertInto', args: ['knowledgeLinkSources'] },
        { method: 'insertInto', args: ['knowledgeGraphEdges'] },
        { method: 'insertInto', args: ['knowledgeGraphEdgeSources'] },
      ]),
    );
  });

  it('marks all online capsule tables stale for a compile scope', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await repo.markCompileScopeStale({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'updateTable', args: ['knowledgePages'] },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['spaceId', '=', 'space-1'] },
        { method: 'where', args: ['compileScope', '=', 'space'] },
        { method: 'updateTable', args: ['knowledgeClaims'] },
        { method: 'updateTable', args: ['knowledgeChunks'] },
        { method: 'updateTable', args: ['knowledgeLinks'] },
        { method: 'updateTable', args: ['knowledgeGraphEdges'] },
      ]),
    );
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

  it('finds non-stale page candidates within workspace and readable spaces', async () => {
    const rows = [
      {
        id: 'kp-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        title: 'Kafka',
        body: 'Kafka deployment guide',
      },
    ];
    const query = new FakeKyselyQuery({ knowledgePages: rows });
    const repo = createRepo(query);

    await expect(
      repo.findPageCandidates({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1', 'space-2'],
        query: 'kafka',
        limit: 20,
      }),
    ).resolves.toEqual(rows);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgePages'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['spaceId', 'in', ['space-1', 'space-2']] },
      { method: 'where', args: ['staleAt', 'is', null] },
      { method: 'where', args: [expect.any(Function)] },
      { method: 'limit', args: [20] },
      { method: 'execute', args: [] },
    ]);
  });

  it('does not query candidates when readable spaces are empty', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await expect(
      repo.findPageCandidates({
        workspaceId: 'workspace-1',
        spaceIds: [],
        query: 'kafka',
        limit: 20,
      }),
    ).resolves.toEqual([]);

    expect(query.calls).toEqual([]);
  });

  it('finds non-stale embedded chunk candidates within readable spaces', async () => {
    const rows = [
      {
        id: 'chunk-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        knowledgePageId: 'kp-1',
        text: 'Compiled chunk',
        embedding: [1, 0],
      },
    ];
    const query = new FakeKyselyQuery({ knowledgeChunks: rows });
    const repo = createRepo(query);

    await expect(
      repo.findEmbeddedChunkCandidates({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1', 'space-2'],
        limit: 200,
      }),
    ).resolves.toEqual(rows);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeChunks'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['spaceId', 'in', ['space-1', 'space-2']] },
      { method: 'where', args: ['staleAt', 'is', null] },
      { method: 'where', args: ['embedding', 'is not', null] },
      { method: 'limit', args: [200] },
      { method: 'execute', args: [] },
    ]);
  });

  it('does not query embedded chunks when readable spaces are empty', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await expect(
      repo.findEmbeddedChunkCandidates({
        workspaceId: 'workspace-1',
        spaceIds: [],
        limit: 200,
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
      knowledgeClaimSources: [
        { sourcePageId: 'source-2' },
        { sourcePageId: 'source-3' },
      ],
      knowledgeChunkSources: [{ sourcePageId: 'source-4' }],
      knowledgeLinkSources: [{ sourcePageId: 'source-5' }],
      knowledgeGraphEdgeSources: [{ sourcePageId: 'source-6' }],
    });
    const repo = createRepo(query);

    await expect(
      repo.findDependencySourcePageIds({
        workspaceId: 'workspace-1',
        knowledgePageIds: ['kp-1', 'kp-2'],
      }),
    ).resolves.toEqual([
      'source-1',
      'source-2',
      'source-3',
      'source-4',
      'source-5',
      'source-6',
    ]);

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
        { method: 'selectFrom', args: ['knowledgeClaimSources'] },
        {
          method: 'innerJoin',
          args: [
            'knowledgeClaims',
            'knowledgeClaimSources.claimId',
            'knowledgeClaims.id',
          ],
        },
        {
          method: 'where',
          args: ['knowledgeClaims.workspaceId', '=', 'workspace-1'],
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
        { method: 'selectFrom', args: ['knowledgeGraphEdgeSources'] },
        {
          method: 'innerJoin',
          args: [
            'knowledgeGraphEdges',
            'knowledgeGraphEdgeSources.graphEdgeId',
            'knowledgeGraphEdges.id',
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

  it('finds candidate dependency source page ids for sidecar evaluation', async () => {
    const query = new FakeKyselyQuery({
      knowledgeChunkSources: [
        { sourcePageId: 'source-1' },
        { sourcePageId: 'source-2' },
        { sourcePageId: 'source-1' },
      ],
    });
    const repo = createRepo(query);

    await expect(
      repo.findCandidateDependencySourcePageIds({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
        query: 'AkashaQwenSmokeTest',
        signals: ['semantic', 'lexical', 'exact-title'],
        sourceCandidateLimit: 20,
      }),
    ).resolves.toEqual(['source-1', 'source-2']);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'selectFrom', args: ['knowledgeChunkSources'] },
        {
          method: 'innerJoin',
          args: [
            'knowledgeChunks',
            'knowledgeChunkSources.chunkId',
            'knowledgeChunks.id',
          ],
        },
        {
          method: 'where',
          args: ['knowledgeChunks.workspaceId', '=', 'workspace-1'],
        },
        {
          method: 'where',
          args: ['knowledgeChunks.spaceId', 'in', ['space-1']],
        },
        { method: 'limit', args: [20] },
      ]),
    );
  });

  it('returns only chunks whose full dependency set is sidecar eligible', async () => {
    const query = new FakeKyselyQuery({
      knowledgeChunks: [
        {
          id: 'chunk-visible',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgePageId: 'kp-visible',
          text: 'Visible AkashaQwenSmokeTest',
          embedding: [1, 0],
        },
        {
          id: 'chunk-mixed',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgePageId: 'kp-mixed',
          text: 'Mixed AkashaQwenSmokeTest',
          embedding: [1, 0],
        },
        {
          id: 'chunk-empty',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgePageId: 'kp-empty',
          text: 'No lineage',
          embedding: [1, 0],
        },
      ],
      knowledgePages: [
        { ...basePage('kp-visible'), title: 'Visible' },
        { ...basePage('kp-mixed'), title: 'Mixed' },
        { ...basePage('kp-empty'), title: 'Empty' },
      ],
      knowledgeChunkSources: [
        { chunkId: 'chunk-visible', sourcePageId: 'source-visible' },
        { chunkId: 'chunk-mixed', sourcePageId: 'source-visible' },
        { chunkId: 'chunk-mixed', sourcePageId: 'source-hidden' },
      ],
    });
    const repo = createRepo(query);

    await expect(
      repo.findSidecarEligibleChunks({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
        query: 'AkashaQwenSmokeTest',
        eligibleSourcePageIds: ['source-visible'],
        signals: ['semantic', 'lexical', 'exact-title'],
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        chunk: expect.objectContaining({ id: 'chunk-visible' }),
        page: expect.objectContaining({ id: 'kp-visible' }),
        sourcePageIds: ['source-visible'],
        signals: ['semantic', 'lexical'],
        lexicalScore: expect.any(Number),
      },
    ]);
  });

  it('uses token overlap for lexical candidates instead of requiring the full query string', async () => {
    const query = new FakeKyselyQuery({
      knowledgeChunks: [
        {
          id: 'chunk-lexical',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgePageId: 'kp-lexical',
          text: 'AkashaQwenSmokeTest lexical fallback',
          embedding: null,
        },
      ],
      knowledgePages: [
        {
          ...basePage('kp-lexical'),
          title: 'AkashaQwenSmokeTest',
          body: 'fallback body',
        },
      ],
      knowledgeChunkSources: [
        { chunkId: 'chunk-lexical', sourcePageId: 'source-lexical' },
      ],
    });
    const repo = createRepo(query);

    await expect(
      repo.findSidecarEligibleChunks({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
        query: 'AkashaQwenSmokeTest 是什么？',
        eligibleSourcePageIds: ['source-lexical'],
        signals: ['lexical', 'exact-title'],
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        chunk: expect.objectContaining({ id: 'chunk-lexical' }),
        page: expect.objectContaining({ id: 'kp-lexical' }),
        sourcePageIds: ['source-lexical'],
        signals: ['lexical', 'exact-title'],
        lexicalScore: expect.any(Number),
      },
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
      knowledgeClaimSources: [{ claimId: 'claim-1' }],
      knowledgeChunkSources: [{ chunkId: 'chunk-1' }],
      knowledgeLinkSources: [{ linkId: 'link-1' }],
      knowledgeGraphEdgeSources: [{ graphEdgeId: 'edge-1' }],
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
        { method: 'updateTable', args: ['knowledgeClaims'] },
        { method: 'where', args: ['id', 'in', ['claim-1']] },
        { method: 'updateTable', args: ['knowledgeChunks'] },
        { method: 'where', args: ['id', 'in', ['chunk-1']] },
        { method: 'updateTable', args: ['knowledgeLinks'] },
        { method: 'where', args: ['id', 'in', ['link-1']] },
        { method: 'updateTable', args: ['knowledgeGraphEdges'] },
        { method: 'where', args: ['id', 'in', ['edge-1']] },
      ]),
    );
  });
});

function createSqlRepo(): {
  repo: KnowledgeCapsuleRepo;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
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
