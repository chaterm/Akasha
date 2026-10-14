import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  IKnowledgeMarkSourcesStaleJob,
  IKnowledgeRetireSourcesJob,
  IKnowledgeRebuildEmbeddingsJob,
  IKnowledgeReindexAccessJob,
} from '../../../integrations/queue/constants/queue.interface';
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';
import {
  buildKnowledgeRebuildEmbeddingsContinuationJobId,
  buildKnowledgeReindexAccessContinuationJobId,
  uniqueValues,
} from './knowledge-queue.utils';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';
import { KnowledgeSourceRetirementService } from './knowledge-source-retirement.service';

type KnowledgeEmbeddingRebuildJobResult = {
  rebuiltChunkCount: number;
  failedChunkIds?: string[];
  nextCursor?: string;
};

@Injectable()
export class KnowledgeTextJobHandler {
  constructor(
    private readonly accessIndexer: KnowledgeAccessIndexerService,
    private readonly sourceRepo: KnowledgeSourceRepo,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE)
    private readonly textQueue: Queue,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly vectorIndex: KnowledgeVectorIndexService,
    private readonly sourceRetirement: KnowledgeSourceRetirementService,
  ) {}

  async handle(job: Job): Promise<KnowledgeEmbeddingRebuildJobResult | void> {
    switch (job.name) {
      case QueueJob.KNOWLEDGE_REINDEX_ACCESS: {
        const data = job.data as IKnowledgeReindexAccessJob;
        if (data.sourcePageIds?.length) {
          await this.accessIndexer.reindexSourcePages({
            workspaceId: data.workspaceId,
            sourcePageIds: uniqueValues(data.sourcePageIds),
          });
        } else if (data.spaceId) {
          const sourcePageIds =
            await this.sourceRepo.findSourcePageIdsBySpaceBatch({
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              ...(data.afterSourcePageId
                ? { afterSourcePageId: data.afterSourcePageId }
                : {}),
              limit: 200,
            });
          await this.accessIndexer.reindexSourcePages({
            workspaceId: data.workspaceId,
            sourcePageIds,
          });
          if (sourcePageIds.length === 200) {
            const afterSourcePageId = sourcePageIds[sourcePageIds.length - 1];
            await this.textQueue.add(
              QueueJob.KNOWLEDGE_REINDEX_ACCESS,
              {
                workspaceId: data.workspaceId,
                spaceId: data.spaceId,
                afterSourcePageId,
              } satisfies IKnowledgeReindexAccessJob,
              {
                jobId: buildKnowledgeReindexAccessContinuationJobId({
                  workspaceId: data.workspaceId,
                  spaceId: data.spaceId,
                  afterSourcePageId,
                }),
              },
            );
          }
        }
        break;
      }
      case QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS: {
        const data = job.data as IKnowledgeRebuildEmbeddingsJob;
        const result = await this.vectorIndex.rebuildSpaceEmbeddings({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          ...(data.afterChunkId ? { afterChunkId: data.afterChunkId } : {}),
          ...(data.embeddingConcurrency === undefined
            ? {}
            : { embeddingConcurrency: data.embeddingConcurrency }),
        });
        if (result.failedChunkIds?.length) {
          throw new Error(
            `Knowledge embedding rebuild failed for ${result.failedChunkIds.length} chunk(s).`,
          );
        }
        if (result.nextCursor) {
          await this.textQueue.add(
            QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
            {
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              afterChunkId: result.nextCursor,
              ...(data.embeddingConcurrency === undefined
                ? {}
                : { embeddingConcurrency: data.embeddingConcurrency }),
            } satisfies IKnowledgeRebuildEmbeddingsJob,
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              jobId: buildKnowledgeRebuildEmbeddingsContinuationJobId({
                workspaceId: data.workspaceId,
                spaceId: data.spaceId,
                afterChunkId: result.nextCursor,
              }),
            },
          );
        }
        return result;
      }
      case QueueJob.KNOWLEDGE_MARK_SOURCES_STALE: {
        const data = job.data as IKnowledgeMarkSourcesStaleJob;
        const sourcePageIds = data.sourcePageIds?.length
          ? uniqueValues(data.sourcePageIds)
          : data.spaceId
            ? await this.findSourcePageIdsForSpace({
                workspaceId: data.workspaceId,
                spaceId: data.spaceId,
              })
            : [];
        if (sourcePageIds.length === 0) break;
        await this.sourceRepo.markSourcesStale({
          workspaceId: data.workspaceId,
          sourcePageIds,
        });
        if (data.mode === 'source_artifacts') {
          await this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds({
            workspaceId: data.workspaceId,
            sourcePageIds,
          });
        } else {
          await this.capsuleRepo.markCapsulesStaleBySourcePageIds({
            workspaceId: data.workspaceId,
            sourcePageIds,
          });
        }
        break;
      }
      case QueueJob.KNOWLEDGE_RETIRE_SOURCES: {
        const data = job.data as IKnowledgeRetireSourcesJob;
        await this.sourceRetirement.retireOutOfScopeSources({
          workspaceId: data.workspaceId,
          sourcePageIds: uniqueValues(data.sourcePageIds),
        });
        break;
      }
      case QueueJob.PAGE_CONTENT_UPDATED: {
        const data = job.data as { workspaceId: string; pageIds: string[] };
        await this.handlePageContentUpdated(data);
        break;
      }
    }
  }
  private async handlePageContentUpdated(data: {
    workspaceId: string;
    pageIds: string[];
  }): Promise<void> {
    if (!data.workspaceId || !data.pageIds?.length) return;

    await this.accessIndexer.reindexSourcePages({
      workspaceId: data.workspaceId,
      sourcePageIds: data.pageIds,
    });

    await this.spaceCompilation.scheduleIncrementalCompileForPages({
      workspaceId: data.workspaceId,
      sourcePageIds: uniqueValues(data.pageIds),
      trigger: 'page_updated',
    });
  }

  private async findSourcePageIdsForSpace(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<string[]> {
    const sources = await this.sourceRepo.findSourcesBySpace(input);
    return uniqueValues(sources.map((source) => source.sourcePageId));
  }
}
