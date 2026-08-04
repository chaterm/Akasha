import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { QueueName } from '../../../integrations/queue/constants';

const EXECUTABLE_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

@Injectable()
export class KnowledgeImageReaperService {
  private readonly logger = new Logger(KnowledgeImageReaperService.name);
  private reaping = false;

  constructor(
    @InjectQueue(QueueName.KNOWLEDGE_IMAGE_QUEUE)
    private readonly imageQueue: Queue,
    private readonly runRepo: KnowledgeSpaceCompilationRepo,
  ) {}

  @Interval('knowledge-run-image-reaper', 30_000)
  async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      const now = new Date();
      const processingExpiredBefore = now;
      const queuedDispatchedBefore = new Date(now.getTime() - 120_000);
      const candidates = await this.runRepo.findRunImageRecoveryCandidates({
        processingExpiredBefore,
        queuedDispatchedBefore,
        limit: 500,
      });
      for (const candidate of candidates) {
        if (
          candidate.status !== 'queued' &&
          candidate.status !== 'processing'
        ) {
          continue;
        }
        let state: string;
        try {
          const job = await this.imageQueue.getJob(candidate.jobId!);
          state = job ? await job.getState() : 'missing';
        } catch {
          this.logger.warn(
            `Unable to inspect RunImage job ${candidate.jobId}; recovery deferred.`,
          );
          continue;
        }
        if (EXECUTABLE_JOB_STATES.has(state)) continue;
        if (!['missing', 'failed', 'completed'].includes(state)) continue;
        const identity = {
          runImageId: candidate.runImageId,
          runId: candidate.runId,
          knowledgeGeneration: candidate.knowledgeGeneration,
          jobId: candidate.jobId!,
        };
        if (state === 'missing' && candidate.redisRecoveryCount < 3) {
          await this.runRepo.requeueMissingRunImage({
            ...identity,
            observedStatus: candidate.status,
            processingExpiredBefore,
            queuedDispatchedBefore,
          });
          continue;
        }
        const errorCode =
          state === 'failed'
            ? 'image_job_attempts_exhausted'
            : state === 'completed'
              ? 'image_job_completed_without_db_terminal'
              : 'image_redis_job_missing_exhausted';
        await this.runRepo.completeRunImage({
          ...identity,
          status: 'failed',
          failureClass: 'retryable_exhausted',
          errorCode,
          errorMessage: 'Image job failed after bounded transport recovery.',
        });
      }
    } finally {
      this.reaping = false;
    }
  }
}
