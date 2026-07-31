import { randomUUID } from 'node:crypto';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { KnowledgeSpaceExecutionRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IKnowledgeSpaceSliceJob } from '../../../integrations/queue/constants/queue.interface';
import { KnowledgeSpaceRunnerService } from '../services/knowledge-space-runner.service';
import {
  KNOWLEDGE_SPACE_WORKER_OPTIONS,
  KNOWLEDGE_WORKER_SETTINGS,
} from '../services/knowledge-worker-settings';

@Processor(QueueName.KNOWLEDGE_SPACE_QUEUE, KNOWLEDGE_SPACE_WORKER_OPTIONS)
export class KnowledgeSpaceProcessor
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(KnowledgeSpaceProcessor.name);
  private readonly workerId = `knowledge-space-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly runner: KnowledgeSpaceRunnerService,
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
  ) {
    super();
  }

  async process(job: Job) {
    if (
      ![
        QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT,
        QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES,
      ].includes(job.name as QueueJob)
    ) {
      throw new Error(`Unsupported Knowledge Space job ${job.name}.`);
    }
    const data = job.data as IKnowledgeSpaceSliceJob;
    const runSlice =
      job.name === QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES
        ? this.runner.runImageMergeSlice.bind(this.runner)
        : this.runner.runTextSlice.bind(this.runner);
    return runSlice(
      {
        ...data,
        spaceJobId: String(job.id),
      },
      {
        workerId: this.workerId,
        finalAttempt: isCurrentExecutionFinalAttempt(job),
      },
    );
  }

  @OnWorkerEvent('active')
  onActive(job: Job): void {
    this.logger.debug({
      event: 'knowledge_space_job_active',
      ...jobIdentity(job),
      workerId: this.workerId,
    });
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn({
      event: 'knowledge_space_job_stalled',
      jobId,
      workerId: this.workerId,
    });
  }

  @OnWorkerEvent('lockRenewalFailed')
  onLockRenewalFailed(jobIds: string[]): void {
    this.logger.error({
      event: 'knowledge_space_lock_renewal_failed',
      jobIds,
      workerId: this.workerId,
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined): Promise<void> {
    if (!job) return;
    this.logger.error({
      event: 'knowledge_space_job_failed',
      ...jobIdentity(job),
      workerId: this.workerId,
      failedReason: job.failedReason,
      finalAttempt: isFinalAttempt(job),
    });
    if (!isFinalAttempt(job)) return;
    const data = job.data as IKnowledgeSpaceSliceJob;
    const recoveryLease = await this.executionRepo.claimRecoveryLease({
      runId: data.spaceRunId,
      knowledgeGeneration: data.knowledgeGeneration,
      jobPhase: data.phase,
      spaceJobSequence: data.spaceJobSequence,
      spaceJobId: String(job.id),
      workerId: `${this.workerId}-recovery`,
      leaseExpiredBefore: new Date(),
      executionLeaseExpiresAt: new Date(
        Date.now() + KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs,
      ),
      allowUnexpired: true,
    });
    if (!recoveryLease) return;
    await this.executionRepo.finishRun(recoveryLease, 'failed', {
      errorCode: 'space_job_failed',
      errorMessage:
        job.failedReason || 'Knowledge Space job retries exhausted.',
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.debug({
      event: 'knowledge_space_job_completed',
      ...jobIdentity(job),
      workerId: this.workerId,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}

function isFinalAttempt(job: Job): boolean {
  const attempts = Math.max(Number(job.opts?.attempts ?? 1), 1);
  return Number(job.attemptsMade ?? 0) >= attempts;
}

function isCurrentExecutionFinalAttempt(job: Job): boolean {
  const attempts = Math.max(Number(job.opts?.attempts ?? 1), 1);
  return Number(job.attemptsMade ?? 0) + 1 >= attempts;
}

function jobIdentity(job: Job) {
  const data = job.data as Partial<IKnowledgeSpaceSliceJob>;
  return {
    jobId: String(job.id),
    jobName: job.name,
    runId: data.spaceRunId,
    phase: data.phase,
    spaceJobSequence: data.spaceJobSequence,
  };
}
