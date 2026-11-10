import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { KnowledgeSpaceExecutionRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { KnowledgePageCompilationService } from '../services/knowledge-page-compilation.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { KnowledgePageMergeProcessor } from './knowledge-page-merge.processor';

describe('KnowledgePageMergeProcessor', () => {
  it('runs on the dedicated merge queue with the shared space concurrency', () => {
    expect(
      Reflect.getMetadata(PROCESSOR_METADATA, KnowledgePageMergeProcessor),
    ).toEqual({ name: QueueName.KNOWLEDGE_MERGE_QUEUE });
    expect(
      Reflect.getMetadata(WORKER_METADATA, KnowledgePageMergeProcessor),
    ).toEqual(expect.objectContaining({ concurrency: 10 }));
  });

  it('claims one page, merges it, and reports success', async () => {
    const fixture = createFixture();
    fixture.executionRepo.claimPageMerge.mockResolvedValue(claimedPage());
    fixture.pageCompilation.mergePageImages.mockResolvedValue({
      outcome: 'succeeded',
      result: {},
    });

    await expect(fixture.processor.process(mergeJob())).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(fixture.pageCompilation.mergePageImages).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: 'knowledge-page-merge__run-1__page-1__4',
        data: expect.objectContaining({
          sourcePageId: 'src-1',
          expectedExtractionIds: ['ext-1'],
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it('no-ops when the page can no longer be claimed', async () => {
    const fixture = createFixture();
    fixture.executionRepo.claimPageMerge.mockResolvedValue(undefined);

    await expect(fixture.processor.process(mergeJob())).resolves.toEqual(
      expect.objectContaining({ status: 'noop' }),
    );
    expect(fixture.pageCompilation.mergePageImages).not.toHaveBeenCalled();
  });

  it('re-throws a retryable failure so BullMQ re-dispatches the same job', async () => {
    const fixture = createFixture();
    fixture.executionRepo.claimPageMerge.mockResolvedValue(claimedPage());
    fixture.pageCompilation.mergePageImages.mockResolvedValue({
      outcome: 'failed',
      retryable: true,
      code: 'provider_error',
      message: 'transient provider error',
      cause: new Error('boom'),
    });

    await expect(fixture.processor.process(mergeJob())).rejects.toThrow(
      'transient provider error',
    );
  });

  it('rejects an unsupported job name', async () => {
    const fixture = createFixture();
    await expect(
      fixture.processor.process({
        id: 'x',
        name: QueueJob.KNOWLEDGE_COMPILE_IMAGE,
        data: {},
      } as Job),
    ).rejects.toThrow('Unsupported Knowledge Merge job');
  });

  it('settles an escaped infrastructure failure before BullMQ retries', async () => {
    const fixture = createFixture();
    fixture.executionRepo.claimPageMerge.mockResolvedValue(claimedPage());
    fixture.pageCompilation.mergePageImages.mockRejectedValue(
      new Error('export unavailable'),
    );
    await expect(fixture.processor.process(mergeJob())).rejects.toThrow(
      'export unavailable',
    );
    expect(fixture.executionRepo.finishPageMerge).toHaveBeenCalledWith(
      expect.objectContaining({ mergeExecutionToken: 'token-1' }),
      expect.objectContaining({
        status: 'failed',
        retryable: true,
        errorCode: 'merge_execution_failed',
      }),
    );
  });

  it('does not recover an exhausted job by deterministic identity alone', async () => {
    const fixture = createFixture();
    const job = mergeJob();
    job.attemptsMade = 3;
    await fixture.processor.onFailed(job);
    expect(
      fixture.executionRepo.requeueMissingPageMerge,
    ).not.toHaveBeenCalled();
  });
});

function mergeJob(): Job {
  return {
    id: 'knowledge-page-merge__run-1__page-1__4',
    name: QueueJob.KNOWLEDGE_MERGE_PAGE,
    data: {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      spaceRunId: 'run-1',
      runPageId: 'page-1',
      sourcePageId: 'src-1',
      knowledgeGeneration: 4,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job;
}

function claimedPage() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    runId: 'run-1',
    runPageId: 'page-1',
    sourcePageId: 'src-1',
    knowledgeGeneration: 4,
    mergeJobId: 'knowledge-page-merge__run-1__page-1__4',
    mergeExecutionToken: 'token-1',
    sourceVersion: 'v1',
    sourceContentHash: 'sha:1',
    mergeAttemptCount: 1,
    expectedExtractionIds: ['ext-1'],
    images: [],
  };
}

function createFixture() {
  const executionRepo = {
    claimPageMerge: jest.fn(),
    heartbeatPageMerge: jest.fn().mockResolvedValue(true),
    isPageMergeFenceActive: jest.fn().mockResolvedValue(true),
    isPageMergeFenceActiveForPublication: jest.fn().mockResolvedValue(true),
    completePageMerge: jest.fn().mockResolvedValue(true),
    finishPageMerge: jest.fn().mockResolvedValue({ terminal: true }),
    requeueMissingPageMerge: jest.fn().mockResolvedValue(true),
  };
  const pageCompilation = {
    mergePageImages: jest.fn(),
  };
  const environmentService = {
    getKnowledgePageDeadlineMs: jest.fn().mockReturnValue(180_000),
  };
  const processor = new KnowledgePageMergeProcessor(
    executionRepo as unknown as KnowledgeSpaceExecutionRepo,
    pageCompilation as unknown as KnowledgePageCompilationService,
    environmentService as unknown as EnvironmentService,
  );
  return { processor, executionRepo, pageCompilation, environmentService };
}
