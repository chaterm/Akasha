import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JsonValue } from '@akasha/db/types/db';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { QueueName } from '../../../integrations/queue/constants';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { EMPTY_KNOWLEDGE_AGGREGATE_HASH } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

@Injectable()
export class KnowledgeSpaceResetService {
  private readonly logger = new Logger(KnowledgeSpaceResetService.name);

  constructor(
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE) private readonly queue: Queue,
    @InjectQueue(QueueName.KNOWLEDGE_IMAGE_QUEUE)
    private readonly imageQueue: Queue,
    private readonly runRepo: KnowledgeSpaceCompilationRepo,
    private readonly compilation: KnowledgeSpaceCompilationService,
  ) {}

  async forceRebuild(input: {
    workspaceId: string;
    spaceId: string;
    confirmationSpaceName: string;
    sources: KnowledgeSourceSnapshot[];
  }) {
    // Snapshot preparation is read-only and deliberately outside the reset
    // transaction. The authoritative name check is repeated under its lock.
    const scope = {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    };
    const result = await this.runRepo.forceResetAndCreateRun({
      ...scope,
      confirmationSpaceName: input.confirmationSpaceName,
      trigger: 'manual_compile',
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      // A force rebuild has the same semantics as the first compilation of a
      // Space. Never carry references to artifacts deleted by the reset into
      // the new Run; aggregation replaces this empty fingerprint after the
      // rebuilt artifacts have been published.
      catalogSnapshot: [] as unknown as JsonValue,
      catalogHash: EMPTY_KNOWLEDGE_AGGREGATE_HASH,
      sources: input.sources.map((source) => ({
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
        expectedImageCount: source.images?.length ?? 0,
      })),
    });
    if (!result.reset) {
      if (result.reason === 'space_name_mismatch') {
        throw new ConflictException(
          'Space name confirmation no longer matches.',
        );
      }
      throw new NotFoundException('Space not found.');
    }

    // PostgreSQL has committed at this point. Redis cleanup is exact-ID only;
    // active jobs remain and are stopped by the publication fence.
    await this.removeSupersededJobs(result.supersededJobIds);
    await this.compilation.dispatchPending();
    return { generation: result.generation, run: result.run };
  }

  private async removeSupersededJobs(jobIds: string[]): Promise<void> {
    for (const jobId of [...new Set(jobIds)]) {
      try {
        for (const queue of [this.queue, this.imageQueue]) {
          const job = await queue.getJob(jobId);
          if (!job) continue;
          const state: string = await job.getState();
          if (
            state === 'waiting' ||
            state === 'delayed' ||
            state === 'paused'
          ) {
            await job.remove();
          }
        }
      } catch {
        this.logger.warn(
          `Unable to cancel superseded knowledge job ${jobId}; publication fencing remains authoritative.`,
        );
      }
    }
  }
}
