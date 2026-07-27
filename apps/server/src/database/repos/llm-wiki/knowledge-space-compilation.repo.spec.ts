import {
  advanceSpaceRunBarrier,
  KnowledgeSpaceCompilationRepo,
} from './knowledge-space-compilation.repo';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];
  private table = '';
  private operation: 'insert' | 'select' | 'update' | undefined;

  constructor(
    private readonly selected?: unknown,
    private readonly rows: unknown[] = [],
    private readonly fixtures: {
      oldRuns?: unknown[];
      supersededPages?: unknown[];
      insertedRun?: unknown;
      activeRun?: unknown;
      requestOrderedRun?: { queuedAt: Date } & Record<string, unknown>;
      supersededPageJobs?: unknown[];
      supersededAggregateJobs?: unknown[];
    } = {},
  ) {}

  transaction() {
    return {
      execute: async (callback: (trx: this) => unknown) => callback(this),
    };
  }

  updateTable(...args: unknown[]) {
    this.table = String(args[0]);
    this.operation = 'update';
    this.calls.push({ method: 'updateTable', args });
    return this;
  }

  insertInto(...args: unknown[]) {
    this.table = String(args[0]);
    this.operation = 'insert';
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    this.table = String(args[0]);
    this.operation = 'select';
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

  selectAll(...args: unknown[]) {
    this.calls.push({ method: 'selectAll', args });
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

  returning(...args: unknown[]) {
    this.calls.push({ method: 'returning', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    if (
      this.operation === 'select' &&
      this.table === 'knowledgeSpaceCompileRuns' &&
      this.fixtures.oldRuns
    ) {
      return this.fixtures.oldRuns;
    }
    if (
      this.operation === 'update' &&
      this.table === 'knowledgeSpaceCompileRunPages' &&
      this.fixtures.supersededPages
    ) {
      return this.fixtures.supersededPages;
    }
    return this.rows;
  }

  async executeTakeFirstOrThrow() {
    this.calls.push({ method: 'executeTakeFirstOrThrow', args: [] });
    if (this.table === 'spaces') return { id: 'space-1' };
    return this.table === 'knowledgeSpaceCompileRuns'
      ? (this.fixtures.insertedRun ?? { id: 'run-1', status: 'queued' })
      : undefined;
  }

  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    if (
      this.operation === 'select' &&
      this.table === 'knowledgeSpaceCompileRuns' &&
      this.fixtures.requestOrderedRun !== undefined
    ) {
      const requestedAt = [...this.calls]
        .reverse()
        .find(
          (call) =>
            call.method === 'where' &&
            call.args[0] === 'queuedAt' &&
            call.args[1] === '>',
        )?.args[2];
      if (
        requestedAt instanceof Date &&
        this.fixtures.requestOrderedRun.queuedAt > requestedAt
      ) {
        return this.fixtures.requestOrderedRun;
      }
    }
    if (
      this.operation === 'select' &&
      this.table === 'knowledgeSpaceCompileRuns' &&
      this.fixtures.activeRun !== undefined
    ) {
      return this.fixtures.activeRun;
    }
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
  it('rejects an older full-space command while holding the space lock', async () => {
    const newerRun = {
      id: 'run-newer',
      status: 'compiling',
      queuedAt: new Date('2026-07-27T03:00:01.000Z'),
      createdAt: new Date('2026-07-27T03:00:03.000Z'),
    };
    const query = new FakeKyselyQuery(undefined, [], {
      requestOrderedRun: newerRun,
    });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);
    const requestedAt = new Date('2026-07-27T03:00:00.000Z');

    await expect(
      repo.createRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        catalogSnapshot: [],
        catalogHash: 'catalog-hash',
        requestedAt,
        sources: [],
      }),
    ).resolves.toEqual({
      created: false,
      run: newerRun,
      supersededRunIds: [],
      supersededJobIds: [],
    });

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'forUpdate', args: [] },
        { method: 'where', args: ['queuedAt', '>', requestedAt] },
      ]),
    );
    expect(query.calls).not.toContainEqual({
      method: 'insertInto',
      args: ['knowledgeSpaceCompileRuns'],
    });
  });

  it('allows a newer request even when an older request created its run later', async () => {
    const olderRequestRun = {
      id: 'run-older-request',
      status: 'compiling',
      queuedAt: new Date('2026-07-27T03:00:00.000Z'),
      createdAt: new Date('2026-07-27T03:00:03.000Z'),
    };
    const query = new FakeKyselyQuery(undefined, [], {
      requestOrderedRun: olderRequestRun,
    });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);
    const newerRequestedAt = new Date('2026-07-27T03:00:02.000Z');

    await expect(
      repo.createRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        catalogSnapshot: [],
        catalogHash: 'catalog-hash',
        requestedAt: newerRequestedAt,
        sources: [],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        created: true,
        run: expect.objectContaining({ id: 'run-1' }),
      }),
    );

    const runValues = query.calls.find(
      (call) =>
        call.method === 'values' &&
        !Array.isArray(call.args[0]) &&
        (call.args[0] as { trigger?: string }).trigger === 'manual_compile',
    )?.args[0];
    expect(runValues).toEqual(
      expect.objectContaining({ queuedAt: newerRequestedAt }),
    );
  });

  it('locks the space, supersedes old work, and returns exact old job ids', async () => {
    const query = new FakeKyselyQuery(undefined, [], {
      oldRuns: [
        {
          id: 'run-old-1',
          aggregateJobId: 'aggregate-old-1',
          skippedPageCount: 1,
        },
        {
          id: 'run-old-2',
          aggregateJobId: null,
          skippedPageCount: 0,
        },
      ],
      supersededPages: [
        { runId: 'run-old-1', jobId: 'page-job-old-1' },
        { runId: 'run-old-1', jobId: null },
        { runId: 'run-old-2', jobId: 'page-job-old-2' },
      ],
    });
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
    ).resolves.toEqual({
      created: true,
      run: { id: 'run-1', status: 'queued' },
      supersededRunIds: ['run-old-1', 'run-old-2'],
      supersededJobIds: ['page-job-old-1', 'page-job-old-2', 'aggregate-old-1'],
    });

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'selectFrom', args: ['spaces'] },
        { method: 'where', args: ['id', '=', 'space-1'] },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'forUpdate', args: [] },
        {
          method: 'where',
          args: [
            'status',
            'in',
            ['queued', 'compiling', 'aggregate_pending', 'aggregating'],
          ],
        },
        {
          method: 'where',
          args: ['status', 'in', ['pending', 'queued', 'running']],
        },
      ]),
    );
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

    const sets = query.calls
      .filter((call) => call.method === 'set')
      .map((call) => call.args[0]);
    expect(sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'skipped',
          errorCode: 'run_superseded',
          finishedAt: expect.any(Date),
        }),
        expect.objectContaining({
          status: 'superseded',
          skippedPageCount: 3,
        }),
        expect.objectContaining({
          status: 'superseded',
          skippedPageCount: 1,
        }),
      ]),
    );
  });

  it('recognizes only the matching nonterminal run as active', async () => {
    const query = new FakeKyselyQuery(undefined, [], {
      activeRun: { id: 'run-1' },
    });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.isRunActive({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toBe(true);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'where', args: ['id', '=', 'run-1'] },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['spaceId', '=', 'space-1'] },
        {
          method: 'where',
          args: [
            'status',
            'in',
            ['queued', 'compiling', 'aggregate_pending', 'aggregating'],
          ],
        },
      ]),
    );
  });

  it('checks the run fence while holding the space publication lock', async () => {
    const trx = new FakeKyselyQuery(undefined, [], {
      activeRun: { id: 'run-1' },
    });
    const repo = new KnowledgeSpaceCompilationRepo({} as never);

    await expect(
      repo.isRunActiveForPublication(
        {
          runId: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
        },
        trx as never,
      ),
    ).resolves.toBe(true);

    expect(trx.calls).toEqual(
      expect.arrayContaining([
        { method: 'selectFrom', args: ['spaces'] },
        { method: 'forUpdate', args: [] },
        { method: 'where', args: ['id', '=', 'run-1'] },
        {
          method: 'where',
          args: [
            'status',
            'in',
            ['queued', 'compiling', 'aggregate_pending', 'aggregating'],
          ],
        },
      ]),
    );
  });

  it('finds an active run by workspace and space for retry conflict checks', async () => {
    const activeRun = { id: 'run-1', status: 'compiling' };
    const query = new FakeKyselyQuery(undefined, [], { activeRun });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);
    const activeRunRepo = repo as unknown as {
      findActiveRun(input: {
        workspaceId: string;
        spaceId: string;
      }): Promise<unknown>;
      hasActiveRun(input: {
        workspaceId: string;
        spaceId: string;
      }): Promise<boolean>;
    };

    await expect(
      activeRunRepo.findActiveRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual(activeRun);
    await expect(
      activeRunRepo.hasActiveRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toBe(true);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['spaceId', '=', 'space-1'] },
        {
          method: 'where',
          args: [
            'status',
            'in',
            ['queued', 'compiling', 'aggregate_pending', 'aggregating'],
          ],
        },
      ]),
    );
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

  it('reports that a page outbox mark succeeded while its parent run is not superseded', async () => {
    const query = new FakeKyselyQuery({ id: 'run-1', runId: 'run-1' });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.markPageQueued({
        runId: 'run-1',
        sourcePageId: 'page-1',
        jobId: 'page-job-1',
      }),
    ).resolves.toBe(true);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'forUpdate', args: [] },
        { method: 'where', args: ['status', '!=', 'superseded'] },
      ]),
    );
  });

  it('rejects a page outbox mark after its parent run is superseded', async () => {
    const query = new FakeKyselyQuery(undefined);
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.markPageQueued({
        runId: 'run-1',
        sourcePageId: 'page-1',
        jobId: 'page-job-1',
      }),
    ).resolves.toBe(false);

    expect(query.calls).not.toContainEqual({
      method: 'updateTable',
      args: ['knowledgeSpaceCompileRunPages'],
    });
  });

  it('records the aggregate job id even after the worker leaves aggregate_pending', async () => {
    const query = new FakeKyselyQuery({ id: 'run-1' });
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.markAggregationQueued({
        runId: 'run-1',
        jobId: 'knowledge-aggregate-space:run-1',
      }),
    ).resolves.toBe(true);

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

  it('reports a failed aggregate outbox mark after the run is superseded', async () => {
    const query = new FakeKyselyQuery(undefined);
    const repo = new KnowledgeSpaceCompilationRepo(query as never);

    await expect(
      repo.markAggregationQueued({
        runId: 'run-1',
        jobId: 'knowledge-aggregate-space:run-1',
      }),
    ).resolves.toBe(false);
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
