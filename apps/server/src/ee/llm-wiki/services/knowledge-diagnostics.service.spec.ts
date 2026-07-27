import { QueueJob } from '../../../integrations/queue/constants';
import {
  KnowledgeDiagnosticsJob,
  KnowledgeDiagnosticsService,
  buildPageCompilationDiagnostics,
  buildCompileStatusesFromJobs,
  buildCompileStatusesFromRuns,
} from './knowledge-diagnostics.service';

describe('KnowledgeDiagnosticsService queue counts', () => {
  it('returns current BullMQ counts separately from recent job history', async () => {
    const aiQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 3,
        active: 2,
        delayed: 1,
        prioritized: 4,
        'waiting-children': 5,
        paused: 6,
        failed: 7,
        completed: 8,
      }),
    };
    const service = new KnowledgeDiagnosticsService(
      {} as never,
      aiQueue as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      (
        service as unknown as {
          findKnowledgeQueueCounts(): Promise<Record<string, number>>;
        }
      ).findKnowledgeQueueCounts(),
    ).resolves.toEqual({
      waiting: 3,
      active: 2,
      delayed: 1,
      prioritized: 4,
      waitingChildren: 5,
      paused: 6,
      failed: 7,
      completed: 8,
    });
    expect(aiQueue.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'waiting-children',
      'paused',
      'failed',
      'completed',
    );
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
