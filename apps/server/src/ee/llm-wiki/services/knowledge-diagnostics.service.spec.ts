import { QueueJob } from '../../../integrations/queue/constants';
import {
  KnowledgeDiagnosticsJob,
  KnowledgeDiagnosticsService,
  buildCompileRunProgress,
  buildPageCompilationDiagnostics,
  buildCompileStatusesFromJobs,
  buildCompileStatusesFromRuns,
} from './knowledge-diagnostics.service';

describe('KnowledgeDiagnosticsService queue counts', () => {
  it('samples text and image BullMQ queues independently', async () => {
    const textQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 13, active: 1 }),
    };
    const imageQueue = {
      getJobCounts: jest.fn().mockResolvedValue({ delayed: 2, active: 2 }),
    };
    const service = new KnowledgeDiagnosticsService(
      {} as never,
      textQueue as never,
      imageQueue as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T06:00:00.000Z'));
    await expect(
      (
        service as unknown as {
          findQueueSnapshots(): Promise<Record<string, unknown>>;
        }
      ).findQueueSnapshots(),
    ).resolves.toEqual({
      text: {
        waiting: 13,
        active: 1,
        delayed: 0,
        prioritized: 0,
        waitingChildren: 0,
        paused: 0,
        failed: 0,
        completed: 0,
        sampledAt: '2026-07-28T06:00:00.000Z',
      },
      image: {
        waiting: 0,
        active: 2,
        delayed: 2,
        prioritized: 0,
        waitingChildren: 0,
        paused: 0,
        failed: 0,
        completed: 0,
        sampledAt: '2026-07-28T06:00:00.000Z',
      },
    });
    for (const queue of [textQueue, imageQueue]) {
      expect(queue.getJobCounts).toHaveBeenCalledWith(
        'waiting',
        'active',
        'delayed',
        'prioritized',
        'waiting-children',
        'paused',
        'failed',
        'completed',
      );
    }
    jest.useRealTimers();
  });

  it('does not read global BullMQ counts when global queue visibility is denied', async () => {
    const queues = [
      { getJobCounts: jest.fn() },
      { getJobCounts: jest.fn() },
    ];
    const service = new KnowledgeDiagnosticsService(
      {} as never,
      queues[0] as never,
      queues[1] as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      (
        service as unknown as {
          findQueueSnapshotsIfAllowed(canView: boolean): Promise<unknown>;
        }
      ).findQueueSnapshotsIfAllowed(false),
    ).resolves.toBeUndefined();
    queues.forEach((queue) =>
      expect(queue.getJobCounts).not.toHaveBeenCalled(),
    );
  });

  it('does not expose a previous attempt error while a job is waiting to retry', async () => {
    const service = new KnowledgeDiagnosticsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const job = {
      id: 'image-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
      },
      timestamp: 1_000,
      failedReason: 'Error: Page has retryable image extraction failures.',
      getState: jest.fn().mockResolvedValue('delayed'),
    };

    await expect(
      (
        service as unknown as {
          toDiagnosticsJob(job: unknown): Promise<KnowledgeDiagnosticsJob>;
        }
      ).toDiagnosticsJob(job),
    ).resolves.toMatchObject({
      state: 'delayed',
      failedReason: undefined,
    });
  });
});

describe('KnowledgeDiagnosticsService retry selection', () => {
  it('returns only failed attempts within the exact workspace and selected page scope', async () => {
    const query = {
      select: jest.fn(),
      where: jest.fn(),
      execute: jest
        .fn()
        .mockResolvedValue([
          { sourcePageId: 'page-2' },
          { sourcePageId: 'page-2' },
        ]),
    };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const db = { selectFrom: jest.fn().mockReturnValue(query) };
    const service = new KnowledgeDiagnosticsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.findRetryableFailedPageIds({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-2', 'page-1', 'page-2'],
      }),
    ).resolves.toEqual(['page-2']);

    expect(db.selectFrom).toHaveBeenCalledWith('knowledgeCompilationAttempts');
    expect(query.where).toHaveBeenNthCalledWith(
      1,
      'workspaceId',
      '=',
      'workspace-1',
    );
    expect(query.where).toHaveBeenNthCalledWith(2, 'sourcePageId', 'in', [
      'page-2',
      'page-1',
    ]);
    expect(query.where).toHaveBeenNthCalledWith(3, 'status', '=', 'failed');
  });
});

