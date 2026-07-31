import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  IKnowledgeCompileImageJob,
  IKnowledgeCompilePageImagesJob,
} from '../../../integrations/queue/constants/queue.interface';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { KnowledgeImageEnrichmentService } from '../services/knowledge-image-enrichment.service';
import { KnowledgeSourceExporterService } from '../services/knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from '../services/knowledge-space-compilation.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { createBoundedAbortSignal } from '../services/knowledge-operation-budget';
import { KNOWLEDGE_IMAGE_WORKER_OPTIONS } from '../services/knowledge-worker-settings';

@Processor(QueueName.KNOWLEDGE_IMAGE_QUEUE, KNOWLEDGE_IMAGE_WORKER_OPTIONS)
export class KnowledgeImageProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeImageProcessor.name);

  constructor(
    private readonly sourceExporter: KnowledgeSourceExporterService,
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
    if (job.name !== QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES) return;
    const data = job.data as IKnowledgeCompilePageImagesJob;
    const accepted = await this.spaceCompilation.beginPageImages({
      runId: data.spaceRunId,
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageId: data.sourcePageId,
      sourceVersion: data.sourceVersion,
      sourceContentHash: data.sourceContentHash,
      knowledgeGeneration: data.knowledgeGeneration,
      images: data.images,
    });
    if (!accepted) return imageJobResult('noop');

    const sources = await this.sourceExporter.exportPageSources({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageIds: [data.sourcePageId],
    });
    const source = sources[0];
    if (!isSameImageSnapshot(data, source)) {
      await this.settleStaleRunPage(data);
      return imageJobResult('noop');
    }

    const result = await this.imageEnrichment.enrichSource(source);
    const current = await this.spaceCompilation.isPageImageJobCurrent({
      runId: data.spaceRunId,
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageId: data.sourcePageId,
      sourceVersion: data.sourceVersion,
      sourceContentHash: data.sourceContentHash,
      knowledgeGeneration: data.knowledgeGeneration,
      images: data.images,
    });
    if (!current) {
      await this.settleStaleRunPage(data);
      return imageJobResult('noop');
    }

    if (result.retryableFailureCount > 0 && !isFinalAttempt(job)) {
      if (data.spaceRunId) {
        await this.spaceCompilation.recordPageImageAttempt({
          runId: data.spaceRunId,
          sourcePageId: data.sourcePageId,
          sourceVersion: data.sourceVersion,
          sourceContentHash: data.sourceContentHash,
          knowledgeGeneration: data.knowledgeGeneration,
          expected: result.expected,
          succeeded: result.succeeded,
          failed: result.failed,
          skipped: result.skipped,
        });
      }
      throw new Error('Page has retryable image extraction failures.');
    }

    const status =
      result.retryableFailureCount > 0
        ? 'failed'
        : result.failed > 0 || result.skipped > 0
          ? 'partial'
          : 'succeeded';
    if (data.spaceRunId) {
      await this.spaceCompilation.completePageImages({
        runId: data.spaceRunId,
        sourcePageId: data.sourcePageId,
        sourceVersion: data.sourceVersion,
        sourceContentHash: data.sourceContentHash,
        knowledgeGeneration: data.knowledgeGeneration,
        status,
        expected: result.expected,
        succeeded: result.succeeded,
        failed: result.failed,
        skipped: result.skipped,
      });
    } else if (result.succeeded > 0) {
      await this.spaceCompilation.queueStandalonePageMerge(source);
    }
    return imageJobResult(status, result);
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
    if (job.name !== QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES) return;
    const exhausted =
      Number(job.attemptsMade ?? 0) >=
      Math.max(1, Number(job.opts.attempts ?? 1));
    if (!exhausted) {
      this.logger.warn(`Retrying ${job.name} after a retryable image failure.`);
      return;
    }
    this.logger.error(
      `Image job exhausted its bounded retries. Reason: ${job.failedReason}`,
    );
    const data = job.data as IKnowledgeCompilePageImagesJob;
    if (!data.spaceRunId) return;
    await this.spaceCompilation.completePageImages({
      runId: data.spaceRunId,
      sourcePageId: data.sourcePageId,
      sourceVersion: data.sourceVersion,
      sourceContentHash: data.sourceContentHash,
      knowledgeGeneration: data.knowledgeGeneration,
      status: 'failed',
      expected: data.images.length,
      succeeded: 0,
      failed: data.images.length,
      skipped: 0,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }

  private async settleStaleRunPage(
    data: IKnowledgeCompilePageImagesJob,
  ): Promise<void> {
    if (!data.spaceRunId) return;
    await this.spaceCompilation.completePageImages({
      runId: data.spaceRunId,
      sourcePageId: data.sourcePageId,
      sourceVersion: data.sourceVersion,
      sourceContentHash: data.sourceContentHash,
      knowledgeGeneration: data.knowledgeGeneration,
      status: 'partial',
      expected: data.images.length,
      succeeded: 0,
      failed: 0,
      skipped: data.images.length,
    });
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

function isSameImageSnapshot(
  data: IKnowledgeCompilePageImagesJob,
  source?: KnowledgeSourceSnapshot,
): boolean {
  if (
    !source ||
    source.sourcePageId !== data.sourcePageId ||
    source.sourceVersion !== data.sourceVersion ||
    source.contentHash !== data.sourceContentHash
  ) {
    return false;
  }
  const actual = source.images ?? [];
  return (
    actual.length === data.images.length &&
    actual.every(
      (image, index) =>
        image.attachmentId === data.images[index]?.attachmentId &&
        image.attachmentVersion === data.images[index]?.attachmentVersion,
    )
  );
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
