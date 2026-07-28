import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueName } from '../../../integrations/queue/constants';
import { KnowledgeTextJobHandler } from '../services/knowledge-text-job.handler';

@Processor(QueueName.KNOWLEDGE_TEXT_QUEUE, { concurrency: 2 })
export class KnowledgeTextProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeTextProcessor.name);

  constructor(private readonly handler: KnowledgeTextJobHandler) {
    super();
  }

  async process(job: Job) {
    return this.handler.handle(job);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  async onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );
    await this.handler.onFailed(job);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Completed ${job.name} job`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}
