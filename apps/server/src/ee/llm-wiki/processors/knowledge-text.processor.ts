import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
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
    if (!SUPPORTED_TEXT_JOBS.has(job.name as QueueJob)) {
      throw new UnrecoverableError(
        `Unsupported Knowledge Text job ${job.name}.`,
      );
    }
    return this.handler.handle(job);
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Completed ${job.name} job`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}

const SUPPORTED_TEXT_JOBS = new Set<QueueJob>([
  QueueJob.PAGE_CONTENT_UPDATED,
  QueueJob.KNOWLEDGE_REINDEX_ACCESS,
  QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
  QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
  QueueJob.REVIEW_DISCOVER,
  QueueJob.REVIEW_NEGOTIATE,
]);