describe('KnowledgeDiagnosticsService authorized Space scope', () => {
  it('selects one latest Run per Space before applying the response limit', async () => {
    const inner = {
      innerJoin: jest.fn(),
      select: jest.fn(),
      where: jest.fn(),
      distinctOn: jest.fn(),
      orderBy: jest.fn(),
      as: jest.fn().mockReturnValue({ kind: 'latest-per-space' }),
    };
    inner.innerJoin.mockReturnValue(inner);
    inner.select.mockReturnValue(inner);
    inner.where.mockReturnValue(inner);
    inner.distinctOn.mockReturnValue(inner);
    inner.orderBy.mockReturnValue(inner);
    const outer = {
      selectAll: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
    };
    outer.selectAll.mockReturnValue(outer);
    outer.orderBy.mockReturnValue(outer);
    outer.limit.mockReturnValue(outer);
    const db = {
      selectFrom: jest
        .fn()
        .mockReturnValueOnce(inner)
        .mockReturnValueOnce(outer),
    };
    const service = new KnowledgeDiagnosticsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (
      service as unknown as {
        findLatestDurableRuns(input: {
          workspaceId: string;
          spaceIds: string[];
          enforceSpaceScope: boolean;
          limit: number;
        }): Promise<unknown[]>;
      }
    ).findLatestDurableRuns({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1', 'space-2'],
      enforceSpaceScope: true,
      limit: 2,
    });

    expect(inner.distinctOn).toHaveBeenCalledWith('run.spaceId');
    expect(inner.orderBy).toHaveBeenNthCalledWith(1, 'run.spaceId', 'asc');
    expect(inner.orderBy).toHaveBeenNthCalledWith(2, 'run.createdAt', 'desc');
    expect(outer.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(outer.limit).toHaveBeenCalledWith(2);
  });

  it('rejects an oversized scope before building a database query', async () => {
    const db = { selectFrom: jest.fn() };
    const service = new KnowledgeDiagnosticsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.findWorkspaceSpaceIds({
        workspaceId: 'workspace-1',
        requestedSpaceIds: Array.from(
          { length: 101 },
          (_, index) => `space-${index}`,
        ),
      }),
    ).rejects.toThrow('At most 100 Spaces');
    expect(db.selectFrom).not.toHaveBeenCalled();
  });

  it('resolves requested Space IDs only inside the current workspace', async () => {
    const query = {
      select: jest.fn(),
      where: jest.fn(),
      execute: jest.fn().mockResolvedValue([{ id: 'space-1' }]),
    };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const db = { selectFrom: jest.fn().mockReturnValue(query) };
    const service = new KnowledgeDiagnosticsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.findWorkspaceSpaceIds({
        workspaceId: 'workspace-1',
        requestedSpaceIds: ['space-1', 'space-2', 'space-1'],
      }),
    ).resolves.toEqual(['space-1']);
    expect(query.where).toHaveBeenNthCalledWith(
      1,
      'workspaceId',
      '=',
      'workspace-1',
    );
    expect(query.where).toHaveBeenNthCalledWith(2, 'deletedAt', 'is', null);
    expect(query.where).toHaveBeenNthCalledWith(3, 'id', 'in', [
      'space-1',
      'space-2',
    ]);
  });

  it('returns no pages without querying the database when the authorized scope is empty', async () => {
    const db = { selectFrom: jest.fn() };
    const service = new KnowledgeDiagnosticsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      (
        service as unknown as {
          findRecentPages(input: {
            workspaceId: string;
            spaceIds: string[];
            enforceSpaceScope: boolean;
            statuses: string[];
            stages: string[];
            limit: number;
          }): Promise<unknown[]>;
        }
      ).findRecentPages({
        workspaceId: 'workspace-1',
        spaceIds: [],
        enforceSpaceScope: true,
        statuses: [],
        stages: [],
        limit: 50,
      }),
    ).resolves.toEqual([]);
    expect(db.selectFrom).not.toHaveBeenCalled();
  });
});

