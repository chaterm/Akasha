import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { KnowledgeSpaceExecutionRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { MERGE_TRANSPORT_RECOVERY_BUDGET } from '@akasha/db/repos/llm-wiki/knowledge-compilation-budgets';
import { QueueName } from '../../../integrations/queue/constants';

const EXECUTABLE_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/**
 * Recovers Page Merge jobs whose BullMQ transport was lost: a `queued` job that
 * was dispatched but never picked up, or a `running` job whose processing lease
 * expired. Redis job state is inspected outside any DB transaction; recovery
 * re-validates run generation + job identity under the canonical lock order.
 */
@Injectable()
export class KnowledgePageMergeReaperService {
  private readonly logger = new Logger(KnowledgePageMergeReaperService.name);
  private reaping = false;

  constructor(
    @InjectQueue(QueueName.KNOWLEDGE_MERGE_QUEUE)
    private readonly mergeQueue: Queue,
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
  ) {}

  @Interval('knowledge-page-merge-reaper', 30_000)
  async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      const now = new Date();
      const processingExpiredBefore = now;
      const queuedDispatchedBefore = new Date(now.getTime() - 120_000);
      const candidates =
        await this.executionRepo.findPageMergeRecoveryCandidates({
          processingExpiredBefore,
          queuedDispatchedBefore,
          limit: 500,
        });
      for (const candidate of candidates) {
        if (!candidate.mergeJobId) continue;
        let state: string;
        try {
          const job = await this.mergeQueue.getJob(candidate.mergeJobId);
          state = job ? await job.getState() : 'missing';
        } catch {
          this.logger.warn(
            `Unable to inspect page merge job ${candidate.mergeJobId}; recovery deferred.`,
          );
          continue;
        }
        if (EXECUTABLE_JOB_STATES.has(state)) continue;
        if (!['missing', 'failed', 'completed'].includes(state)) continue;
        const identity = {
          runPageId: candidate.runPageId,
          runId: candidate.runId,
          knowledgeGeneration: candidate.knowledgeGeneration,
          mergeJobId: candidate.mergeJobId,
          mergeStatus: candidate.mergeStatus,
          mergeExecutionToken: candidate.mergeExecutionToken,
          mergeProcessingExpiresAt: candidate.mergeProcessingExpiresAt,
          mergeDispatchedAt: candidate.mergeDispatchedAt,
          mergeRedisRecoveryCount: candidate.mergeRedisRecoveryCount,
          observedAt: processingExpiredBefore,
          queuedDispatchedBefore,
        };
        try {
          if (
            state === 'missing' &&
            candidate.mergeRedisRecoveryCount < MERGE_TRANSPORT_RECOVERY_BUDGET
          ) {
            await this.executionRepo.requeueMissingPageMerge(identity);
            continue;
          }
          const errorCode =
            state === 'failed'
              ? 'merge_job_attempts_exhausted'
              : state === 'completed'
                ? 'merge_job_completed_without_db_terminal'
                : 'merge_redis_job_missing_exhausted';
          await this.executionRepo.terminalizePageMerge({
            ...identity,
            errorCode,
            errorMessage: 'Page merge failed after bounded transport recovery.',
          });
        } catch {
          this.logger.warn(
            `Unable to settle page merge recovery for ${candidate.mergeJobId}; recovery deferred.`,
          );
        }
      }
    } finally {
      this.reaping = false;
    }
  }
}
