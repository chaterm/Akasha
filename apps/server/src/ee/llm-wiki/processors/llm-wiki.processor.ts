import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
  KNOWLEDGE_COMPILER_ADAPTER,
} from '../llm-wiki.constants';
import { KnowledgeCompilerAdapter } from '../adapters/knowledge-compiler.adapter';
import { KnowledgeImportService } from '../services/knowledge-import.service';
import {
  IKnowledgeCompileSpaceJob,
  IKnowledgeCompilePagesJob,
  IKnowledgeMarkSourcesStaleJob,
  IKnowledgeReindexAccessJob,
  IReviewDiscoverJob,
  IReviewNegotiateJob,
} from '../../../integrations/queue/constants/queue.interface';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { KnowledgeAccessIndexerService } from '../services/knowledge-access-indexer.service';
import { KnowledgeSourceExporterService } from '../services/knowledge-source-exporter.service';
import {
  buildKnowledgeCompileCoalesceKey,
  buildKnowledgeCompilePageJobId,
  buildReviewDiscoverJobId,
  buildReviewNegotiateJobId,
  KNOWLEDGE_COMPILE_DELAY_MS,
  uniqueValues,
} from '../services/knowledge-queue.utils';
import { KnowledgeCompileJobResult } from '../types/knowledge-queue.types';
import { ReviewService } from '../review/review.service';
import { ReviewSnapshotService } from '../review/review-snapshot.service';
import { KnowledgeArtifactWikiSource } from '../review/knowledge-artifact-wiki-source';
import { MockSearchProvider } from '../review/search-provider';
import { isDeepSearch, ResolvedReview } from '../review/approval';
import { NegotiationTurn, reviewItemSchema } from '../review/review.schema';

type ReviewProcessorJobResult = {
  type: 'review-discover' | 'review-negotiate';
  status: 'succeeded';
  workspaceId: string;
  spaceId: string;
  jobId: string;
  reviewItemId?: string;
  durationMs: number;
};

@Processor(QueueName.AI_QUEUE)
export class LlmWikiProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(LlmWikiProcessor.name);

  constructor(
    private readonly sourceExporter: KnowledgeSourceExporterService,
    @Inject(KNOWLEDGE_COMPILER_ADAPTER)
    private readonly compiler: KnowledgeCompilerAdapter,
    private readonly importService: KnowledgeImportService,
    private readonly accessIndexer: KnowledgeAccessIndexerService,
    private readonly sourceRepo: KnowledgeSourceRepo,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly pageRepo: PageRepo,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
    private readonly reviewService: ReviewService,
    private readonly reviewSnapshotService: ReviewSnapshotService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly reviewApplicationRepo: KnowledgeReviewApplicationRepo,
  ) {
    super();
  }

  async process(
    job: Job,
  ): Promise<KnowledgeCompileJobResult | ReviewProcessorJobResult | void> {
    switch (job.name) {
      case QueueJob.KNOWLEDGE_COMPILE_SPACE: {
        const data = job.data as IKnowledgeCompileSpaceJob;
        const startedAt = Date.now();
        const sources = await this.sourceExporter.exportSpaceSources({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
        });
        const compileInput = {
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
          promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
          sources,
        };
        const compileResult = await this.compiler.compileSpace(compileInput);
        const importResult = await this.importService.importCompileResult({
          input: compileInput,
          artifacts: compileResult.artifacts,
        });
        await this.accessIndexer.reindexSourcePages({
          workspaceId: data.workspaceId,
          sourcePageIds: sources.map((source) => source.sourcePageId),
        });
        return {
          type: 'compile-space',
          status: 'succeeded',
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerRunId: compileResult.compilerRunId,
          sourceCount: sources.length,
          importedArtifactCount: importResult.importedArtifactCount,
          quarantinedArtifactCount: importResult.quarantinedArtifactCount,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      }
      case QueueJob.KNOWLEDGE_COMPILE_PAGES: {
        const data = job.data as IKnowledgeCompilePagesJob;
        const startedAt = Date.now();
        const sourcePageIds = uniqueValues(data.sourcePageIds);
        const sources = await this.sourceExporter.exportPageSources({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          sourcePageIds,
        });
        const compileInput = {
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
          promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
          compileMode: 'pages' as const,
          sources,
        };
        const compileResult = await this.compiler.compileSpace(compileInput);
        const importResult = await this.importService.importCompileResult({
          input: compileInput,
          artifacts: compileResult.artifacts,
        });
        await this.accessIndexer.reindexSourcePages({
          workspaceId: data.workspaceId,
          sourcePageIds: sources.map((source) => source.sourcePageId),
        });
        return {
          type: 'compile-pages',
          status: 'succeeded',
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerRunId: compileResult.compilerRunId,
          sourceCount: sources.length,
          importedArtifactCount: importResult.importedArtifactCount,
          quarantinedArtifactCount: importResult.quarantinedArtifactCount,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      }
      case QueueJob.KNOWLEDGE_REINDEX_ACCESS: {
        const data = job.data as IKnowledgeReindexAccessJob;
        if (data.sourcePageIds?.length) {
          await this.accessIndexer.reindexSourcePages({
            workspaceId: data.workspaceId,
            sourcePageIds: uniqueValues(data.sourcePageIds),
          });
        } else if (data.spaceId) {
          const sourcePageIds = await this.findSourcePageIdsForSpace({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
          });
          await this.accessIndexer.reindexSourcePages({
            workspaceId: data.workspaceId,
            sourcePageIds,
          });
        }
        break;
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

    await this.sourceRepo.markSourcesStale({
      workspaceId: data.workspaceId,
      sourcePageIds: data.pageIds,
    });
    await this.capsuleRepo.markSourceArtifactsStaleBySourcePageIds({
      workspaceId: data.workspaceId,
      sourcePageIds: data.pageIds,
    });
    await this.accessIndexer.reindexSourcePages({
      workspaceId: data.workspaceId,
      sourcePageIds: data.pageIds,
    });

    const pageRefs = await this.pageRepo.findExistingPageRefs({
      workspaceId: data.workspaceId,
      pageIds: data.pageIds,
    });

    for (const page of pageRefs) {
      if (page.deletedAt) continue;
      await this.aiQueue.add(
        QueueJob.KNOWLEDGE_COMPILE_PAGES,
        {
          workspaceId: data.workspaceId,
          spaceId: page.spaceId,
          sourcePageIds: [page.id],
          trigger: 'page_update',
        },
        {
          delay: KNOWLEDGE_COMPILE_DELAY_MS,
          jobId: buildKnowledgeCompilePageJobId({
            workspaceId: data.workspaceId,
            spaceId: page.spaceId,
            sourcePageId: page.id,
            runKey: buildKnowledgeCompileCoalesceKey(),
          }),
        },
      );
    }
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

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`Processing ${job.name} job`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job) {
    this.logger.error(
      `Error processing ${job.name} job. Reason: ${job.failedReason}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.debug(`Completed ${job.name} job`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
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
