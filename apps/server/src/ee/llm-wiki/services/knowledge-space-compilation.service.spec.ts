import { Queue } from 'bullmq';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

describe('KnowledgeSpaceCompilationService', () => {
  it('persists a catalog/source snapshot and dispatches idempotent page jobs', async () => {
    const { service, repo, queue, compilationRepo, catalog } = createService();

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'run-1' }));

    expect(catalog.snapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        catalogSnapshot: [expect.objectContaining({ canonicalKey: 'alpha' })],
        catalogHash: 'sha256:catalog',
        sources: [
          expect.objectContaining({
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'hash-1',
          }),
        ],
      }),
    );
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ compileTaskId: jobId, compilerRunId: 'run-1' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      expect.objectContaining({
        sourcePageIds: ['page-1'],
        spaceRunId: 'run-1',
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
      }),
      expect.objectContaining({
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 31_000 },
      }),
    );
    expect(repo.markPageQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      sourcePageId: 'page-1',
      jobId,
    });
  });

  it('does not clean or dispatch when the locked repo rejects a stale command', async () => {
    const requestedAt = new Date('2026-07-27T03:00:00.000Z');
    const { service, repo, queue } = createService({
      createRunResult: {
        created: false,
        run: { id: 'run-newer', status: 'compiling' },
        supersededRunIds: [],
        supersededJobIds: [],
      },
      pendingPages: [],
    });
    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        requestedAt,
        sources: [source()],
      }),
    ).resolves.toBeNull();

    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAt }),
    );
    expect(repo.findPendingPageDispatches).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('removes superseded waiting jobs before dispatching the new run', async () => {
    const waiting = queueJob('waiting');
    const delayed = queueJob('delayed');
    const paused = queueJob('paused');
    const active = queueJob('active');
    const completed = queueJob('completed');
    const { service, repo, queue } = createService({
      createRunResult: {
        run: { id: 'run-2', status: 'queued' },
        supersededRunIds: ['run-1'],
        supersededJobIds: [
          'waiting-job',
          'delayed-job',
          'paused-job',
          'active-job',
          'completed-job',
        ],
      },
      queueJobs: {
        'waiting-job': waiting,
        'delayed-job': delayed,
        'paused-job': paused,
        'active-job': active,
        'completed-job': completed,
      },
      pendingPages: [],
    });

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual({ id: 'run-2', status: 'queued' });

    expect(queue.getJob).toHaveBeenCalledTimes(5);
    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(delayed.remove).toHaveBeenCalledTimes(1);
    expect(paused.remove).toHaveBeenCalledTimes(1);
    expect(active.remove).not.toHaveBeenCalled();
    expect(completed.remove).not.toHaveBeenCalled();
    expect(repo.findPendingPageDispatches).toHaveBeenCalledTimes(1);
    expect(waiting.remove.mock.invocationCallOrder[0]).toBeLessThan(
      repo.findPendingPageDispatches.mock.invocationCallOrder[0],
    );
  });

  it('warns on an individual cancellation failure and still dispatches the new run', async () => {
    const failedRemoval = queueJob('waiting');
    failedRemoval.remove.mockRejectedValueOnce(new Error('redis unavailable'));
    const { service, repo } = createService({
      createRunResult: {
        run: { id: 'run-2', status: 'queued' },
        supersededRunIds: ['run-1'],
        supersededJobIds: ['failed-removal'],
      },
      queueJobs: { 'failed-removal': failedRemoval },
      pendingPages: [],
    });
    const loggerWarn = jest
      .spyOn(
        (service as never as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual({ id: 'run-2', status: 'queued' });

    expect(repo.findPendingPageDispatches).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed-removal'),
    );
  });

  it('queues a retry as an idempotent page job and records its attempt', async () => {
    const { service, queue, compilationRepo } = createService({
      pendingPages: [],
    });

    await expect(service.queuePageRetry(source())).resolves.toMatch(
      /^knowledge-retry-page__workspace-1__space-1__page-1__[a-f0-9]{64}$/,
    );

    const jobId = (queue.add.mock.calls[0][2] as { jobId: string }).jobId;
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'hash-1',
      compilerVersion: expect.any(String),
      promptVersion: expect.any(String),
      compilerRunId: jobId,
      compileTaskId: jobId,
    });
    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
        trigger: 'retry_compile',
      },
      expect.objectContaining({
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 31_000 },
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it('checks the exact run identity for processor fencing', async () => {
    const { service, repo } = createService({ pendingPages: [] });

    await expect(
      service.isRunActive({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toBe(true);

    expect(repo.isRunActive).toHaveBeenCalledWith({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });

  it('dispatches aggregate-pending runs with a stable job id', async () => {
    const { service, repo, queue } = createService({
      pendingPages: [],
      pendingAggregates: [
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
        },
      ],
    });

    await service.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        spaceRunId: 'run-1',
      },
      expect.objectContaining({
        jobId: 'knowledge-aggregate-space__run-1',
        attempts: 3,
      }),
    );
    expect(repo.markAggregationQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      jobId: 'knowledge-aggregate-space__run-1',
    });
  });

  it('removes a page job and skips its attempt when the run is superseded before the outbox mark', async () => {
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    const waiting = queueJob('waiting');
    const { service, compilationRepo } = createService({
      markPageQueuedResult: false,
      queueJobs: { [jobId]: waiting },
    });

    await service.dispatchPending();

    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: jobId,
      reasonCode: 'run_superseded',
      reasonMessage: 'Knowledge Space run was superseded before dispatch.',
    });
  });

  it('leaves an active page job for worker fencing but still skips the queued attempt', async () => {
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    const active = queueJob('active');
    const { service, compilationRepo } = createService({
      markPageQueuedResult: false,
      queueJobs: { [jobId]: active },
    });

    await service.dispatchPending();

    expect(active.remove).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: jobId,
        reasonCode: 'run_superseded',
      }),
    );
  });

  it('removes an aggregate job when the run is superseded before the outbox mark', async () => {
    const jobId = 'knowledge-aggregate-space__run-1';
    const waiting = queueJob('waiting');
    const { service, compilationRepo } = createService({
      pendingPages: [],
      pendingAggregates: [
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
        },
      ],
      markAggregationQueuedResult: false,
      queueJobs: { [jobId]: waiting },
    });

    await service.dispatchPending();

    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(compilationRepo.skipAttempt).not.toHaveBeenCalled();
  });
});

