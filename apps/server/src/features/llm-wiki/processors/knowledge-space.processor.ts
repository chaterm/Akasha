import { randomUUID } from 'node:crypto';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { KnowledgeSpaceExecutionRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { IKnowledgeSpaceJob } from '../../../integrations/queue/constants/queue.interface';
import { KnowledgeSpaceRunnerService } from '../services/knowledge-space-runner.service';
import {
  KNOWLEDGE_SPACE_WORKER_OPTIONS,
  KNOWLEDGE_WORKER_SETTINGS,
} from '../services/knowledge-worker-settings';
import { recordKnowledgeWorkerEvent } from '../services/knowledge-worker-observability';
import {
  isDeterministicJobFailure,
  toUnrecoverableJobError,
} from '../services/knowledge-job-retry-policy';

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
        QueueJob.KNOWLEDGE_FINALIZE_SPACE,
      ].includes(job.name as QueueJob)
    ) {
      throw new UnrecoverableError(
        `Unsupported Knowledge Space job ${job.name}.`,
      );
    }
    const data = job.data as IKnowledgeSpaceJob;
    const finalize = job.name === QueueJob.KNOWLEDGE_FINALIZE_SPACE;
    if (data.phase !== (finalize ? 'finalize' : 'text'))
      throw new UnrecoverableError(
        'Knowledge Space job phase does not match its name.',
      );
    const run = finalize
      ? this.runner.runFinalizeLease.bind(this.runner)
      : this.runner.runTextLease.bind(this.runner);
    try {
      return await run(
        {
          ...data,
          spaceJobId: String(job.id),
        },
        { workerId: this.workerId },
      );
    } catch (error) {
      // Deterministic failures (constraint violations, programming errors,
      // explicitly non-retryable errors) fail on the first attempt; anything
      // else may be a transient DB/Redis fault and keeps the retry budget.
      if (isDeterministicJobFailure(error))
        throw toUnrecoverableJobError(error);
      throw error;
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job): void {
    this.logger.debug({
      event: 'knowledge_space_job_active',
      ...jobIdentity(job),
      workerId: this.workerId,
      queueWaitMs: job.processedOn
        ? Math.max(0, job.processedOn - job.timestamp)
        : null,
    });
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    recordKnowledgeWorkerEvent('stalled');
    this.logger.warn({
      event: 'knowledge_space_job_stalled',
      jobId,
      workerId: this.workerId,
    });
  }

  @OnWorkerEvent('lockRenewalFailed')
  onLockRenewalFailed(jobIds: string[]): void {
    recordKnowledgeWorkerEvent('lock_renewal_failed', jobIds.length || 1);
    this.logger.error({
      event: 'knowledge_space_lock_renewal_failed',
      jobIds,
      workerId: this.workerId,
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined): Promise<void> {
    if (!job) return;
    const finalAttempt = await isTerminalFailure(job);
    this.logger.error({
      event: 'knowledge_space_job_failed',
      ...jobIdentity(job),
      workerId: this.workerId,
      failedReason: job.failedReason,
      finalAttempt,
    });
    if (!finalAttempt) return;
    const data = job.data as IKnowledgeSpaceJob;
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
      recoveryKind: 'final_failed',
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
      durationMs:
        job.finishedOn && job.processedOn
          ? Math.max(0, job.finishedOn - job.processedOn)
          : null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}

async function isTerminalFailure(job: Job): Promise<boolean> {
  const attempts = Math.max(Number(job.opts?.attempts ?? 1), 1);
  if (Number(job.attemptsMade ?? 0) >= attempts) return true;
  // UnrecoverableError skips the remaining attempts budget, so the queue state
  // is the only authoritative signal that no retry was scheduled.
  return job.isFailed();
}

function jobIdentity(job: Job) {
  const data = job.data as Partial<IKnowledgeSpaceJob>;
  return {
    jobId: String(job.id),
    jobName: job.name,
    jobKind:
      job.name === QueueJob.KNOWLEDGE_FINALIZE_SPACE ? 'finalize' : 'text',
    runId: data.spaceRunId,
    phase: data.phase,
    spaceJobSequence: data.spaceJobSequence,
  };
}
