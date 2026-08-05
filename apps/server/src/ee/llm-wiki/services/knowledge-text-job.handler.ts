import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  IKnowledgeMarkSourcesStaleJob,
  IKnowledgeRebuildEmbeddingsJob,
  IKnowledgeReindexAccessJob,
  IReviewDiscoverJob,
  IReviewNegotiateJob,
} from '../../../integrations/queue/constants/queue.interface';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';
import {
  buildKnowledgeRebuildEmbeddingsContinuationJobId,
  buildKnowledgeReindexAccessContinuationJobId,
  buildReviewDiscoverJobId,
  buildReviewNegotiateJobId,
  uniqueValues,
} from './knowledge-queue.utils';
import { ReviewService } from '../review/review.service';
import { ReviewSnapshotService } from '../review/review-snapshot.service';
import { KnowledgeArtifactWikiSource } from '../review/knowledge-artifact-wiki-source';
import { MockSearchProvider } from '../review/search-provider';
import { isDeepSearch, ResolvedReview } from '../review/approval';
import { NegotiationTurn, reviewItemSchema } from '../review/review.schema';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';

type ReviewProcessorJobResult = {
  type: 'review-discover' | 'review-negotiate';
  status: 'succeeded';
  workspaceId: string;
  spaceId: string;
  jobId: string;
  reviewItemId?: string;
  durationMs: number;
};

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
    private readonly reviewService: ReviewService,
    private readonly reviewSnapshotService: ReviewSnapshotService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly reviewApplicationRepo: KnowledgeReviewApplicationRepo,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly vectorIndex: KnowledgeVectorIndexService,
  ) {}

  async handle(
    job: Job,
  ): Promise<
    ReviewProcessorJobResult | KnowledgeEmbeddingRebuildJobResult | void
  > {
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
        });
        if (result.nextCursor) {
          await this.textQueue.add(
            QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
            {
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              afterChunkId: result.nextCursor,
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
      case QueueJob.REVIEW_DISCOVER: {
        return this.handleReviewDiscoverJob(job);
      }
      case QueueJob.REVIEW_NEGOTIATE: {
        return this.handleReviewNegotiateJob(job);
      }
      case QueueJob.PAGE_CONTENT_UPDATED: {
        const data = job.data as { workspaceId: string; pageIds: string[] };
        await this.handlePageContentUpdated(data);
        break;
      }
    }
  }

  private async handleReviewDiscoverJob(
    job: Job,
  ): Promise<ReviewProcessorJobResult> {
    const data = job.data as IReviewDiscoverJob;
    const jobId =
      typeof job.id === 'string'
        ? job.id
        : buildReviewDiscoverJobId({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
          });
    const startedAt = Date.now();

    await this.reviewSnapshotService.beginJob({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      jobId,
      kind: 'discover',
    });
    await this.reviewSnapshotService.markJobRunning({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      jobId,
    });

    try {
      const source = this.buildReviewSource(
        data.workspaceId,
        data.spaceId,
        data.limit,
      );
      const result = await this.reviewService.reviewWiki(source);
      const docs = await source.getDocMeta();
      await this.reviewSnapshotService.replaceDiscoveredSnapshot({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        items: result.items,
        docs,
      });
      await this.reviewSnapshotService.markJobDone({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        jobId,
      });
      this.auditService.log({
        event: AuditEvent.KNOWLEDGE_REVIEW_DISCOVERED,
        resourceType: AuditResource.KNOWLEDGE,
        resourceId: data.spaceId,
        spaceId: data.spaceId,
        metadata: {
          limit: data.limit ?? null,
          documentCount: docs.length,
          reviewItemCount: result.items.length,
          reviewItemTypes: countReviewItemTypes(result.items),
        },
      });
      return {
        type: 'review-discover',
        status: 'succeeded',
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        jobId,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      await this.reviewSnapshotService.markJobFailed({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handleReviewNegotiateJob(
    job: Job,
  ): Promise<ReviewProcessorJobResult> {
    const data = job.data as IReviewNegotiateJob;
    const item = reviewItemSchema.parse(data.item);
    const feedback = (data.feedback ?? '').trim();
    const jobId =
      typeof job.id === 'string'
        ? job.id
        : buildReviewNegotiateJobId({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            itemId: item.id,
          });
    const startedAt = Date.now();

    await this.reviewSnapshotService.beginJob({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      jobId,
      kind: 'negotiate',
      itemId: item.id,
    });
    await this.reviewSnapshotService.markJobRunning({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      jobId,
    });

    try {
      const snapshot = await this.reviewSnapshotService.loadSnapshot({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
      });
      const storedResolved = snapshot?.resolvedReviews.find(
        (entry) => entry.item.id === item.id,
      );
      const priorTurns = storedResolved?.turns ?? [];
      const deepSearched = isDeepSearch(feedback);
      const searchResults = deepSearched
        ? await this.reviewService.runDeepSearch(new MockSearchProvider(), item)
        : [];
      const draft = await this.reviewService.negotiateDraft(
        this.buildReviewSource(data.workspaceId, data.spaceId),
        item,
        feedback,
        searchResults,
        priorTurns,
      );

      const newTurn: NegotiationTurn = {
        feedback,
        draft,
        deepSearched,
        searchResults,
      };
      const resolved: ResolvedReview = {
        item,
        feedback,
        skipped: false,
        deepSearched,
        searchResults,
        draft,
        applied: null,
        turns: [...priorTurns, newTurn],
      };
      await this.reviewSnapshotService.saveResolvedReview({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        resolved,
      });
      await this.reviewApplicationRepo.supersedeDraftsForReviewItem({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        reviewItemId: item.id,
      });
      await this.reviewSnapshotService.markJobDone({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        jobId,
      });
      this.auditNegotiation(data.spaceId, resolved);
      return {
        type: 'review-negotiate',
        status: 'succeeded',
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        jobId,
        reviewItemId: item.id,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      await this.reviewSnapshotService.markJobFailed({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private buildReviewSource(
    workspaceId: string,
    spaceId: string,
    limit?: number,
  ): KnowledgeArtifactWikiSource {
    return new KnowledgeArtifactWikiSource(this.capsuleRepo, {
      workspaceId,
      spaceId,
      limit,
    });
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

  private auditNegotiation(spaceId: string, resolved: ResolvedReview): void {
    this.auditService.log({
      event: AuditEvent.KNOWLEDGE_REVIEW_NEGOTIATED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: spaceId,
      spaceId,
      metadata: {
        reviewItemId: resolved.item.id,
        reviewItemType: resolved.item.type,
        feedbackKind: classifyFeedback(resolved.feedback),
        skipped: resolved.skipped,
        deepSearched: resolved.deepSearched,
        searchResultCount: resolved.searchResults.length,
        negotiationTurnCount: resolved.turns.length,
        draftApplyOperation: resolved.draft?.applyOperation ?? null,
        hasDraft: Boolean(resolved.draft),
        targetDocId: resolved.draft?.targetDocId ?? null,
        applied: false,
        appliedAction: null,
        appliedPageId: null,
      },
    });
  }
}

function countReviewItemTypes(
  items: Array<{ type: string }>,
): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    return counts;
  }, {});
}

function classifyFeedback(
  feedback: string,
): 'skip' | 'deep_search' | 'accept' | 'free_text' {
  if (isDeepSearch(feedback)) return 'deep_search';
  return feedback.trim() === '采纳' ? 'accept' : 'free_text';
}
