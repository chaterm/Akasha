import { KnowledgeSpaceRunnerService } from './knowledge-space-runner.service';

describe('KnowledgeSpaceRunnerService', () => {
  it('compiles strictly serially and yields after five terminal pages', async () => {
    let activeCompiles = 0;
    let maxActiveCompiles = 0;
    const completed: string[] = [];
    const pages = Array.from({ length: 6 }, (_, index) => ({
      sourcePageId: `page-${index + 1}`,
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:page-${index + 1}`,
      createdAt: new Date(index),
    }));
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, pages);
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        activeCompiles += 1;
        maxActiveCompiles = Math.max(maxActiveCompiles, activeCompiles);
        await Promise.resolve();
        completed.push(input.data.sourcePageIds[0]);
        await input.execution.completePage({ status: 'succeeded' });
        activeCompiles -= 1;
        executionRepo.findPendingTextPages.mockResolvedValue(
          pages.slice(completed.length),
        );
        return { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
          aggregateRequired: true,
          pageCompilationRequired: true,
        }),
      } as never,
      pageCompilation as never,
      { aggregateLeased: jest.fn() } as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextSlice(sliceInput(), {
        workerId: 'worker-1',
        finalAttempt: false,
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'yielded', completedPages: 5 });
    expect(maxActiveCompiles).toBe(1);
    expect(completed).toEqual([
      'page-1',
      'page-2',
      'page-3',
      'page-4',
      'page-5',
    ]);
    expect(executionRepo.yieldSpaceSlice).toHaveBeenCalledWith(lease, {
      reason: 'page_limit',
    });
  });

  it('finishes an all-reused run without compiling or aggregating', async () => {
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    const pageCompilation = { compileTextPage: jest.fn() };
    const aggregator = { aggregateLeased: jest.fn() };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
          aggregateRequired: false,
          pageCompilationRequired: false,
        }),
      } as never,
      pageCompilation as never,
      aggregator as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextSlice(sliceInput(), {
        workerId: 'worker-1',
        finalAttempt: false,
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'completed', completedPages: 0 });
    expect(pageCompilation.compileTextPage).not.toHaveBeenCalled();
    expect(aggregator.aggregateLeased).not.toHaveBeenCalled();
    expect(executionRepo.finishRun).toHaveBeenCalledWith(lease, 'succeeded');
  });

  it('renews the database lease during a long activation', async () => {
    jest.useFakeTimers();
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    let resolveInitialization!: (value: unknown) => void;
    const initialization = new Promise((resolve) => {
      resolveInitialization = resolve;
    });
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      { initializeLeasedRun: jest.fn(() => initialization) } as never,
      { compileTextPage: jest.fn() } as never,
      { aggregateLeased: jest.fn() } as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );
    const running = runner.runTextSlice(sliceInput(), {
      workerId: 'worker-1',
      finalAttempt: false,
      settings: settings(),
      monotonicNow: () => 0,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(executionRepo.heartbeatSpaceSlice).toHaveBeenCalled();
    resolveInitialization({
      initialized: true,
      aggregateRequired: false,
      pageCompilationRequired: false,
    });
    await running;
    jest.useRealTimers();
  });
});

function createExecutionRepo(
  lease: ReturnType<typeof leaseFixture>,
  pages: unknown[],
) {
  return {
    claimSpaceSlice: jest.fn().mockResolvedValue(lease),
    findLeasedRun: jest.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      catalogSnapshot: [],
      failedPageCount: 0,
    }),
    findPendingTextPages: jest.fn().mockResolvedValue(pages),
    isLeaseActive: jest.fn().mockResolvedValue(true),
    isLeaseActiveForPublication: jest.fn().mockResolvedValue(true),
    completeTextPage: jest.fn().mockResolvedValue({ barrierComplete: false }),
    heartbeatSpaceSlice: jest.fn().mockResolvedValue(true),
    yieldSpaceSlice: jest.fn().mockResolvedValue(true),
    advanceTextBarrier: jest.fn().mockResolvedValue({ barrierComplete: true }),
    hasImageWork: jest.fn().mockResolvedValue(false),
    completeInitialAggregate: jest.fn().mockResolvedValue({}),
    finishRun: jest.fn().mockResolvedValue({ run: { status: 'succeeded' } }),
  };
}

function sliceInput() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    spaceRunId: 'run-1',
    knowledgeGeneration: 0,
    phase: 'text' as const,
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__run-1__text__1',
  };
}

function leaseFixture() {
  return {
    runId: 'run-1',
    knowledgeGeneration: 0,
    jobPhase: 'text' as const,
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__run-1__text__1',
    executionToken: 'token-1',
  };
}

function settings() {
  return {
    maxPages: 5,
    maxMs: 300_000,
    heartbeatMs: 30_000,
    leaseTtlMs: 180_000,
  };
}

function pageResult() {
  return {
    type: 'compile-pages' as const,
    status: 'succeeded' as const,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compilerRunId: 'compile-1',
    sourceCount: 1,
    importedArtifactCount: 1,
    quarantinedArtifactCount: 0,
    durationMs: 1,
  };
}
