import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job, UnrecoverableError } from 'bullmq';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
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
      DATABASE_MAX_POOL: '30',
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

  it('delegates one physical text lease without enqueuing a continuation', async () => {
    const runner = {
      runTextLease: jest
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
    expect(runner.runTextLease).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceRunId: 'run-1',
        spaceJobSequence: 2,
        spaceJobId: 'space-job-2',
      }),
      expect.objectContaining({ workerId: expect.any(String) }),
    );
    expect(runner.runTextLease.mock.calls[0][1]).not.toHaveProperty(
      'finalAttempt',
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
      { runTextLease: jest.fn() } as never,
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

  it('does not spend the retry budget on deterministic failures', async () => {
    const error = new Error(
      'new row for relation "knowledge_space_compile_run_images" violates check constraint "chk_knowledge_space_compile_run_images_ordinal"',
    );
    const runner = { runTextLease: jest.fn().mockRejectedValue(error) };
    const processor = new KnowledgeSpaceProcessor(
      runner as never,
      createExecutionRepo() as never,
    );

    await expect(processor.process(textJob())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('retries LLM upstream failures', async () => {
    const error = new KnowledgeCompilerLlmError(
      'rate_limited',
      'Compiler upstream is rate limited.',
      true,
    );
    const runner = { runTextLease: jest.fn().mockRejectedValue(error) };
    const processor = new KnowledgeSpaceProcessor(
      runner as never,
      createExecutionRepo() as never,
    );

    await expect(processor.process(textJob())).rejects.toBe(error);
  });

  it('treats a skipped retry budget as terminal', async () => {
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
      { runTextLease: jest.fn() } as never,
      executionRepo as never,
    );
    const job = textJob({ attemptsMade: 1, opts: { attempts: 3 } });
    Object.assign(job, { isFailed: jest.fn().mockResolvedValue(true) });

    await processor.onFailed(job);

    expect(executionRepo.finishRun).toHaveBeenCalledWith(
      recoveryLease,
      'failed',
      expect.objectContaining({ errorCode: 'space_job_failed' }),
    );
  });

  it('dispatches explicit Finalize jobs to the Finalize runner on the same worker', async () => {
    const runner = {
      runTextLease: jest.fn(),
      runFinalizeLease: jest
        .fn()
        .mockResolvedValue({ outcome: 'completed', completedPages: 0 }),
    };
    const processor = new KnowledgeSpaceProcessor(
      runner as never,
      createExecutionRepo() as never,
    );
    const job = textJob();
    job.name = QueueJob.KNOWLEDGE_FINALIZE_SPACE;
    job.data.phase = 'finalize';
    expect(await processor.process(job)).toEqual({
      outcome: 'completed',
      completedPages: 0,
    });
    expect(runner.runTextLease).not.toHaveBeenCalled();
    expect(runner.runFinalizeLease).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'finalize' }),
      expect.any(Object),
    );
  });

  it('rejects the retired space-level image merge job', async () => {
    const runner = { runTextLease: jest.fn() };
    const processor = new KnowledgeSpaceProcessor(
      runner as never,
      createExecutionRepo() as never,
    );
    const job = {
      ...textJob(),
      name: QueueJob.KNOWLEDGE_MERGE_PAGE,
      data: { ...textJob().data, phase: 'image_merge' },
    } as Job;

    await expect(processor.process(job)).rejects.toThrow(
      'Unsupported Knowledge Space job',
    );
    expect(runner.runTextLease).not.toHaveBeenCalled();
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
