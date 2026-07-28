import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job } from 'bullmq';
import { QueueName } from '../../../integrations/queue/constants';
import { KnowledgeTextJobHandler } from '../services/knowledge-text-job.handler';
import { KnowledgeTextProcessor } from './knowledge-text.processor';

describe('KnowledgeTextProcessor', () => {
  it('runs the dedicated knowledge text queue with concurrency 2', () => {
    expect(
      Reflect.getMetadata(PROCESSOR_METADATA, KnowledgeTextProcessor),
    ).toEqual({ name: QueueName.KNOWLEDGE_TEXT_QUEUE });
    expect(
      Reflect.getMetadata(WORKER_METADATA, KnowledgeTextProcessor),
    ).toEqual(expect.objectContaining({ concurrency: 2 }));
  });

  it('delegates a knowledge job to the shared handler', async () => {
    const handler = { handle: jest.fn().mockResolvedValue({ status: 'ok' }) };
    const processor = new KnowledgeTextProcessor(
      handler as unknown as KnowledgeTextJobHandler,
    );
    const job = { name: 'knowledge-compile-pages' } as Job;

    await expect(processor.process(job)).resolves.toEqual({ status: 'ok' });
    expect(handler.handle).toHaveBeenCalledWith(job);
  });

  it('delegates terminal worker failures so durable merge state cannot stall', async () => {
    const handler = {
      handle: jest.fn(),
      onFailed: jest.fn().mockResolvedValue(undefined),
    };
    const processor = new KnowledgeTextProcessor(
      handler as unknown as KnowledgeTextJobHandler,
    );
    const job = {
      name: 'knowledge-merge-page-images',
      failedReason: 'worker stalled',
    } as Job;

    await processor.onError(job);

    expect(handler.onFailed).toHaveBeenCalledWith(job);
  });
});
