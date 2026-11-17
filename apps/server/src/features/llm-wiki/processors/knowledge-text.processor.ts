import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { ContextualWorkerHost } from '../../../common/logger/contextual-worker.host';
import { Job, UnrecoverableError } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { KnowledgeTextJobHandler } from '../services/knowledge-text-job.handler';

@Processor(QueueName.KNOWLEDGE_TEXT_QUEUE, { concurrency: 2 })
export class KnowledgeTextProcessor
  extends ContextualWorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeTextProcessor.name);

  constructor(private readonly handler: KnowledgeTextJobHandler) {
    super();
  }

  async handle(job: Job) {
    if (!SUPPORTED_TEXT_JOBS.has(job.name as QueueJob)) {
      throw new UnrecoverableError(
        `Unsupported Knowledge Text job ${job.name}.`,
      );
    }
    return this.handler.handle(job);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      { jobId: job.id, jobName: job.name, reason: job.failedReason },
      'Job failed',
    );
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
  QueueJob.KNOWLEDGE_RETIRE_SOURCES,
]);
