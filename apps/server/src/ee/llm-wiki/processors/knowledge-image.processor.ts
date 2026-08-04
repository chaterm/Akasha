import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IKnowledgeCompileImageJob } from '../../../integrations/queue/constants/queue.interface';
import { KnowledgeImageEnrichmentService } from '../services/knowledge-image-enrichment.service';
import { KnowledgeSpaceCompilationService } from '../services/knowledge-space-compilation.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { createBoundedAbortSignal } from '../services/knowledge-operation-budget';
import { KNOWLEDGE_IMAGE_WORKER_OPTIONS } from '../services/knowledge-worker-settings';
import { recordKnowledgeWorkerEvent } from '../services/knowledge-worker-observability';

@Processor(QueueName.KNOWLEDGE_IMAGE_QUEUE, KNOWLEDGE_IMAGE_WORKER_OPTIONS)
export class KnowledgeImageProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeImageProcessor.name);

  constructor(
    private readonly imageEnrichment: KnowledgeImageEnrichmentService,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly environmentService: EnvironmentService = undefined as never,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === QueueJob.KNOWLEDGE_COMPILE_IMAGE) {
      return this.processRunImage(job);
    }
    throw new UnrecoverableError(
      `Unsupported Knowledge Image job ${job.name}.`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job): Promise<void> {
    if (job.name === QueueJob.KNOWLEDGE_COMPILE_IMAGE) {
      if (!isExhaustedFailedEvent(job)) return;
      const data = job.data as IKnowledgeCompileImageJob;
      await this.spaceCompilation.completeRunImage({
        runImageId: data.runImageId,
        runId: data.spaceRunId,
        knowledgeGeneration: data.knowledgeGeneration,
        jobId: String(job.id),
        status: 'failed',
        failureClass: 'retryable_exhausted',
        errorCode: 'image_job_attempts_exhausted',
        errorMessage: 'Image job retries were exhausted.',
      });
      return;
    }
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    recordKnowledgeWorkerEvent('stalled');
    this.logger.warn({ event: 'knowledge_image_job_stalled', jobId });
  }

  @OnWorkerEvent('lockRenewalFailed')
  onLockRenewalFailed(jobIds: string[]): void {
    recordKnowledgeWorkerEvent('lock_renewal_failed', jobIds.length || 1);
    this.logger.error({
      event: 'knowledge_image_lock_renewal_failed',
      jobIds,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }

  private async processRunImage(job: Job) {
    const data = job.data as IKnowledgeCompileImageJob;
    const deadline = createBoundedAbortSignal(
      undefined,
      this.environmentService?.getKnowledgeImageJobDeadlineMs?.() ?? 180_000,
    );
    try {
      const image = await this.spaceCompilation.claimRunImage({
        runImageId: data.runImageId,
        runId: data.spaceRunId,
        knowledgeGeneration: data.knowledgeGeneration,
        jobId: String(job.id),
        processingExpiresAt: new Date(Date.now() + 210_000),
      });
      if (!image) return imageJobResult('noop');
      deadline.signal.throwIfAborted();
      const result = await this.imageEnrichment.enrichSingleImage(
        {
          workspaceId: image.workspaceId,
          spaceId: image.spaceId,
          sourcePageId: image.sourcePageId,
          image: {
            attachmentId: image.attachmentId,
            fileName: image.fileName,
            mimeType: image.mimeType as never,
            fileSize: image.fileSize === null ? null : Number(image.fileSize),
            attachmentVersion: image.expectedAttachmentVersion.toISOString(),
            ...(image.altText ? { altText: image.altText } : {}),
          },
        },
        deadline.signal,
      );
      deadline.signal.throwIfAborted();
      if (
        result.status === 'failed' &&
        result.retryable &&
        !isFinalAttempt(job)
      ) {
        throw new Error('Image extraction requires a bounded retry.');
      }
      const completed = await this.spaceCompilation.completeRunImage({
        runImageId: data.runImageId,
        runId: data.spaceRunId,
        knowledgeGeneration: data.knowledgeGeneration,
        jobId: String(job.id),
        status: result.status,
        extractionId: result.extractionId,
        ...(result.status === 'failed'
          ? {
              failureClass: result.retryable
                ? ('retryable_exhausted' as const)
                : ('permanent' as const),
            }
          : {}),
        errorCode: result.errorCode,
        errorMessage: result.errorCode
          ? 'The image could not be compiled.'
          : undefined,
      });
      return imageJobResult(completed ? result.status : 'noop');
    } finally {
      deadline.dispose();
    }
  }
}

function isFinalAttempt(job: Job): boolean {
  const attempts = Math.max(1, Number(job.opts.attempts ?? 1));
  return job.attemptsMade + 1 >= attempts;
}

function isExhaustedFailedEvent(job: Job): boolean {
  const attempts = Math.max(1, Number(job.opts.attempts ?? 1));
  return Number(job.attemptsMade ?? 0) >= attempts;
}

function imageJobResult(
  status: 'noop' | 'succeeded' | 'partial' | 'failed' | 'skipped',
  result?: Record<string, unknown>,
) {
  return { type: 'compile-page-images', status, ...(result ?? {}) };
}
