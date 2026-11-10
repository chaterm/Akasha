import { randomUUID } from 'node:crypto';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import {
  KnowledgeSpaceExecutionRepo,
  PageMergeExecutionFence,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IKnowledgeMergePageJob } from '../../../integrations/queue/constants/queue.interface';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { KnowledgePageCompilationService } from '../services/knowledge-page-compilation.service';
import { KnowledgeImageMergePageData } from '../types/knowledge-page-compilation.types';
import { createBoundedAbortSignal } from '../services/knowledge-operation-budget';
import {
  KNOWLEDGE_MERGE_WORKER_OPTIONS,
  KNOWLEDGE_WORKER_SETTINGS,
} from '../services/knowledge-worker-settings';
import { recordKnowledgeWorkerEvent } from '../services/knowledge-worker-observability';

/**
 * Executes an independent Page Merge job. Unlike the retired space merge lease,
 * this worker holds no SpaceExecutionLease: its fence lives on the RunPage row
 * (merge_job_id + merge_execution_token) and is validated on every heartbeat and
 * publication. A retryable failure resets the page to `queued` (keeping the
 * run's single merge slot) and is re-thrown so BullMQ re-dispatches the same job.
 */
@Processor(QueueName.KNOWLEDGE_MERGE_QUEUE, KNOWLEDGE_MERGE_WORKER_OPTIONS)
export class KnowledgePageMergeProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgePageMergeProcessor.name);
  private readonly workerId = `knowledge-merge-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
    private readonly pageCompilation: KnowledgePageCompilationService,
    private readonly environmentService: EnvironmentService,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name !== QueueJob.KNOWLEDGE_MERGE_PAGE) {
      throw new UnrecoverableError(
        `Unsupported Knowledge Merge job ${job.name}.`,
      );
    }
    return this.processPageMerge(job);
  }

  private async processPageMerge(job: Job) {
    const data = job.data as IKnowledgeMergePageJob;
    const leaseTtlMs = KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs;
    const claimed = await this.executionRepo.claimPageMerge({
      runId: data.spaceRunId,
      runPageId: data.runPageId,
      knowledgeGeneration: data.knowledgeGeneration,
      mergeJobId: String(job.id),
      workerId: this.workerId,
      processingExpiresAt: new Date(Date.now() + leaseTtlMs),
    });
    if (!claimed) return mergeJobResult('noop');
    const fence: PageMergeExecutionFence = {
      workspaceId: claimed.workspaceId,
      spaceId: claimed.spaceId,
      runId: claimed.runId,
      runPageId: claimed.runPageId,
      sourcePageId: claimed.sourcePageId,
      knowledgeGeneration: claimed.knowledgeGeneration,
      mergeJobId: claimed.mergeJobId,
      mergeExecutionToken: claimed.mergeExecutionToken,
      sourceVersion: claimed.sourceVersion,
      sourceContentHash: claimed.sourceContentHash,
    };

    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.executionRepo
        .heartbeatPageMerge(fence, {
          processingExpiresAt: new Date(Date.now() + leaseTtlMs),
        })
        .catch(() => undefined)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, KNOWLEDGE_WORKER_SETTINGS.heartbeatMs);
    heartbeat.unref?.();

    const deadline = createBoundedAbortSignal(
      undefined,
      this.environmentService.getKnowledgePageDeadlineMs(),
    );
    try {
      const outcome = await this.pageCompilation.mergePageImages(
        {
          data: {
            workspaceId: fence.workspaceId,
            spaceId: fence.spaceId,
            sourcePageId: fence.sourcePageId,
            sourceVersion: fence.sourceVersion,
            sourceContentHash: fence.sourceContentHash,
            spaceRunId: fence.runId,
            knowledgeGeneration: fence.knowledgeGeneration,
            images: claimed.images as KnowledgeImageMergePageData['images'],
            expectedExtractionIds: claimed.expectedExtractionIds,
          },
          compileTaskId: fence.mergeJobId,
          execution: this.pageMergeExecutionContext(fence),
        },
        deadline.signal,
      );
      // A retryable failure has already reset the page to `queued` (keeping the
      // run's merge slot). Re-throw so BullMQ schedules the delayed retry that
      // re-claims the same deterministic job id.
      if (outcome.outcome === 'failed' && outcome.retryable) {
        throw new Error(outcome.message || 'Page merge requires a retry.');
      }
      return mergeJobResult(
        outcome.outcome === 'failed' ? 'failed' : outcome.outcome,
      );
    } catch (error) {
      // Export/snapshot/infrastructure errors may escape before the page
      // service's own settlement. Fenced settlement is a noop if the page
      // already published or was settled by that service.
      await this.executionRepo.finishPageMerge(fence, {
        status: 'failed',
        retryable: true,
        errorCode: 'merge_execution_failed',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'Page merge execution failed.',
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      deadline.dispose();
    }
  }

  private pageMergeExecutionContext(fence: PageMergeExecutionFence) {
    return {
      isActive: () => this.executionRepo.isPageMergeFenceActive(fence),
      completePage: (outcome: {
        status: 'failed' | 'skipped';
        retryable?: boolean;
        errorCode?: string | null;
        errorMessage?: string | null;
      }) =>
        this.executionRepo.finishPageMerge(fence, {
          status: outcome.status,
          ...(outcome.retryable === undefined
            ? {}
            : { retryable: outcome.retryable }),
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        }),
      catalog: async () => [],
      publicationGuard: (trx: KyselyTransaction) =>
        this.executionRepo.isPageMergeFenceActiveForPublication(fence, trx),
      publicationComplete: (
        trx: KyselyTransaction,
        effectiveKnowledgeHash: string,
      ) =>
        this.executionRepo.completePageMerge(
          fence,
          { effectiveKnowledgeHash },
          trx,
        ),
    };
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined): Promise<void> {
    if (!job || job.name !== QueueJob.KNOWLEDGE_MERGE_PAGE) return;
    if (!isExhaustedFailedEvent(job)) return;
    // Normal attempt failures are settled by the fenced completion callback.
    // A crash before settlement is recovered by the reaper after expiry, using
    // an observed token/expiry CAS. Never mutate by deterministic job ID alone.
    this.logger.error({
      event: 'knowledge_merge_job_failed',
      jobId: String(job.id),
      failedReason: job.failedReason,
    });
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    recordKnowledgeWorkerEvent('stalled');
    this.logger.warn({ event: 'knowledge_merge_job_stalled', jobId });
  }

  @OnWorkerEvent('lockRenewalFailed')
  onLockRenewalFailed(jobIds: string[]): void {
    recordKnowledgeWorkerEvent('lock_renewal_failed', jobIds.length || 1);
    this.logger.error({ event: 'knowledge_merge_lock_renewal_failed', jobIds });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}

function isExhaustedFailedEvent(job: Job): boolean {
  const attempts = Math.max(1, Number(job.opts.attempts ?? 1));
  return Number(job.attemptsMade ?? 0) >= attempts;
}

function mergeJobResult(status: 'noop' | 'succeeded' | 'failed' | 'skipped') {
  return { type: 'merge-page', status };
}
