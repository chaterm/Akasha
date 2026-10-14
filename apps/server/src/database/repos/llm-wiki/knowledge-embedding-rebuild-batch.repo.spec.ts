import { KnowledgeEmbeddingRebuildBatchRepo } from './knowledge-embedding-rebuild-batch.repo';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly row: unknown = undefined) {}

  insertInto(...args: unknown[]) {
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  values(...args: unknown[]) {
    this.calls.push({ method: 'values', args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  $if(condition: boolean, apply: (query: FakeKyselyQuery) => FakeKyselyQuery) {
    this.calls.push({ method: '$if', args: [condition] });
    return condition ? apply(this) : this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return [];
  }

  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    return this.row;
  }
}

describe('KnowledgeEmbeddingRebuildBatchRepo', () => {
  it('records one aggregate row per rebuild batch', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeEmbeddingRebuildBatchRepo(query as never);

    await repo.recordBatch({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      chunkCount: 50,
      failedCount: 1,
      totalTokens: 1_200,
      durationMs: 70_000,
      embeddingProfile: 'a'.repeat(64),
      embeddingModel: 'text-embedding-3-small',
    });

    expect(query.calls).toEqual([
      { method: 'insertInto', args: ['knowledgeEmbeddingRebuildBatches'] },
      {
        method: 'values',
        args: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            chunkCount: 50,
            failedCount: 1,
            totalTokens: 1_200,
            durationMs: 70_000,
            embeddingProfile: 'a'.repeat(64),
            embeddingModel: 'text-embedding-3-small',
          },
        ],
      },
      { method: 'execute', args: [] },
    ]);
  });

  it('returns an empty summary without querying an empty Space scope', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeEmbeddingRebuildBatchRepo(query as never);

    await expect(
      repo.summarizeSpaces({ workspaceId: 'workspace-1', spaceIds: [] }),
    ).resolves.toEqual({
      batchCount: 0,
      chunkCount: 0,
      failedCount: 0,
      totalTokens: null,
      durationMs: 0,
      firstBatchAt: null,
      lastBatchAt: null,
    });
    expect(query.calls).toEqual([]);
  });

  it('coerces aggregate strings into numbers and preserves null token totals', async () => {
    const firstBatchAt = new Date('2026-10-14T06:22:00.000Z');
    const lastBatchAt = new Date('2026-10-14T06:38:31.000Z');
    const query = new FakeKyselyQuery({
      batchCount: '49',
      chunkCount: '2420',
      failedCount: '0',
      totalTokens: null,
      durationMs: '3400000',
      firstBatchAt,
      lastBatchAt,
    });
    const repo = new KnowledgeEmbeddingRebuildBatchRepo(query as never);

    await expect(
      repo.summarizeSpaces({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
      }),
    ).resolves.toEqual({
      batchCount: 49,
      chunkCount: 2420,
      failedCount: 0,
      totalTokens: null,
      durationMs: 3_400_000,
      firstBatchAt,
      lastBatchAt,
    });
  });
});