describe('buildCompileRunProgress', () => {
  it('keeps durable text, image, and merge progress after BullMQ jobs are removed', () => {
    const [progress] = buildCompileRunProgress(
      [
        {
          id: 'run-1',
          spaceId: 'space-1',
          spaceName: 'AIM',
          status: 'compiling',
          mode: 'incremental',
          phase: 'images',
          knowledgeGeneration: 4,
          expectedPageCount: 3,
          createdAt: new Date('2026-07-28T06:00:00.000Z'),
          updatedAt: new Date('2026-07-28T06:01:00.000Z'),
          finishedAt: null,
        },
      ],
      [
        runPage({
          status: 'succeeded',
          expectedImageCount: 2,
          succeededImageCount: 2,
          imageStatus: 'succeeded',
          mergeStatus: 'succeeded',
        }),
        runPage({
          sourcePageId: 'page-2',
          status: 'skipped',
          expectedImageCount: 3,
          succeededImageCount: 1,
          failedImageCount: 1,
          skippedImageCount: 1,
          imageStatus: 'partial',
          mergeStatus: 'pending',
        }),
        runPage({
          sourcePageId: 'page-3',
          status: 'failed',
          imageStatus: 'not_required',
          mergeStatus: 'not_required',
          errorCode: 'provider_error',
          errorMessage: 'secret provider response and source content',
          updatedAt: new Date('2026-07-28T06:02:00.000Z'),
        }),
      ],
    );

    expect(progress).toEqual({
      runId: 'run-1',
      spaceId: 'space-1',
      spaceName: 'AIM',
      status: 'compiling',
      mode: 'update',
      phase: 'images',
      generation: 4,
      createdAt: '2026-07-28T06:00:00.000Z',
      updatedAt: '2026-07-28T06:01:00.000Z',
      progress: {
        text: {
          expected: 3,
          succeeded: 1,
          failed: 1,
          skipped: 1,
          pending: 0,
          waiting: 0,
          lastAttemptError: 'Knowledge compiler provider request failed.',
        },
        image: {
          expected: 5,
          succeeded: 3,
          failed: 1,
          skipped: 1,
          pending: 0,
          waiting: 0,
          lastAttemptError: 'Image processing completed with failures.',
        },
        merge: {
          expected: 2,
          succeeded: 1,
          failed: 0,
          skipped: 0,
          pending: 1,
          waiting: 1,
        },
      },
    });
    expect(JSON.stringify(progress)).not.toContain('secret provider response');
  });

  it('separates unfinished work from work that has not been dispatched', () => {
    const [progress] = buildCompileRunProgress(
      [
        {
          id: 'run-2',
          spaceId: 'space-2',
          spaceName: 'Ops',
          status: 'queued',
          mode: 'force_rebuild',
          phase: 'text',
          knowledgeGeneration: 9,
          expectedPageCount: 3,
          createdAt: new Date('2026-07-28T06:00:00.000Z'),
          updatedAt: new Date('2026-07-28T06:00:00.000Z'),
          finishedAt: null,
        },
      ],
      [
        runPage({ runId: 'run-2', status: 'pending' }),
        runPage({
          runId: 'run-2',
          sourcePageId: 'page-2',
          status: 'queued',
        }),
        runPage({
          runId: 'run-2',
          sourcePageId: 'page-3',
          status: 'running',
        }),
      ],
    );

    expect(progress.progress.text).toEqual({
      expected: 3,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      pending: 3,
      waiting: 1,
    });
    expect(progress.mode).toBe('force');
  });
});

