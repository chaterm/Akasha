import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { KNOWLEDGE_SPACE_WORKER_OPTIONS } from '../services/knowledge-worker-settings';
import { KnowledgeSpaceProcessor } from './knowledge-space.processor';

describe('KnowledgeSpaceProcessor', () => {
  it('uses the shared Space queue and complete long-job worker options', () => {
    expect(
      Reflect.getMetadata(PROCESSOR_METADATA, KnowledgeSpaceProcessor),
    ).toEqual({ name: QueueName.KNOWLEDGE_SPACE_QUEUE });
    expect(
      Reflect.getMetadata(WORKER_METADATA, KnowledgeSpaceProcessor),
    ).toEqual(KNOWLEDGE_SPACE_WORKER_OPTIONS);
  });

  it('binds a non-default concurrency at decorator evaluation time', () => {
    const previous = {
      pool: process.env.DATABASE_MAX_POOL,
      space: process.env.KNOWLEDGE_SPACE_CONCURRENCY,
      image: process.env.KNOWLEDGE_IMAGE_CONCURRENCY,
    };
    Object.assign(process.env, {
      DATABASE_MAX_POOL: '22',
      KNOWLEDGE_SPACE_CONCURRENCY: '7',
      KNOWLEDGE_IMAGE_CONCURRENCY: '5',
    });
    try {
      jest.isolateModules(() => {
        const isolated =
          require('./knowledge-space.processor').KnowledgeSpaceProcessor;
        expect(Reflect.getMetadata(WORKER_METADATA, isolated)).toEqual(
          expect.objectContaining({ concurrency: 7 }),
        );
      });
    } finally {
      restoreEnvironment('DATABASE_MAX_POOL', previous.pool);
      restoreEnvironment('KNOWLEDGE_SPACE_CONCURRENCY', previous.space);
      restoreEnvironment('KNOWLEDGE_IMAGE_CONCURRENCY', previous.image);
    }
  });

  it('delegates one physical text slice without enqueuing a continuation', async () => {
    const runner = {
      runTextSlice: jest
        .fn()
        .mockResolvedValue({ outcome: 'yielded', completedPages: 5 }),
    };
    const processor = new KnowledgeSpaceProcessor(
      runner as never,
      createExecutionRepo() as never,
    );
    const job = textJob();

    await expect(processor.process(job)).resolves.toEqual({
      outcome: 'yielded',
      completedPages: 5,
    });
    expect(runner.runTextSlice).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceRunId: 'run-1',
        spaceJobSequence: 2,
        spaceJobId: 'space-job-2',
      }),
      expect.objectContaining({ finalAttempt: false }),
    );
  });

  it('uses an exact recovery lease before terminally failing a run', async () => {
    const recoveryLease = {
      runId: 'run-1',
      knowledgeGeneration: 3,
      jobPhase: 'text',
      spaceJobSequence: 2,
      spaceJobId: 'space-job-2',
      executionToken: 'recovery-token',
    };
    const executionRepo = createExecutionRepo();
    executionRepo.claimRecoveryLease.mockResolvedValue(recoveryLease);
    const processor = new KnowledgeSpaceProcessor(
      { runTextSlice: jest.fn() } as never,
      executionRepo as never,
    );

    await processor.onFailed(
      textJob({ attemptsMade: 3, opts: { attempts: 3 } }),
    );

    expect(executionRepo.claimRecoveryLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        knowledgeGeneration: 3,
        jobPhase: 'text',
        spaceJobSequence: 2,
        spaceJobId: 'space-job-2',
        recoveryKind: 'final_failed',
      }),
    );
    expect(executionRepo.finishRun).toHaveBeenCalledWith(
      recoveryLease,
      'failed',
      expect.objectContaining({ errorCode: 'space_job_failed' }),
    );
  });

  it('delegates image merge slices to the image merge runner', async () => {
    const runner = {
      runTextSlice: jest.fn(),
      runImageMergeSlice: jest
        .fn()
        .mockResolvedValue({ outcome: 'completed', completedPages: 2 }),
    };
    const processor = new KnowledgeSpaceProcessor(
      runner as never,
      createExecutionRepo() as never,
    );
    const job = {
      ...textJob(),
      name: QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES,
      data: {
        ...textJob().data,
        phase: 'image_merge',
      },
    } as Job;

    await expect(processor.process(job)).resolves.toEqual({
      outcome: 'completed',
      completedPages: 2,
    });
    expect(runner.runImageMergeSlice).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'image_merge',
        spaceJobId: 'space-job-2',
      }),
      expect.objectContaining({ finalAttempt: false }),
    );
    expect(runner.runTextSlice).not.toHaveBeenCalled();
  });
});

function createExecutionRepo() {
  return {
    claimRecoveryLease: jest.fn(),
    finishRun: jest.fn().mockResolvedValue({ run: { status: 'failed' } }),
  };
}

function textJob(overrides: Partial<Job> = {}) {
  return {
    id: 'space-job-2',
    name: QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT,
    data: {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      spaceRunId: 'run-1',
      knowledgeGeneration: 3,
      phase: 'text',
      spaceJobSequence: 2,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
