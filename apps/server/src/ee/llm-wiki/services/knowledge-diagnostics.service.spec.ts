import { QueueJob } from '../../../integrations/queue/constants';
import {
  KnowledgeDiagnosticsJob,
  buildCompileStatusesFromJobs,
} from './knowledge-diagnostics.service';

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
