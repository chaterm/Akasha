import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { KnowledgeSpaceExecutionRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueName } from '../../../integrations/queue/constants';
import { KNOWLEDGE_WORKER_SETTINGS } from './knowledge-worker-settings';

const EXECUTABLE_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

@Injectable()
export class KnowledgeRunReaperService {
  private readonly logger = new Logger(KnowledgeRunReaperService.name);
  private reaping = false;

  constructor(
    @InjectQueue(QueueName.KNOWLEDGE_SPACE_QUEUE)
    private readonly spaceQueue: Queue,
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
  ) {}

  @Interval('knowledge-space-run-reaper', 30_000)
  async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      const now = new Date();
      const candidates = await this.executionRepo.findSpaceRecoveryCandidates({
        leaseExpiredBefore: now,
        queuedDispatchedBefore: new Date(now.getTime() - 120_000),
        limit: 100,
      });
      for (const candidate of candidates) {
        let state: string;
        try {
          const job = await this.spaceQueue.getJob(candidate.spaceJobId);
          state = job ? await job.getState() : 'missing';
        } catch {
          this.logger.warn(
            `Unable to inspect Knowledge Space job ${candidate.spaceJobId}; recovery deferred.`,
          );
          continue;
        }
        if (EXECUTABLE_JOB_STATES.has(state)) continue;
        if (!['failed', 'completed', 'missing'].includes(state)) continue;

        const recoveryLease = await this.executionRepo.claimRecoveryLease({
          runId: candidate.runId,
          knowledgeGeneration: candidate.knowledgeGeneration,
          jobPhase: candidate.jobPhase,
          spaceJobSequence: candidate.spaceJobSequence,
          spaceJobId: candidate.spaceJobId,
          workerId: `knowledge-space-reaper-${process.pid}`,
          leaseExpiredBefore: now,
          executionLeaseExpiresAt: new Date(
            Date.now() + KNOWLEDGE_WORKER_SETTINGS.executionLeaseTtlMs,
          ),
          // A queued reservation has no execution lease. The repository still
          // re-checks the current status under lock: if a Worker claimed it
          // during Redis inspection, recovery falls back to the expiry fence.
          recoveryKind:
            candidate.status === 'queued'
              ? 'queued_reservation'
              : 'expired',
        });
        if (!recoveryLease) continue;

        if (state === 'missing' && candidate.spaceJobRecoveryCount < 3) {
          await this.executionRepo.requeueMissingSpaceSlice(recoveryLease);
          continue;
        }
        const errorCode =
          state === 'failed'
            ? 'job_attempts_exhausted'
            : state === 'completed'
              ? 'job_completed_without_db_terminal'
              : 'redis_job_missing_exhausted';
        await this.executionRepo.finishRun(recoveryLease, 'failed', {
          errorCode,
          errorMessage: terminalMessage(errorCode),
        });
      }
    } finally {
      this.reaping = false;
    }
  }
}

function terminalMessage(errorCode: string): string {
  switch (errorCode) {
    case 'job_attempts_exhausted':
      return 'Knowledge Space job retries were exhausted.';
    case 'job_completed_without_db_terminal':
      return 'Knowledge Space job completed without a database terminal state.';
    default:
      return 'Knowledge Space job disappeared after bounded recovery.';
  }
}
