import { Inject, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
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
import {
  KnowledgeCompilationValidationError,
  KnowledgeImportService,
} from '../services/knowledge-import.service';
import {
  IKnowledgeCompileSpaceJob,
  IKnowledgeCompilePagesJob,
  IKnowledgeAggregateSpaceJob,
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
  KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
  uniqueValues,
} from '../services/knowledge-queue.utils';
import { KnowledgeCompileJobResult } from '../types/knowledge-queue.types';
import { ReviewService } from '../review/review.service';
import { ReviewSnapshotService } from '../review/review-snapshot.service';
import { KnowledgeArtifactWikiSource } from '../review/knowledge-artifact-wiki-source';
import { MockSearchProvider } from '../review/search-provider';
import { isDeepSearch, ResolvedReview } from '../review/approval';
import { NegotiationTurn, reviewItemSchema } from '../review/review.schema';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgeArtifactCatalogService } from '../services/knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from '../services/knowledge-space-compilation.service';
import { KnowledgeSpaceAggregatorService } from '../services/knowledge-space-aggregator.service';
import { KnowledgeImageEnrichmentService } from '../services/knowledge-image-enrichment.service';

type ReviewProcessorJobResult = {
  type: 'review-discover' | 'review-negotiate';
  status: 'succeeded';
  workspaceId: string;
  spaceId: string;
  jobId: string;
  reviewItemId?: string;
  durationMs: number;
};

class SourceChangedDuringCompilationError extends Error {
  constructor() {
    super('Knowledge source changed during compilation.');
    this.name = 'SourceChangedDuringCompilationError';
  }
}

class UnavailableKnowledgeSourceError extends Error {
  constructor() {
    super('Knowledge source page is unavailable for compilation.');
    this.name = 'UnavailableKnowledgeSourceError';
  }
}

