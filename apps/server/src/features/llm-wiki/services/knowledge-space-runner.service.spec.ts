import { KnowledgeSpaceRunnerService } from './knowledge-space-runner.service';

describe('KnowledgeSpaceRunnerService', () => {
  it('runs an explicit Finalize activation without claiming Text pages', async () => {
    const lease = {
      ...leaseFixture(),
      jobPhase: 'finalize' as const,
      spaceJobId: 'finalize-job',
    };
    const executionRepo = createExecutionRepo(leaseFixture(), []);
    executionRepo.claimSpaceLease.mockResolvedValue(lease as never);
    const spaceFinalizer = finalizer();
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {} as never,
      {} as never,
      spaceFinalizer as never,
      {} as never,
    );
    expect(
      await runner.runFinalizeLease(
        { ...leaseInput(), phase: 'finalize', spaceJobId: 'finalize-job' },
        { workerId: 'finalizer', settings: settings() },
      ),
    ).toEqual({ outcome: 'completed', completedPages: 0 });
    expect(executionRepo.claimSpaceLease).toHaveBeenCalledWith(
      expect.objectContaining({ jobPhase: 'finalize' }),
    );
    expect(executionRepo.claimNextTextPage).not.toHaveBeenCalled();
    expect(spaceFinalizer.finalizeLeased).toHaveBeenCalledWith(lease, {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(executionRepo.finishRun).toHaveBeenCalledWith(lease, 'succeeded');
  });
  it('compiles strictly serially and yields after five terminal pages', async () => {
    let activeCompiles = 0;
    let maxActiveCompiles = 0;
    const completed: string[] = [];
    const pages = Array.from({ length: 6 }, (_, index) => ({
      sourcePageId: `page-${index + 1}`,
      bindingStatus: 'bound',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:page-${index + 1}`,
      createdAt: new Date(index),
    }));
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, pages);
    executionRepo.findPendingTextPages.mockImplementation(async () =>
      pages.slice(completed.length),
    );
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        activeCompiles += 1;
        maxActiveCompiles = Math.max(maxActiveCompiles, activeCompiles);
        await Promise.resolve();
        completed.push(input.data.sourcePageIds[0]);
        await input.execution.completePage({ status: 'succeeded' });
        activeCompiles -= 1;
        executionRepo.claimNextTextPage.mockResolvedValue(
          pages[completed.length],
        );
        return { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
        }),
      } as never,
      pageCompilation as never,
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
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
    expect(executionRepo.yieldSpaceLease).toHaveBeenCalledWith(lease, {
      reason: 'page_limit',
    });
  });

  it('records a retryable text failure and keeps compiling later pages', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      sourcePageId: `retry-page-${index + 1}`,
      bindingStatus: 'bound',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:retry-page-${index + 1}`,
      createdAt: new Date(index),
    }));
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, pages);
    let completedPages = 0;
    executionRepo.findPendingTextPages.mockImplementation(async () =>
      pages.slice(completedPages),
    );
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        const firstPage = completedPages === 0;
        await input.execution.completePage({
          status: firstPage ? 'failed' : 'succeeded',
        });
        completedPages += 1;
        executionRepo.claimNextTextPage.mockResolvedValue(
          pages[completedPages],
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
        }),
      } as never,
      pageCompilation as never,
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'yielded', completedPages: 5 });
    expect(pageCompilation.compileTextPage).toHaveBeenCalledTimes(5);
  });

  it('hands an all-reused run to the Finalize outbox without finalizing inline', async () => {
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    const pageCompilation = { compileTextPage: jest.fn() };
    const spaceFinalizer = finalizer();
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
        }),
      } as never,
      pageCompilation as never,
      spaceFinalizer as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'completed', completedPages: 0 });
    expect(pageCompilation.compileTextPage).not.toHaveBeenCalled();
    expect(spaceFinalizer.finalizeLeased).not.toHaveBeenCalled();
    expect(executionRepo.finishRun).not.toHaveBeenCalled();
  });

  it('binds an unbound page and skips compilation when the snapshot is reused', async () => {
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, [
      {
        sourcePageId: 'page-1',
        bindingStatus: 'binding',
        expectedSourceVersion: null,
        expectedSourceContentHash: null,
        createdAt: new Date(0),
      },
    ]);
    const pageCompilation = { compileTextPage: jest.fn() };
    const spaceCompilation = {
      initializeLeasedRun: jest.fn().mockResolvedValue({
        initialized: true,
      }),
      bindLeasedRunPage: jest.fn().mockResolvedValue({ outcome: 'reused' }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      spaceCompilation as never,
      pageCompilation as never,
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );
    executionRepo.claimNextTextPage
      .mockResolvedValueOnce({
        sourcePageId: 'page-1',
        bindingStatus: 'binding',
        expectedSourceVersion: null,
        expectedSourceContentHash: null,
        createdAt: new Date(0),
      })
      .mockResolvedValue(undefined);
    executionRepo.findPendingTextPages.mockResolvedValue([]);

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'completed', completedPages: 1 });
    expect(spaceCompilation.bindLeasedRunPage).toHaveBeenCalledWith(lease, {
      sourcePageId: 'page-1',
    });
    expect(pageCompilation.compileTextPage).not.toHaveBeenCalled();
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
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );
    const running = runner.runTextLease(leaseInput(), {
      workerId: 'worker-1',
      settings: settings(),
      monotonicNow: () => 0,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(executionRepo.heartbeatSpaceLease).toHaveBeenCalled();
    resolveInitialization({
      initialized: true,
    });
    await running;
    jest.useRealTimers();
  });

  it('keeps a lease alive when a background heartbeat temporarily fails', async () => {
    jest.useFakeTimers();
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    executionRepo.heartbeatSpaceLease.mockRejectedValueOnce(
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
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );
    const running = runner.runTextLease(leaseInput(), {
      workerId: 'worker-1',
      settings: settings(),
      monotonicNow: () => 0,
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30_000);
    resolveInitialization({
      initialized: true,
    });

    await expect(running).resolves.toEqual({
      outcome: 'completed',
      completedPages: 0,
    });
    jest.useRealTimers();
  });

  it('reaches the text barrier with a failed page in the middle of the pass', async () => {
    const pages = Array.from({ length: 3 }, (_, index) => ({
      sourcePageId: `barrier-page-${index + 1}`,
      bindingStatus: 'bound',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:barrier-page-${index + 1}`,
      createdAt: new Date(index),
    }));
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, pages);
    let index = 0;
    executionRepo.findPendingTextPages.mockImplementation(async () =>
      pages.slice(index),
    );
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        const failing = index === 1;
        await input.execution.completePage({
          status: failing ? 'failed' : 'succeeded',
          ...(failing ? { retryable: true } : {}),
        });
        index += 1;
        executionRepo.claimNextTextPage.mockResolvedValue(pages[index]);
        return failing
          ? {
              outcome: 'failed',
              retryable: true,
              cause: new Error('provider unavailable'),
            }
          : { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
        }),
      } as never,
      pageCompilation as never,
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'completed', completedPages: 3 });
    expect(pageCompilation.compileTextPage).toHaveBeenCalledTimes(3);
    expect(executionRepo.advanceTextBarrier).toHaveBeenCalledWith(lease);
  });

  it('re-enters the claim loop when the text barrier settles pages', async () => {
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    const settledPage = {
      sourcePageId: 'settled-page',
      bindingStatus: 'bound',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: 'sha256:settled-page',
      createdAt: new Date(0),
    };
    executionRepo.claimNextTextPage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(settledPage)
      .mockResolvedValue(undefined);
    executionRepo.advanceTextBarrier
      .mockResolvedValueOnce({
        barrierComplete: false,
        reclaimed: true,
        imagesRequired: false,
      })
      .mockResolvedValue({ barrierComplete: true, imagesRequired: false });
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        await input.execution.completePage({ status: 'succeeded' });
        return { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
        }),
      } as never,
      pageCompilation as never,
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'completed', completedPages: 1 });
    expect(pageCompilation.compileTextPage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourcePageIds: ['settled-page'] }),
      }),
      expect.anything(),
    );
    expect(executionRepo.advanceTextBarrier).toHaveBeenCalledTimes(2);
    expect(executionRepo.finishRun).not.toHaveBeenCalled();
  });

  it('yields mid-settlement and leaves the settled page for the next lease', async () => {
    const lease = leaseFixture();
    const executionRepo = createExecutionRepo(lease, []);
    const settledPages = Array.from({ length: 6 }, (_, index) => ({
      sourcePageId: `resettled-${index + 1}`,
      bindingStatus: 'bound',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: `sha256:resettled-${index + 1}`,
      createdAt: new Date(index),
    }));
    let served = 0;
    const peek = () => (served === 0 ? undefined : settledPages[served - 1]);
    executionRepo.claimNextTextPage.mockImplementation(async () => peek());
    executionRepo.findPendingTextPages.mockImplementation(async () => {
      const next = peek();
      return next ? [next] : [];
    });
    executionRepo.advanceTextBarrier.mockResolvedValue({
      barrierComplete: false,
      reclaimed: true,
      imagesRequired: false,
    });
    const pageCompilation = {
      compileTextPage: jest.fn(async (input) => {
        await input.execution.completePage({ status: 'succeeded' });
        served += 1;
        return { outcome: 'succeeded', result: pageResult() };
      }),
    };
    const runner = new KnowledgeSpaceRunnerService(
      executionRepo as never,
      {
        initializeLeasedRun: jest.fn().mockResolvedValue({
          initialized: true,
        }),
      } as never,
      pageCompilation as never,
      finalizer() as never,
      { getKnowledgePageDeadlineMs: () => 900_000 } as never,
    );
    served = 1;

    await expect(
      runner.runTextLease(leaseInput(), {
        workerId: 'worker-1',
        settings: settings(),
        monotonicNow: () => 0,
      }),
    ).resolves.toEqual({ outcome: 'yielded', completedPages: 5 });
    expect(executionRepo.yieldSpaceLease).toHaveBeenCalledWith(lease, {
      reason: 'page_limit',
    });
    expect(executionRepo.finishRun).not.toHaveBeenCalled();
  });
});

function createExecutionRepo(
  lease: ReturnType<typeof leaseFixture>,
  pages: unknown[],
) {
  const firstPage = pages[0];
  return {
    claimSpaceLease: jest.fn().mockResolvedValue(lease),
    findLeasedRun: jest.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      failedPageCount: 0,
    }),
    findPendingTextPages: jest.fn().mockResolvedValue(pages),
    claimNextTextPage: jest.fn().mockResolvedValue(firstPage),
    isLeaseActive: jest.fn().mockResolvedValue(true),
    isLeaseActiveForPublication: jest.fn().mockResolvedValue(true),
    completeTextPage: jest.fn().mockResolvedValue({ barrierComplete: false }),
    heartbeatSpaceLease: jest.fn().mockResolvedValue(true),
    yieldSpaceLease: jest.fn().mockResolvedValue(true),
    advanceTextBarrier: jest
      .fn()
      .mockResolvedValue({ barrierComplete: true, imagesRequired: false }),
    hasImageWork: jest.fn().mockResolvedValue(false),
    completeInitialAggregate: jest.fn().mockResolvedValue({}),
    finishRun: jest.fn().mockResolvedValue({ run: { status: 'succeeded' } }),
  };
}

function leaseInput() {
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

function finalizer() {
  return {
    finalizeLeased: jest.fn().mockResolvedValue({
      outcome: 'completed',
      resolvedCanonicalLinkCount: 0,
    }),
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