function createService(
  overrides: {
    pendingPages?: unknown[];
    pendingAggregates?: unknown[];
    createRunResult?: unknown;
    queueJobs?: Record<string, ReturnType<typeof queueJob>>;
    markPageQueuedResult?: boolean;
    markAggregationQueuedResult?: boolean;
  } = {},
) {
  const pendingPages = overrides.pendingPages ?? [
    {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: 'hash-1',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    },
  ];
  const repo = {
    createRun: jest.fn().mockResolvedValue(
      overrides.createRunResult ?? {
        run: { id: 'run-1', status: 'queued' },
        supersededRunIds: [],
        supersededJobIds: [],
      },
    ),
    findPendingPageDispatches: jest.fn().mockResolvedValue(pendingPages),
    markPageQueued: jest
      .fn()
      .mockResolvedValue(overrides.markPageQueuedResult ?? true),
    findAggregatePendingRuns: jest
      .fn()
      .mockResolvedValue(overrides.pendingAggregates ?? []),
    markAggregationQueued: jest
      .fn()
      .mockResolvedValue(overrides.markAggregationQueuedResult ?? true),
    hasActiveRun: jest.fn().mockResolvedValue(false),
    isRunActive: jest.fn().mockResolvedValue(true),
  };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest
      .fn()
      .mockImplementation(async (jobId: string) =>
        Object.prototype.hasOwnProperty.call(overrides.queueJobs ?? {}, jobId)
          ? overrides.queueJobs?.[jobId]
          : undefined,
      ),
  };
  const compilationRepo = {
    queueAttempt: jest.fn().mockResolvedValue(undefined),
    skipAttempt: jest.fn().mockResolvedValue(undefined),
  };
  const catalog = {
    snapshot: jest.fn().mockResolvedValue({
      entries: [
        {
          artifactId: 'artifact-1',
          artifactKind: 'concept',
          canonicalKey: 'alpha',
          title: 'Alpha',
          summary: 'Alpha body',
        },
      ],
      hash: 'sha256:catalog',
    }),
  };
  const service = new KnowledgeSpaceCompilationService(
    queue as unknown as Queue,
    repo as unknown as KnowledgeSpaceCompilationRepo,
    compilationRepo as unknown as KnowledgeCompilationRepo,
    catalog as unknown as KnowledgeArtifactCatalogService,
  );
  return { service, repo, queue, compilationRepo, catalog };
}

function queueJob(state: string) {
  return {
    getState: jest.fn().mockResolvedValue(state),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

function source() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
    title: 'Page',
    text: 'Body',
    references: [],
  };
}