class ImageEnrichmentIncompleteError extends Error {
  constructor(message = 'Page image enrichment is incomplete.') {
    super(message);
    this.name = 'ImageEnrichmentIncompleteError';
  }
}

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
    private readonly compilationRepo?: KnowledgeCompilationRepo,
    @Optional()
    private readonly artifactCatalog?: KnowledgeArtifactCatalogService,
    @Optional()
    private readonly spaceCompilation?: KnowledgeSpaceCompilationService,
    @Optional()
    private readonly spaceAggregator?: KnowledgeSpaceAggregatorService,
    @Optional()
    private readonly imageEnrichment?: KnowledgeImageEnrichmentService,
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
        if (!this.spaceCompilation) {
          throw new UnrecoverableError(
            'Knowledge Space compilation coordinator is unavailable.',
          );
        }
        const sourceByPageId = new Map(
          sources.map((source) => [source.sourcePageId, source] as const),
        );
        const run = await this.spaceCompilation.startSpaceRun({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          trigger: data.trigger ?? 'manual_compile',
          requestedAt: Number.isFinite(job.timestamp)
            ? new Date(job.timestamp)
            : undefined,
          sources: [...sourceByPageId.values()],
        });
        if (!run) {
          return {
            type: 'compile-space',
            status: 'succeeded',
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            compilerRunId: job.id
              ? String(job.id)
              : 'stale-compile-space-request',
            sourceCount: 0,
            importedArtifactCount: 0,
            quarantinedArtifactCount: 0,
            durationMs: Math.max(0, Date.now() - startedAt),
          };
        }
        return {
          type: 'compile-space',
          status: 'queued',
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerRunId: run.id,
          sourceCount: sources.length,
          importedArtifactCount: 0,
          quarantinedArtifactCount: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
      }
      case QueueJob.KNOWLEDGE_AGGREGATE_SPACE: {
        const data = job.data as IKnowledgeAggregateSpaceJob;
        const startedAt = Date.now();
        if (!this.spaceAggregator) {
          throw new UnrecoverableError(
            'Knowledge Space aggregator is unavailable.',
          );
        }
        try {
          const result = await this.spaceAggregator.aggregate({
            runId: data.spaceRunId,
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
          });
          return {
            type: 'compile-space',
            status: 'succeeded',
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            compilerRunId: data.spaceRunId,
            sourceCount: 0,
            importedArtifactCount: result.importedArtifactCount,
            quarantinedArtifactCount: result.quarantinedArtifactCount,
            durationMs: Math.max(0, Date.now() - startedAt),
          };
        } catch (error) {
          if (
            this.spaceCompilation &&
            !(await this.spaceCompilation.isRunActive({
              runId: data.spaceRunId,
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
            }))
          ) {
            return {
              type: 'compile-space',
              status: 'succeeded',
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              compilerRunId: data.spaceRunId,
              sourceCount: 0,
              importedArtifactCount: 0,
              quarantinedArtifactCount: 0,
              durationMs: Math.max(0, Date.now() - startedAt),
            };
          }
          const failure = classifyCompilationFailure(error);
          const terminal = !failure.retryable || isFinalJobAttempt(job);
          await this.spaceCompilation?.failAggregation({
            runId: data.spaceRunId,
            errorCode: failure.code,
            errorMessage: failure.message,
            terminal,
          });
          if (!failure.retryable) {
            throw new UnrecoverableError(failure.message);
          }
          throw error;
        }
      }
      case QueueJob.KNOWLEDGE_COMPILE_PAGES: {
        const data = job.data as IKnowledgeCompilePagesJob;
        const startedAt = Date.now();
        const sourcePageIds = uniqueValues(data.sourcePageIds);
        if (sourcePageIds.length !== 1) {
          throw new UnrecoverableError(
            'Knowledge page compile requires exactly one source page.',
          );
        }
        const sourcePageId = sourcePageIds[0];
        const compileTaskId = String(
          job.id ??
            buildKnowledgeCompilePageJobId({
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              sourcePageId,
            }),
        );
        if (data.spaceRunId) {
          if (!this.spaceCompilation) {
            throw new UnrecoverableError(
              'Knowledge Space compilation coordinator is unavailable.',
            );
          }
          if (!(await this.isSpaceRunActive(data))) {
            await this.skipCancelledAttempt({
              data,
              sourcePageId,
              compileTaskId,
            });
            return noOpPageResult(data, startedAt);
          }
        } else if (!(await this.isPageCompilationAllowed(data))) {
          await this.skipCancelledAttempt({
            data,
            sourcePageId,
            compileTaskId,
          });
          return noOpPageResult(data, startedAt);
        }
        try {
          if (data.spaceRunId) {
            await this.spaceCompilation!.markPageRunning({
              runId: data.spaceRunId,
              sourcePageId,
            });
          }
          await this.compilationRepo?.startAttempt({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            sourcePageId,
            sourceVersion: data.sourceVersion,
            sourceContentHash: data.sourceContentHash,
            compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
            promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
            compilerRunId: compileTaskId,
            compileTaskId,
          });
          const sources = await this.sourceExporter.exportPageSources({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            sourcePageIds,
          });
          if (
            sources.length !== 1 ||
            sources[0].sourcePageId !== sourcePageId
          ) {
            throw new UnavailableKnowledgeSourceError();
          }
          const exportedSource = sources[0];
          let source = exportedSource;
          let imageEnrichmentIncomplete = false;
          if ((source.images?.length ?? 0) > 0) {
            await this.compilationRepo?.updateStage({
              workspaceId: data.workspaceId,
              sourcePageId,
              compileTaskId,
              stage: 'image_enrichment',
            });
            if (this.imageEnrichment) {
              const enrichment =
                await this.imageEnrichment.enrichSource(source);
              source = enrichment.source;
              sources[0] = source;
              imageEnrichmentIncomplete =
                enrichment.failedCount > 0 ||
                enrichment.succeededCount < enrichment.imageCount ||
                enrichment.imageCount < (exportedSource.images?.length ?? 0);
              if (enrichment.warnings.length > 0) {
                this.logger.warn(
                  `Page image enrichment completed with warnings for page ${sourcePageId}: ` +
                    `${enrichment.succeededCount}/${enrichment.imageCount} images produced searchable content.`,
                );
              }
            } else {
              imageEnrichmentIncomplete = true;
            }
          }
          await this.compilationRepo?.updateSourceSnapshot({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            sourceVersion: exportedSource.sourceVersion,
            sourceContentHash: exportedSource.contentHash,
          });
          if (
            data.spaceRunId &&
            ((data.sourceVersion &&
              data.sourceVersion !== exportedSource.sourceVersion) ||
              (data.sourceContentHash &&
                data.sourceContentHash !== exportedSource.contentHash))
          ) {
            const errorMessage =
              'Knowledge source changed after the Space run snapshot.';
            await this.compilationRepo?.skipAttempt({
              workspaceId: data.workspaceId,
              sourcePageId,
              compileTaskId,
              reasonCode: 'source_changed',
              reasonMessage: errorMessage,
            });
            await this.spaceCompilation!.completePage({
              runId: data.spaceRunId,
              sourcePageId,
              status: 'skipped',
              errorCode: 'source_changed',
              errorMessage,
            });
            return {
              type: 'compile-pages',
              status: 'succeeded',
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              compilerRunId: data.spaceRunId,
              sourceCount: 0,
              importedArtifactCount: 0,
              quarantinedArtifactCount: 0,
              durationMs: Math.max(0, Date.now() - startedAt),
            };
          }
          if (imageEnrichmentIncomplete) {
            if (!isFinalJobAttempt(job)) {
              throw new ImageEnrichmentIncompleteError(
                'Page image enrichment is incomplete and will be retried.',
              );
            }
            const activeSource =
              await this.sourceRepo.findLatestActiveSourceByPageId({
                workspaceId: data.workspaceId,
                sourcePageId,
              });
            const preservingLastKnownGood =
              activeSource?.contentHash === exportedSource.contentHash;
            if (!preservingLastKnownGood) {
              const latestSources = await this.sourceExporter.exportPageSources(
                {
                  workspaceId: data.workspaceId,
                  spaceId: data.spaceId,
                  sourcePageIds,
                },
              );
              if (!isSameSourceSnapshot(exportedSource, latestSources[0])) {
                const sourceChangedMessage =
                  'Knowledge source changed before failed-image retirement.';
                await this.compilationRepo?.skipAttempt({
                  workspaceId: data.workspaceId,
                  sourcePageId,
                  compileTaskId,
                  stage: 'image_enrichment',
                  reasonCode: 'source_changed',
                  reasonMessage: sourceChangedMessage,
                });
                if (data.spaceRunId) {
                  await this.spaceCompilation!.completePage({
                    runId: data.spaceRunId,
                    sourcePageId,
                    status: 'skipped',
                    errorCode: 'source_changed',
                    errorMessage: sourceChangedMessage,
                  });
                }
                return noOpPageResult(data, startedAt);
              }
              if (!(await this.isPageCompilationAllowed(data))) {
                await this.skipCancelledAttempt({
                  data,
                  sourcePageId,
                  compileTaskId,
                });
                return noOpPageResult(data, startedAt);
              }
              const retirement = await this.importService.importCompileResult({
                input: {
                  workspaceId: data.workspaceId,
                  spaceId: data.spaceId,
                  compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
                  promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
                  compileTaskId,
                  compileMode: 'pages',
                  sources,
                },
                artifacts: [],
                upsertSources: false,
                retireSources: true,
                ...(data.spaceRunId
                  ? {
                      publicationGuard: (trx) =>
                        this.spaceCompilation!.isRunActiveForPublication(
                          {
                            runId: data.spaceRunId!,
                            workspaceId: data.workspaceId,
                            spaceId: data.spaceId,
                          },
                          trx,
                        ),
                    }
                  : {}),
              });
              if (retirement.skippedReason === 'run_superseded') {
                await this.skipCancelledAttempt({
                  data,
                  sourcePageId,
                  compileTaskId,
                });
                return noOpPageResult(data, startedAt);
              }
            }
            const errorMessage = preservingLastKnownGood
              ? 'Page images did not produce searchable content; unchanged last-known-good knowledge is still being served.'
              : 'Page images did not produce searchable content; outdated knowledge was retired.';
            throw new ImageEnrichmentIncompleteError(errorMessage);
          }
          if (!source.text.trim()) {
            const errorMessage = 'Knowledge source page is empty.';
            const latestSources = await this.sourceExporter.exportPageSources({
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              sourcePageIds,
            });
            if (!isSameSourceSnapshot(exportedSource, latestSources[0])) {
              const sourceChangedMessage =
                'Knowledge source changed before empty-source retirement.';
              await this.compilationRepo?.skipAttempt({
                workspaceId: data.workspaceId,
                sourcePageId,
                compileTaskId,
                reasonCode: 'source_changed',
                reasonMessage: sourceChangedMessage,
              });
              if (data.spaceRunId) {
                await this.spaceCompilation!.completePage({
                  runId: data.spaceRunId,
                  sourcePageId,
                  status: 'skipped',
                  errorCode: 'source_changed',
                  errorMessage: sourceChangedMessage,
                });
              }
              return noOpPageResult(data, startedAt);
            }
            if (!(await this.isPageCompilationAllowed(data))) {
              await this.skipCancelledAttempt({
                data,
                sourcePageId,
                compileTaskId,
              });
              return noOpPageResult(data, startedAt);
            }
            const retirement = await this.importService.importCompileResult({
              input: {
                workspaceId: data.workspaceId,
                spaceId: data.spaceId,
                compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
                promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
                compileTaskId,
                compileMode: 'pages',
                sources,
              },
              artifacts: [],
              upsertSources: false,
              retireSources: true,
              ...(data.spaceRunId
                ? {
                    publicationGuard: (trx) =>
                      this.spaceCompilation!.isRunActiveForPublication(
                        {
                          runId: data.spaceRunId!,
                          workspaceId: data.workspaceId,
                          spaceId: data.spaceId,
                        },
                        trx,
                      ),
                  }
                : {}),
            });
            if (retirement.skippedReason === 'run_superseded') {
              await this.skipCancelledAttempt({
                data,
                sourcePageId,
                compileTaskId,
              });
              return noOpPageResult(data, startedAt);
            }
            await this.compilationRepo?.skipAttempt({
              workspaceId: data.workspaceId,
              sourcePageId,
              compileTaskId,
              reasonCode: 'empty_source',
              reasonMessage: errorMessage,
            });
            if (data.spaceRunId) {
              await this.spaceCompilation!.completePage({
                runId: data.spaceRunId,
                sourcePageId,
                status: 'skipped',
                errorCode: 'empty_source',
                errorMessage,
              });
            }
            return noOpPageResult(data, startedAt);
          }
          const catalogEntries = data.spaceRunId
            ? await this.spaceCompilation!.catalogForPage({
                runId: data.spaceRunId,
                workspaceId: data.workspaceId,
                spaceId: data.spaceId,
              })
            : ((
                await this.artifactCatalog?.snapshot({
                  workspaceId: data.workspaceId,
                  spaceId: data.spaceId,
                })
              )?.entries ?? []);
          if (!(await this.isPageCompilationAllowed(data))) {
            await this.skipCancelledAttempt({
              data,
              sourcePageId,
              compileTaskId,
            });
            return noOpPageResult(data, startedAt);
          }
          const compileInput = {
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
            promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
            compileTaskId,
            compileMode: 'pages' as const,
            catalog: catalogEntries,
            sources,
          };
          const compileResult = await this.compiler.compileSpace(compileInput);
          await this.compilationRepo?.updateStage({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            stage: 'validation',
          });
          const latestSources = await this.sourceExporter.exportPageSources({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            sourcePageIds,
          });
          if (!isSameSourceSnapshot(exportedSource, latestSources[0])) {
            throw new SourceChangedDuringCompilationError();
          }
          if (!(await this.isPageCompilationAllowed(data))) {
            await this.skipCancelledAttempt({
              data,
              sourcePageId,
              compileTaskId,
            });
            return noOpPageResult(data, startedAt);
          }
          const importResult = await this.importService.importCompileResult({
            input: compileInput,
            artifacts: compileResult.artifacts,
            ...(data.spaceRunId
              ? {
                  publicationGuard: (trx) =>
                    this.spaceCompilation!.isRunActiveForPublication(
                      {
                        runId: data.spaceRunId!,
                        workspaceId: data.workspaceId,
                        spaceId: data.spaceId,
                      },
                      trx,
                    ),
                }
              : {}),
            onStage: async (stage) => {
              await this.compilationRepo?.updateStage({
                workspaceId: data.workspaceId,
                sourcePageId,
                compileTaskId,
                stage,
              });
            },
          });
          if (importResult.skippedReason === 'run_superseded') {
            await this.skipCancelledAttempt({
              data,
              sourcePageId,
              compileTaskId,
            });
            return noOpPageResult(data, startedAt);
          }
          await this.accessIndexer.reindexSourcePages({
            workspaceId: data.workspaceId,
            sourcePageIds: [sourcePageId],
          });
          await this.compilationRepo?.succeedAttempt({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            sourceVersion: exportedSource.sourceVersion,
            sourceContentHash: exportedSource.contentHash,
          });
          if (data.spaceRunId) {
            await this.spaceCompilation!.completePage({
              runId: data.spaceRunId,
              sourcePageId,
              status: 'succeeded',
            });
          }
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
        } catch (error) {
          if (data.spaceRunId && !(await this.isSpaceRunActive(data))) {
            await this.skipCancelledAttempt({
              data,
              sourcePageId,
              compileTaskId,
            });
            return noOpPageResult(data, startedAt);
          }
          const failure = classifyCompilationFailure(error);
          await this.compilationRepo?.failAttempt({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            ...(failure.stage ? { stage: failure.stage } : {}),
            errorCode: failure.code,
            errorMessage: failure.message,
          });
          if (
            data.spaceRunId &&
            (!failure.retryable || isFinalJobAttempt(job))
          ) {
            await this.spaceCompilation!.completePage({
              runId: data.spaceRunId,
              sourcePageId,
              status: 'failed',
              errorCode: failure.code,
              errorMessage: failure.message,
            });
          }
          if (!failure.retryable) {
            throw new UnrecoverableError(failure.message);
          }
          throw error;
        }
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
      const jobId = buildKnowledgeCompilePageJobId({
        workspaceId: data.workspaceId,
        spaceId: page.spaceId,
        sourcePageId: page.id,
        runKey: buildKnowledgeCompileCoalesceKey(),
      });
      await this.compilationRepo?.queueAttempt({
        workspaceId: data.workspaceId,
        spaceId: page.spaceId,
        sourcePageId: page.id,
        sourceVersion: undefined,
        sourceContentHash: undefined,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        compilerRunId: jobId,
        compileTaskId: jobId,
      });
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
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
          },
          jobId,
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

  private async isSpaceRunActive(
    data: IKnowledgeCompilePagesJob,
  ): Promise<boolean> {
    if (!data.spaceRunId) return true;
    return this.spaceCompilation!.isRunActive({
      runId: data.spaceRunId,
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
    });
  }

  private async isPageCompilationAllowed(
    data: IKnowledgeCompilePagesJob,
  ): Promise<boolean> {
    if (data.spaceRunId) return this.isSpaceRunActive(data);
    if (data.trigger !== 'retry_compile' || !this.spaceCompilation) return true;
    return !(await this.spaceCompilation.hasActiveRun({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
    }));
  }

  private async skipCancelledAttempt(input: {
    data: IKnowledgeCompilePagesJob;
    sourcePageId: string;
    compileTaskId: string;
  }): Promise<void> {
    const superseded = Boolean(input.data.spaceRunId);
    await this.compilationRepo?.skipAttempt({
      workspaceId: input.data.workspaceId,
      sourcePageId: input.sourcePageId,
      compileTaskId: input.compileTaskId,
      reasonCode: superseded ? 'run_superseded' : 'space_run_active',
      reasonMessage: superseded
        ? 'Knowledge Space run was superseded.'
        : 'Knowledge Space compilation is currently running.',
    });
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

function isSameSourceSnapshot(
  expected: {
    sourcePageId: string;
    sourceVersion: string;
    contentHash: string;
  },
  actual:
    | { sourcePageId: string; sourceVersion: string; contentHash: string }
    | undefined,
): boolean {
  return (
    actual?.sourcePageId === expected.sourcePageId &&
    actual.sourceVersion === expected.sourceVersion &&
    actual.contentHash === expected.contentHash
  );
}

function isFinalJobAttempt(job: Job): boolean {
  const maxAttempts = Math.max(Number(job.opts?.attempts ?? 1), 1);
  return Number(job.attemptsMade ?? 0) + 1 >= maxAttempts;
}

function classifyCompilationFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  stage?: 'image_enrichment';
} {
  if (error instanceof SourceChangedDuringCompilationError) {
    return {
      code: 'source_changed',
      message: 'Knowledge source changed during compilation.',
      retryable: true,
    };
  }
  if (error instanceof UnavailableKnowledgeSourceError) {
    return {
      code: 'source_unavailable',
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof ImageEnrichmentIncompleteError) {
    return {
      code: 'image_enrichment_unavailable',
      message: error.message,
      retryable: true,
      stage: 'image_enrichment',
    };
  }
  if (error instanceof KnowledgeCompilerLlmError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof KnowledgeCompilationValidationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'compile_failed',
    message: 'Knowledge compilation failed.',
    retryable: true,
  };
}

function noOpPageResult(
  data: IKnowledgeCompilePagesJob,
  startedAt: number,
): KnowledgeCompileJobResult {
  return {
    type: 'compile-pages',
    status: 'succeeded',
    workspaceId: data.workspaceId,
    spaceId: data.spaceId,
    compilerRunId: data.spaceRunId ?? 'no-op',
    sourceCount: 0,
    importedArtifactCount: 0,
    quarantinedArtifactCount: 0,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
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
