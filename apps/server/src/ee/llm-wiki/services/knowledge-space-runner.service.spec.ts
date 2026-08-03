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

  it('continues text pages after a retryable page is checkpointed on the final attempt', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      sourcePageId: `retry-page-${index + 1}`,
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:retry-page-${index + 1}`,
      createdAt: new Date(index),
    }));
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, pages);
    let completedPages = 0;
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        const firstPage = completedPages === 0;
        await input.execution.completePage({
          status: firstPage ? 'failed' : 'succeeded',
        });
        completedPages += 1;
        executionRepo.findPendingTextPages.mockResolvedValue(
          pages.slice(completedPages),
        );
        return firstPage
          ? {
              outcome: 'failed',
              retryable: true,
              cause: new Error('provider retries exhausted'),
            }
          : { outcome: 'succeeded', result: pageResult() };
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
        finalAttempt: true,
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'yielded', completedPages: 5 });
    expect(pageCompilation.compileTextPage).toHaveBeenCalledTimes(5);
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

  it('keeps a slice alive when a background heartbeat temporarily fails', async () => {
    jest.useFakeTimers();
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    executionRepo.heartbeatSpaceSlice.mockRejectedValueOnce(
      new Error('database pool temporarily unavailable'),
    );
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
    resolveInitialization({
      initialized: true,
      aggregateRequired: false,
      pageCompilationRequired: false,
    });

    await expect(running).resolves.toEqual({
      outcome: 'completed',
      completedPages: 0,
    });
    jest.useRealTimers();
  });

  it('merges image pages strictly serially and yields after five terminal pages', async () => {
    let activeMerges = 0;
    let maxActiveMerges = 0;
    const completed: string[] = [];
    const pages = Array.from({ length: 6 }, (_, index) => ({
      id: `run-page-${index + 1}`,
      sourcePageId: `page-${index + 1}`,
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:page-${index + 1}`,
      targetEffectiveKnowledgeHash: null,
      createdAt: new Date(index),
      images: [],
    }));
    const lease = mergeLeaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    executionRepo.findPendingMergePages = jest.fn().mockResolvedValue(pages);
    executionRepo.completeMergePagePublicationInTransaction = jest
      .fn()
      .mockResolvedValue(true);
    executionRepo.isLeaseActiveForMergePublication = jest
      .fn()
      .mockResolvedValue(true);
    executionRepo.failMergePage = jest.fn().mockResolvedValue({});
    const pageCompilation = {
      mergePageImages: jest.fn(async (input) => {
        activeMerges += 1;
        maxActiveMerges = Math.max(maxActiveMerges, activeMerges);
        await Promise.resolve();
        completed.push(input.data.sourcePageId);
        activeMerges -= 1;
        executionRepo.findPendingMergePages.mockResolvedValue(
          pages.slice(completed.length),
        );
        return { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const aggregator = { aggregateLeased: jest.fn() };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      { initializeLeasedRun: jest.fn() } as never,
      pageCompilation as never,
      aggregator as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runImageMergeSlice(mergeSliceInput(), {
        workerId: 'worker-1',
        finalAttempt: false,
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'yielded', completedPages: 5 });
    expect(maxActiveMerges).toBe(1);
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
    expect(aggregator.aggregateLeased).not.toHaveBeenCalled();
  });

  it('continues image merges after a retryable page is checkpointed on the final attempt', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      id: `retry-run-page-${index + 1}`,
      sourcePageId: `retry-merge-page-${index + 1}`,
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:retry-merge-page-${index + 1}`,
      targetEffectiveKnowledgeHash: null,
      createdAt: new Date(index),
      images: [],
    }));
    const lease = mergeLeaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    executionRepo.findPendingMergePages = jest.fn().mockResolvedValue(pages);
    let completedPages = 0;
    const pageCompilation = {
      mergePageImages: jest.fn(async (input) => {
        const firstPage = completedPages === 0;
        if (firstPage) {
          await input.execution.completePage({ status: 'failed' });
        }
        completedPages += 1;
        executionRepo.findPendingMergePages.mockResolvedValue(
          pages.slice(completedPages),
        );
        return firstPage
          ? {
              outcome: 'failed',
              retryable: true,
              cause: new Error('provider retries exhausted'),
            }
          : { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      { initializeLeasedRun: jest.fn() } as never,
      pageCompilation as never,
      { aggregateLeased: jest.fn() } as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runImageMergeSlice(mergeSliceInput(), {
        workerId: 'worker-1',
        finalAttempt: true,
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'yielded', completedPages: 5 });
    expect(pageCompilation.mergePageImages).toHaveBeenCalledTimes(5);
  });

  it('runs the final aggregate only after the image merge barrier', async () => {
    const lease = mergeLeaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    executionRepo.findPendingMergePages = jest.fn().mockResolvedValue([]);
    executionRepo.advanceMergeBarrier = jest
      .fn()
      .mockResolvedValue({ barrierComplete: true });
    executionRepo.hasPartialOutcome = jest.fn().mockResolvedValue(true);
    const aggregator = {
      aggregateLeased: jest.fn().mockResolvedValue({
        importedArtifactCount: 2,
        quarantinedArtifactCount: 1,
        catalogHash: 'sha256:final-catalog',
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      { initializeLeasedRun: jest.fn() } as never,
      { mergePageImages: jest.fn() } as never,
      aggregator as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runImageMergeSlice(mergeSliceInput(), {
        workerId: 'worker-1',
        finalAttempt: false,
        settings: settings(),
      }),
    ).resolves.toEqual({ outcome: 'completed', completedPages: 0 });
    expect(executionRepo.advanceMergeBarrier).toHaveBeenCalledWith(lease);
    expect(aggregator.aggregateLeased).toHaveBeenCalledWith(lease, {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(executionRepo.finishRun).toHaveBeenCalledWith(lease, 'partial', {
      importedArtifactCount: 2,
      quarantinedArtifactCount: 1,
      catalogHash: 'sha256:final-catalog',
    });
  });
});

function createExecutionRepo(
  lease: ReturnType<typeof leaseFixture> | ReturnType<typeof mergeLeaseFixture>,
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
    findPendingMergePages: jest.fn().mockResolvedValue([]),
    isLeaseActive: jest.fn().mockResolvedValue(true),
    isLeaseActiveForPublication: jest.fn().mockResolvedValue(true),
    isLeaseActiveForMergePublication: jest.fn().mockResolvedValue(true),
    completeMergePagePublicationInTransaction: jest
      .fn()
      .mockResolvedValue(true),
    failMergePage: jest.fn().mockResolvedValue({}),
    completeTextPage: jest.fn().mockResolvedValue({ barrierComplete: false }),
    heartbeatSpaceSlice: jest.fn().mockResolvedValue(true),
    yieldSpaceSlice: jest.fn().mockResolvedValue(true),
    advanceTextBarrier: jest.fn().mockResolvedValue({ barrierComplete: true }),
    hasImageWork: jest.fn().mockResolvedValue(false),
    completeInitialAggregate: jest.fn().mockResolvedValue({}),
    advanceMergeBarrier: jest.fn().mockResolvedValue({ barrierComplete: true }),
    hasPartialOutcome: jest.fn().mockResolvedValue(false),
    finishRun: jest.fn().mockResolvedValue({ run: { status: 'succeeded' } }),
  };
}

function mergeSliceInput() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    spaceRunId: 'run-1',
    knowledgeGeneration: 0,
    phase: 'image_merge' as const,
    spaceJobSequence: 2,
    spaceJobId: 'knowledge-space-image-merge__run-1__image_merge__2',
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

function mergeLeaseFixture() {
  return {
    runId: 'run-1',
    knowledgeGeneration: 0,
    jobPhase: 'image_merge' as const,
    spaceJobSequence: 2,
    spaceJobId: 'knowledge-space-image-merge__run-1__image_merge__2',
    executionToken: 'token-2',
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
    type: 'text' as const,
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
