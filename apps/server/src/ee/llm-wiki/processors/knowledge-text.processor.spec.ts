import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
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
    const job = { name: QueueJob.KNOWLEDGE_REINDEX_ACCESS } as Job;

    await expect(processor.process(job)).resolves.toEqual({ status: 'ok' });
    expect(handler.handle).toHaveBeenCalledWith(job);
  });

  it.each([
    'knowledge-compile-space',
    'knowledge-compile-pages',
    'knowledge-merge-page-images',
    'knowledge-aggregate-space',
  ])('rejects removed legacy compile job %s', async (name) => {
    const handler = { handle: jest.fn(), onFailed: jest.fn() };
    const processor = new KnowledgeTextProcessor(handler as never);

    await expect(processor.process({ name } as never)).rejects.toThrow(
      'Unsupported Knowledge Text job',
    );
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('records maintenance worker failures without mutating compile Run state', () => {
    const handler = { handle: jest.fn() };
    const processor = new KnowledgeTextProcessor(
      handler as unknown as KnowledgeTextJobHandler,
    );
    const job = {
      name: QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      failedReason: 'worker stalled',
    } as Job;

    expect(() => processor.onError(job)).not.toThrow();

    expect(handler.handle).not.toHaveBeenCalled();
  });
});