describe('buildCompileStatusesFromJobs', () => {
  it('summarizes the latest compile job per space without exposing private failure text', () => {
    const statuses = buildCompileStatusesFromJobs([
      diagnosticsJob({
        id: 'job-success',
        spaceId: 'space-1',
        state: 'completed',
        finishedOn: 1_000,
        returnValue: {
          type: 'compile-space',
          status: 'succeeded',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          compilerRunId: 'run-older',
          sourceCount: 3,
          importedArtifactCount: 2,
          quarantinedArtifactCount: 1,
          durationMs: 450,
        },
      }),
      diagnosticsJob({
        id: 'job-failed',
        spaceId: 'space-1',
        state: 'failed',
        finishedOn: 2_000,
        failedReason:
          'Error: compiler failed while reading private page text Kafka backs async events.',
      }),
      diagnosticsJob({
        id: 'job-active',
        spaceId: 'space-2',
        state: 'active',
        processedOn: 3_000,
      }),
    ]);

    expect(statuses).toEqual([
      {
        spaceId: 'space-2',
        status: 'running',
        jobId: 'job-active',
        lastRunId: 'job-active',
        durationMs: null,
        sourceCount: 0,
        importedArtifactCount: 0,
        quarantinedArtifactCount: 0,
        failureReason: undefined,
        updatedAt: 3_000,
      },
      {
        spaceId: 'space-1',
        status: 'failed',
        jobId: 'job-failed',
        lastRunId: 'job-failed',
        durationMs: null,
        sourceCount: 0,
        importedArtifactCount: 0,
        quarantinedArtifactCount: 0,
        failureReason: 'Compile job failed: Error',
        updatedAt: 2_000,
      },
    ]);
    expect(JSON.stringify(statuses)).not.toContain('Kafka backs async events');
  });
});

describe('buildCompileStatusesFromRuns', () => {
  it('selects the newest created Run even when an older Run was updated later', () => {
    const base = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      status: 'succeeded',
      expectedPageCount: 1,
      succeededPageCount: 1,
      failedPageCount: 0,
      skippedPageCount: 0,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      aggregateJobId: null,
      errorCode: null,
      queuedAt: new Date('2026-07-28T01:00:00.000Z'),
      startedAt: new Date('2026-07-28T01:00:00.000Z'),
      finishedAt: new Date('2026-07-28T01:01:00.000Z'),
    };
    expect(
      buildCompileStatusesFromRuns([
        {
          ...base,
          id: 'run-new',
          createdAt: new Date('2026-07-28T02:00:00.000Z'),
          updatedAt: new Date('2026-07-28T02:01:00.000Z'),
        },
        {
          ...base,
          id: 'run-old-touched-later',
          createdAt: new Date('2026-07-28T01:00:00.000Z'),
          updatedAt: new Date('2026-07-28T03:00:00.000Z'),
        },
      ]),
    ).toEqual([expect.objectContaining({ lastRunId: 'run-new' })]);
  });

  it('keeps a durable partial Space result after Bull jobs disappear', () => {
    expect(
      buildCompileStatusesFromRuns([
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          status: 'partial',
          expectedPageCount: 61,
          succeededPageCount: 56,
          failedPageCount: 5,
          skippedPageCount: 0,
          importedArtifactCount: 1,
          quarantinedArtifactCount: 0,
          aggregateJobId: 'aggregate-job-1',
          errorCode: null,
          queuedAt: new Date('2026-07-24T01:00:00.000Z'),
          startedAt: new Date('2026-07-24T01:00:01.000Z'),
          finishedAt: new Date('2026-07-24T01:02:00.000Z'),
          updatedAt: new Date('2026-07-24T01:02:00.000Z'),
        },
      ]),
    ).toEqual([
      {
        spaceId: 'space-1',
        status: 'partial',
        jobId: 'aggregate-job-1',
        lastRunId: 'run-1',
        durationMs: 120_000,
        sourceCount: 61,
        succeededPageCount: 56,
        failedPageCount: 5,
        skippedPageCount: 0,
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
        failureReason: undefined,
        updatedAt: new Date('2026-07-24T01:02:00.000Z').getTime(),
      },
    ]);
  });

  it('reports a superseded run as superseded instead of running', () => {
    expect(
      buildCompileStatusesFromRuns([
        {
          id: 'run-old',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          status: 'superseded',
          expectedPageCount: 10,
          succeededPageCount: 2,
          failedPageCount: 0,
          skippedPageCount: 8,
          importedArtifactCount: 0,
          quarantinedArtifactCount: 0,
          aggregateJobId: null,
          errorCode: null,
          queuedAt: new Date('2026-07-24T01:00:00.000Z'),
          startedAt: new Date('2026-07-24T01:00:01.000Z'),
          finishedAt: new Date('2026-07-24T01:00:02.000Z'),
          updatedAt: new Date('2026-07-24T01:00:02.000Z'),
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        spaceId: 'space-1',
        status: 'superseded',
      }),
    ]);
  });
});

