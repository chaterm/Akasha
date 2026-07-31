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
    QueueJob.KNOWLEDGE_COMPILE_SPACE,
    QueueJob.KNOWLEDGE_COMPILE_PAGES,
    QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES,
    QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
  ])('rejects removed legacy compile job %s', async (name) => {
    const handler = { handle: jest.fn(), onFailed: jest.fn() };
    const processor = new KnowledgeTextProcessor(handler as never);

    await expect(processor.process({ name } as never)).rejects.toThrow(
      'Unsupported Knowledge Text job',
    );
    expect(handler.handle).not.toHaveBeenCalled();
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
      name: QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      failedReason: 'worker stalled',
    } as Job;

    await processor.onError(job);

    expect(handler.onFailed).toHaveBeenCalledWith(job);
  });
});
