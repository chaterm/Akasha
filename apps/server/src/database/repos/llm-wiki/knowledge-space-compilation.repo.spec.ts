import {
  advanceSpaceRunBarrier,
  KnowledgeSpaceCompilationRepo,
} from './knowledge-space-compilation.repo';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];
  private table = '';

  constructor(
    private readonly selected?: unknown,
    private readonly rows: unknown[] = [],
  ) {}

  transaction() {
    return {
      execute: async (callback: (trx: this) => unknown) => callback(this),
    };
  }

  updateTable(...args: unknown[]) {
    this.table = String(args[0]);
    this.calls.push({ method: 'updateTable', args });
    return this;
  }

  insertInto(...args: unknown[]) {
    this.table = String(args[0]);
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    this.table = String(args[0]);
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  innerJoin(...args: unknown[]) {
    this.calls.push({ method: 'innerJoin', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  forUpdate(...args: unknown[]) {
    this.calls.push({ method: 'forUpdate', args });
    return this;
  }

  set(...args: unknown[]) {
    this.calls.push({ method: 'set', args });
    return this;
  }

  values(...args: unknown[]) {
    this.calls.push({ method: 'values', args });
    return this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
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

  returningAll(...args: unknown[]) {
    this.calls.push({ method: 'returningAll', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.rows;
  }

  async executeTakeFirstOrThrow() {
    this.calls.push({ method: 'executeTakeFirstOrThrow', args: [] });
    return this.table === 'knowledgeSpaceCompileRuns'
      ? { id: 'run-1', status: 'queued' }
      : undefined;
  }

  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    return this.selected;
  }
}

describe('advanceSpaceRunBarrier', () => {
  it('opens aggregation only when the final page becomes terminal', () => {
    const first = advanceSpaceRunBarrier(
      runState({ expectedPageCount: 2 }),
      'running',
      'succeeded',
    );
    expect(first).toEqual({
      accepted: true,
      aggregationReady: false,
      status: 'compiling',
      succeededPageCount: 1,
      failedPageCount: 0,
      skippedPageCount: 0,
    });

    const last = advanceSpaceRunBarrier(
      { ...runState({ expectedPageCount: 2 }), ...first },
      'running',
      'succeeded',
    );
    expect(last).toEqual({
      accepted: true,
      aggregationReady: true,
      status: 'aggregate_pending',
      succeededPageCount: 2,
      failedPageCount: 0,
      skippedPageCount: 0,
    });
  });

  it('counts failed and skipped pages as terminal without blocking aggregation', () => {
    const failed = advanceSpaceRunBarrier(
      runState({ expectedPageCount: 2 }),
      'running',
      'failed',
    );
    const skipped = advanceSpaceRunBarrier(
      { ...runState({ expectedPageCount: 2 }), ...failed },
      'queued',
      'skipped',
    );

    expect(skipped).toEqual(
      expect.objectContaining({
        aggregationReady: true,
        status: 'aggregate_pending',
        succeededPageCount: 0,
        failedPageCount: 1,
        skippedPageCount: 1,
      }),
    );
  });

  it('is idempotent for an already terminal page', () => {
    expect(
      advanceSpaceRunBarrier(
        runState({ expectedPageCount: 1 }),
        'succeeded',
        'succeeded',
      ),
    ).toEqual({
      accepted: false,
      aggregationReady: false,
      status: 'compiling',
      succeededPageCount: 0,
      failedPageCount: 0,
      skippedPageCount: 0,
    });
  });

  it('never reopens a superseded run', () => {
    expect(
      advanceSpaceRunBarrier(
        runState({ expectedPageCount: 1, status: 'superseded' }),
        'running',
        'succeeded',
      ),
    ).toEqual(
      expect.objectContaining({
        accepted: false,
        aggregationReady: false,
        status: 'superseded',
      }),
    );
  });
});

describe('KnowledgeSpaceCompilationRepo', () => {
  it('creates a run and pending page rows after superseding older work', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.createRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        catalogSnapshot: [],
        catalogHash: 'catalog-hash',
        sources: [
          {
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'hash-1',
          },
          {
            sourcePageId: 'page-2',
            sourceVersion: 'v2',
            sourceContentHash: 'hash-2',
          },
        ],
      }),
    ).resolves.toEqual({ id: 'run-1', status: 'queued' });

    expect(query.calls).toContainEqual({
      method: 'updateTable',
      args: ['knowledgeSpaceCompileRuns'],
    });
    const values = query.calls
      .filter((call) => call.method === 'values')
      .map((call) => call.args[0]);
    expect(values[0]).toEqual(
      expect.objectContaining({
        status: 'queued',
        expectedPageCount: 2,
        catalogHash: 'catalog-hash',
      }),
    );
    expect(values[1]).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        sourcePageId: 'page-1',
        status: 'pending',
      }),
      expect.objectContaining({
        runId: 'run-1',
        sourcePageId: 'page-2',
        status: 'pending',
      }),
    ]);
  });

  it('locks and advances the durable barrier when a page finishes', async () => {
    const query = new FakeKyselyQuery({
      pageStatus: 'running',
      runStatus: 'compiling',
      expectedPageCount: 1,
      succeededPageCount: 0,
      failedPageCount: 0,
      skippedPageCount: 0,
    });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.completePage({
        runId: 'run-1',
        sourcePageId: 'page-1',
        status: 'failed',
        errorCode: 'invalid_output',
        errorMessage: 'Knowledge compiler returned invalid output.',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        accepted: true,
        aggregationReady: true,
        status: 'aggregate_pending',
        failedPageCount: 1,
      }),
    );

    expect(query.calls).toContainEqual({ method: 'forUpdate', args: [] });
    const sets = query.calls
      .filter((call) => call.method === 'set')
      .map((call) => call.args[0]);
    expect(sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'failed',
          errorCode: 'invalid_output',
          finishedAt: expect.any(Date),
        }),
        expect.objectContaining({
          status: 'aggregate_pending',
          failedPageCount: 1,
        }),
      ]),
    );
  });

  it('lists pending page outbox rows with their parent run settings', async () => {
    const row = {
      runId: 'run-1',
      sourcePageId: 'page-1',
      trigger: 'manual_compile',
    };
    const query = new FakeKyselyQuery(undefined, [row]);
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(repo.findPendingPageDispatches(20)).resolves.toEqual([row]);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        {
          method: 'selectFrom',
          args: ['knowledgeSpaceCompileRunPages as rp'],
        },
        {
          method: 'innerJoin',
          args: ['knowledgeSpaceCompileRuns as r', 'r.id', 'rp.runId'],
        },
        { method: 'where', args: ['rp.status', '=', 'pending'] },
        {
          method: 'where',
          args: ['r.status', 'in', ['queued', 'compiling']],
        },
        { method: 'limit', args: [20] },
      ]),
    );
  });

  it('records the aggregate job id even after the worker leaves aggregate_pending', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await repo.markAggregationQueued({
      runId: 'run-1',
      jobId: 'knowledge-aggregate-space:run-1',
    });

    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['aggregateJobId', 'is', null],
    });
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['status', '!=', 'superseded'],
    });
    expect(query.calls).not.toContainEqual({
      method: 'where',
      args: ['status', '=', 'aggregate_pending'],
    });
  });
});

function runState(
  overrides: Partial<{
    status: string;
    expectedPageCount: number;
    succeededPageCount: number;
    failedPageCount: number;
    skippedPageCount: number;
  }> = {},
) {
  return {
    status: 'compiling',
    expectedPageCount: 1,
    succeededPageCount: 0,
    failedPageCount: 0,
    skippedPageCount: 0,
    ...overrides,
  };
}