describe('buildPageCompilationDiagnostics', () => {
  it('reports failed stage and last-success serving without exposing stored text', () => {
    expect(
      buildPageCompilationDiagnostics({
        status: 'failed',
        stage: 'generation',
        attemptCount: 3,
        errorCode: 'invalid_output',
        errorMessage: 'private page text must never be returned',
        lastSuccessfulSourceVersion: 'v1',
        lastSucceededAt: new Date('2026-07-20T10:00:00.000Z'),
      }),
    ).toEqual({
      compileStatus: 'failed',
      compileStage: 'generation',
      compileAttemptCount: 3,
      compileErrorCode: 'invalid_output',
      compileErrorMessage: 'Knowledge compiler returned invalid output.',
      lastSucceededAt: new Date('2026-07-20T10:00:00.000Z'),
      servingLastSuccessfulVersion: true,
    });
  });

  it('reports pages without an attempt as not started', () => {
    expect(buildPageCompilationDiagnostics(undefined)).toEqual({
      compileStatus: 'not_started',
      compileStage: null,
      compileAttemptCount: 0,
      compileErrorCode: null,
      compileErrorMessage: null,
      lastSucceededAt: null,
      servingLastSuccessfulVersion: false,
    });
  });

  it('recognizes an active legacy artifact as the last successful version', () => {
    const legacyInput = {
      status: 'failed',
      stage: 'generation',
      attemptCount: 1,
      errorCode: 'invalid_output',
      lastSuccessfulSourceVersion: null,
      lastSucceededAt: null,
      hasActiveArtifact: true,
    };
    expect(
      buildPageCompilationDiagnostics(legacyInput).servingLastSuccessfulVersion,
    ).toBe(true);
  });

  it('reports intentionally skipped pages without treating them as failed', () => {
    expect(
      buildPageCompilationDiagnostics({
        status: 'skipped',
        stage: 'completed',
        attemptCount: 1,
        errorCode: 'empty_source',
        lastSuccessfulSourceVersion: 'v1',
        lastSucceededAt: new Date('2026-07-20T10:00:00.000Z'),
      }),
    ).toEqual({
      compileStatus: 'skipped',
      compileStage: 'completed',
      compileAttemptCount: 1,
      compileErrorCode: 'empty_source',
      compileErrorMessage: 'Knowledge source is empty.',
      lastSucceededAt: new Date('2026-07-20T10:00:00.000Z'),
      servingLastSuccessfulVersion: false,
    });
  });
});

function diagnosticsJob(
  overrides: Partial<KnowledgeDiagnosticsJob>,
): KnowledgeDiagnosticsJob {
  return {
    id: 'job-1',
    name: QueueJob.KNOWLEDGE_COMPILE_SPACE,
    state: 'waiting',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    pageIds: [],
    timestamp: 0,
    ...overrides,
  };
}

function runPage(
  overrides: Partial<{
    runId: string;
    sourcePageId: string;
    status: string;
    expectedImageCount: number;
    succeededImageCount: number;
    failedImageCount: number;
    skippedImageCount: number;
    imageStatus: string;
    mergeStatus: string;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: Date;
  }> = {},
) {
  return {
    runId: 'run-1',
    sourcePageId: 'page-1',
    status: 'succeeded',
    expectedImageCount: 0,
    succeededImageCount: 0,
    failedImageCount: 0,
    skippedImageCount: 0,
    imageStatus: 'not_required',
    mergeStatus: 'not_required',
    errorCode: null,
    errorMessage: null,
    updatedAt: new Date('2026-07-28T06:00:00.000Z'),
    ...overrides,
  };
}
