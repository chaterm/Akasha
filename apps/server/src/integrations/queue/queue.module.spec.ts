import 'reflect-metadata';
import { getQueueOptionsToken } from '@nestjs/bullmq';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { QueueJob, QueueName } from './constants';
import {
  IMAGE_QUEUE_DEFAULT_JOB_OPTIONS,
  QueueModule,
  SPACE_QUEUE_DEFAULT_JOB_OPTIONS,
} from './queue.module';

describe('QueueModule knowledge queues', () => {
  it('registers the shared space queue with bounded retries and retention', () => {
    expect(queueOptions(QueueName.KNOWLEDGE_SPACE_QUEUE)).toEqual(
      expect.objectContaining({
        name: QueueName.KNOWLEDGE_SPACE_QUEUE,
        defaultJobOptions: SPACE_QUEUE_DEFAULT_JOB_OPTIONS,
      }),
    );
    expect(SPACE_QUEUE_DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 31_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 1_000 },
    });
  });

  it('retains completed and failed image jobs beyond the reaper window', () => {
    expect(queueOptions(QueueName.KNOWLEDGE_IMAGE_QUEUE)).toEqual(
      expect.objectContaining({
        defaultJobOptions: IMAGE_QUEUE_DEFAULT_JOB_OPTIONS,
      }),
    );
    expect(IMAGE_QUEUE_DEFAULT_JOB_OPTIONS).toEqual({
      removeOnComplete: { age: 3_600, count: 100_000 },
      removeOnFail: { age: 86_400, count: 10_000 },
      attempts: 1,
    });
    expect(IMAGE_QUEUE_DEFAULT_JOB_OPTIONS.removeOnComplete).not.toBe(true);
    expect(IMAGE_QUEUE_DEFAULT_JOB_OPTIONS.removeOnFail).not.toBe(true);
  });

  it('defines only fixed shared queue protocol names for new compilation jobs', () => {
    expect(QueueName.KNOWLEDGE_SPACE_QUEUE).toBe('{knowledge-space-queue}');
    expect(QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT).toBe(
      'knowledge-compile-space-text',
    );
    expect(QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES).toBe(
      'knowledge-merge-space-images',
    );
    expect(QueueJob.KNOWLEDGE_COMPILE_IMAGE).toBe('knowledge-compile-image');
  });
});

function queueOptions(name: QueueName): Record<string, unknown> | undefined {
  const imports =
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, QueueModule) ?? [];
  const token = getQueueOptionsToken(name);
  for (const dynamicModule of imports) {
    const provider = dynamicModule?.providers?.find(
      (item: { provide?: unknown }) => item.provide === token,
    );
    if (provider?.useFactory) {
      return provider.useFactory({ getDependencyRef: () => ({}) });
    }
  }
  return undefined;
}
