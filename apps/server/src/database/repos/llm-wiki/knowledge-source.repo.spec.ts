import { KnowledgeSourceRepo } from './knowledge-source.repo';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

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

  updateTable(...args: unknown[]) {
    this.calls.push({ method: 'updateTable', args });
    return this;
  }

  set(...args: unknown[]) {
    this.calls.push({ method: 'set', args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  innerJoin(
    ...args: [
      unknown,
      (join: { onRef: (...args: unknown[]) => unknown }) => unknown,
    ]
  ) {
    this.calls.push({ method: 'innerJoin', args });
    const join = {
      onRef: (...onArgs: unknown[]) => {
        this.calls.push({ method: 'onRef', args: onArgs });
        return join;
      },
    };
    args[1](join);
    return this;
  }

  selectAll(...args: unknown[]) {
    this.calls.push({ method: 'selectAll', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  distinct(...args: unknown[]) {
    this.calls.push({ method: 'distinct', args });
    return this;
  }

  $if(condition: boolean, callback: (query: this) => this) {
    return condition ? callback(this) : this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  returningAll(...args: unknown[]) {
    this.calls.push({ method: 'returningAll', args });
    return this;
  }

  orderBy(...args: unknown[]) {
    this.calls.push({ method: 'orderBy', args });
    return this;
  }

  limit(...args: unknown[]) {
    this.calls.push({ method: 'limit', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.result;
  }

  async executeTakeFirstOrThrow() {
    this.calls.push({ method: 'executeTakeFirstOrThrow', args: [] });
    return this.result[0];
  }

  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    return this.result[0];
  }
}

function createRepo(query: FakeKyselyQuery) {
  return new KnowledgeSourceRepo(query as never);
}

describe('KnowledgeSourceRepo', () => {
  it('keyset-paginates source page ids for space maintenance', async () => {
    const query = new FakeKyselyQuery([
      { sourcePageId: 'page-201' },
      { sourcePageId: 'page-202' },
    ]);
    const repo = createRepo(query);

    await expect(
      repo.findSourcePageIdsBySpaceBatch({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        afterSourcePageId: 'page-200',
        limit: 200,
      }),
    ).resolves.toEqual(['page-201', 'page-202']);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeSources'] },
      { method: 'select', args: ['sourcePageId'] },
      { method: 'distinct', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourceSpaceId', '=', 'space-1'] },
      { method: 'where', args: ['deletedAt', 'is', null] },
      { method: 'where', args: ['sourcePageId', '>', 'page-200'] },
      { method: 'orderBy', args: ['sourcePageId', 'asc'] },
      { method: 'limit', args: [200] },
      { method: 'execute', args: [] },
    ]);
  });

  it('upserts page sources into the knowledgeSources table', async () => {
    const row = { id: 'source-1', workspaceId: 'workspace-1' };
    const query = new FakeKyselyQuery([row]);
    const repo = createRepo(query);

    await expect(
      repo.upsertPageSource({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        sourceType: 'page',
        sourceVersion: 'v1',
        contentHash: 'hash-1',
      }),
    ).resolves.toEqual(row);

    expect(query.calls).toEqual([
      { method: 'insertInto', args: ['knowledgeSources'] },
      {
        method: 'values',
        args: [
          {
            workspaceId: 'workspace-1',
            sourcePageId: 'page-1',
            sourceSpaceId: 'space-1',
            sourceType: 'page',
            sourceVersion: 'v1',
            contentHash: 'hash-1',
            attachmentId: null,
            extractedText: null,
            mimeType: null,
            staleAt: null,
            deletedAt: null,
          },
        ],
      },
      { method: 'onConflict', args: [expect.any(Function)] },
      { method: 'returningAll', args: [] },
      { method: 'executeTakeFirstOrThrow', args: [] },
    ]);
  });

  it('replaces exact source chunks for one source snapshot', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    expect('replaceSourceChunks' in repo).toBe(true);
    if (!('replaceSourceChunks' in repo)) return;

    await (
      repo as KnowledgeSourceRepo & {
        replaceSourceChunks(input: unknown, trx?: unknown): Promise<void>;
      }
    ).replaceSourceChunks(
      {
        workspaceId: 'workspace-1',
        sourceId: 'source-1',
        sourcePageId: 'page-1',
        chunks: [
          {
            id: 'chunk-1',
            text: 'POST /customized_query_sql',
            contentHash: 'sha256:content',
            sourceRange: { startOffset: 10, endOffset: 36 },
            quoteHash: 'sha256:quote',
          },
        ],
      },
      query,
    );

    expect(query.calls).toEqual([
      { method: 'deleteFrom', args: ['knowledgeSourceChunks'] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      { method: 'execute', args: [] },
      { method: 'insertInto', args: ['knowledgeSourceChunks'] },
      {
        method: 'values',
        args: [
          [
            {
              id: 'chunk-1',
              workspaceId: 'workspace-1',
              sourceId: 'source-1',
              sourcePageId: 'page-1',
              text: 'POST /customized_query_sql',
              contentHash: 'sha256:content',
              sourceRange: { startOffset: 10, endOffset: 36 },
              quoteHash: 'sha256:quote',
            },
          ],
        ],
      },
      { method: 'execute', args: [] },
    ]);
  });

  it('loads bounded source chunks only from active requested-page sources', async () => {
    const rows = [{ id: 'chunk-1', sourcePageId: 'page-1' }];
    const query = new FakeKyselyQuery(rows);
    const repo = createRepo(query);

    expect('findSourceChunksByPageIds' in repo).toBe(true);
    if (!('findSourceChunksByPageIds' in repo)) return;

    await expect(
      (
        repo as KnowledgeSourceRepo & {
          findSourceChunksByPageIds(input: unknown): Promise<unknown[]>;
        }
      ).findSourceChunksByPageIds({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-2'],
        limit: 40,
      }),
    ).resolves.toEqual(rows);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeSourceChunks as chunk'] },
      {
        method: 'innerJoin',
        args: ['knowledgeSources as source', expect.any(Function)],
      },
      { method: 'onRef', args: ['source.id', '=', 'chunk.sourceId'] },
      {
        method: 'onRef',
        args: ['source.workspaceId', '=', 'chunk.workspaceId'],
      },
      { method: 'selectAll', args: ['chunk'] },
      { method: 'where', args: ['chunk.workspaceId', '=', 'workspace-1'] },
      {
        method: 'where',
        args: ['chunk.sourcePageId', 'in', ['page-1', 'page-2']],
      },
      { method: 'where', args: ['source.staleAt', 'is', null] },
      { method: 'where', args: ['source.deletedAt', 'is', null] },
      { method: 'orderBy', args: ['chunk.createdAt', 'desc'] },
      { method: 'limit', args: [40] },
      { method: 'execute', args: [] },
    ]);
  });

  it('does not query when marking an empty source list stale', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await repo.markSourcesStale({
      workspaceId: 'workspace-1',
      sourcePageIds: [],
    });

    expect(query.calls).toEqual([]);
  });

  it('loads the newest active extracted source text per requested page', async () => {
    const query = new FakeKyselyQuery([
      {
        sourcePageId: 'page-1',
        extractedText: 'new source',
        updatedAt: new Date('2026-07-27T01:00:00.000Z'),
      },
      {
        sourcePageId: 'page-1',
        extractedText: 'old source',
        updatedAt: new Date('2026-07-27T00:00:00.000Z'),
      },
    ]);
    const repo = createRepo(query);

    await expect(
      repo.findActiveSourceTextsByPageIds({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual([
      { sourcePageId: 'page-1', extractedText: 'new source' },
    ]);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeSources'] },
      {
        method: 'select',
        args: [['sourcePageId', 'extractedText', 'updatedAt']],
      },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', 'in', ['page-1']] },
      { method: 'where', args: ['staleAt', 'is', null] },
      { method: 'where', args: ['deletedAt', 'is', null] },
      { method: 'where', args: ['extractedText', 'is not', null] },
      { method: 'orderBy', args: ['updatedAt', 'desc'] },
      { method: 'execute', args: [] },
    ]);
  });

  it('loads the latest active source snapshot for last-known-good fencing', async () => {
    const row = {
      id: 'source-1',
      sourcePageId: 'page-1',
      contentHash: 'sha256:current',
    };
    const query = new FakeKyselyQuery([row]);
    const repo = createRepo(query);

    await expect(
      repo.findLatestActiveSourceByPageId({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
      }),
    ).resolves.toEqual(row);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeSources'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      { method: 'where', args: ['staleAt', 'is', null] },
      { method: 'where', args: ['deletedAt', 'is', null] },
      { method: 'orderBy', args: ['updatedAt', 'desc'] },
      { method: 'orderBy', args: ['createdAt', 'desc'] },
      { method: 'executeTakeFirst', args: [] },
    ]);
  });

  it('marks sources stale within the requested workspace', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await repo.markSourcesStale({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });

    expect(query.calls).toEqual([
      { method: 'updateTable', args: ['knowledgeSources'] },
      {
        method: 'set',
        args: [expect.objectContaining({ staleAt: expect.any(Date) })],
      },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', 'in', ['page-1', 'page-2']] },
      { method: 'execute', args: [] },
    ]);
  });

  it('finds sources by workspace and space', async () => {
    const rows = [{ id: 'source-1' }];
    const query = new FakeKyselyQuery(rows);
    const repo = createRepo(query);

    await expect(
      repo.findSourcesBySpace({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual(rows);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeSources'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourceSpaceId', '=', 'space-1'] },
      { method: 'where', args: ['deletedAt', 'is', null] },
      { method: 'execute', args: [] },
    ]);
  });
});
