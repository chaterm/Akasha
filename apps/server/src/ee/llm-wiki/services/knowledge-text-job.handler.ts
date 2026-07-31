import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
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
} from './knowledge-import.service';
import {
  IKnowledgeCompileSpaceJob,
  IKnowledgeCompilePagesJob,
  IKnowledgeMergePageImagesJob,
  IKnowledgeAggregateSpaceJob,
  IKnowledgeRebuildEmbeddingsJob,
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
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import {
  buildKnowledgeCompileCoalesceKey,
  buildKnowledgeCompilePageJobId,
  buildKnowledgeRebuildEmbeddingsContinuationJobId,
  buildKnowledgeReindexAccessContinuationJobId,
  buildReviewDiscoverJobId,
  buildReviewNegotiateJobId,
  KNOWLEDGE_COMPILE_DELAY_MS,
  KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
  uniqueValues,
} from './knowledge-queue.utils';
import { KnowledgeCompileJobResult } from '../types/knowledge-queue.types';
import { ReviewService } from '../review/review.service';
import { ReviewSnapshotService } from '../review/review-snapshot.service';
import { KnowledgeArtifactWikiSource } from '../review/knowledge-artifact-wiki-source';
import { MockSearchProvider } from '../review/search-provider';
import { isDeepSearch, ResolvedReview } from '../review/approval';
import { NegotiationTurn, reviewItemSchema } from '../review/review.schema';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeSpaceAggregatorService } from './knowledge-space-aggregator.service';
import { KnowledgeImageEnrichmentService } from './knowledge-image-enrichment.service';
import {
  buildEffectiveKnowledgeHash,
  ReadyKnowledgeImage,
} from './knowledge-effective-hash';
import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  KnowledgeComplexityLimitError,
  KnowledgeOperationBudget,
  createBoundedAbortSignal,
} from './knowledge-operation-budget';
import {
  KnowledgePageCompilationService,
  PageCompilationOutcome,
} from './knowledge-page-compilation.service';

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

@Injectable()
export class KnowledgeTextJobHandler {
  private readonly logger = new Logger(KnowledgeTextJobHandler.name);

  constructor(
    private readonly sourceExporter: KnowledgeSourceExporterService,
    @Inject(KNOWLEDGE_COMPILER_ADAPTER)
    private readonly compiler: KnowledgeCompilerAdapter,
    private readonly importService: KnowledgeImportService,
    private readonly accessIndexer: KnowledgeAccessIndexerService,
    private readonly sourceRepo: KnowledgeSourceRepo,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly pageRepo: PageRepo,
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE)
    private readonly textQueue: Queue,
    private readonly reviewService: ReviewService,
    private readonly reviewSnapshotService: ReviewSnapshotService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly reviewApplicationRepo: KnowledgeReviewApplicationRepo,
    private readonly compilationRepo: KnowledgeCompilationRepo,
    private readonly artifactCatalog: KnowledgeArtifactCatalogService,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly spaceAggregator: KnowledgeSpaceAggregatorService,
    private readonly imageEnrichment: KnowledgeImageEnrichmentService,
    private readonly vectorIndex: KnowledgeVectorIndexService = undefined as never,
    private readonly environmentService: EnvironmentService = undefined as never,
    pageCompilation?: KnowledgePageCompilationService,
  ) {
    this.pageCompilation =
      pageCompilation ??
      new KnowledgePageCompilationService(
        sourceExporter,
        compiler,
        importService,
        accessIndexer,
        compilationRepo,
        artifactCatalog,
        spaceCompilation,
        imageEnrichment,
      );
  }

  private readonly pageCompilation: KnowledgePageCompilationService;

  async handle(
    job: Job,
  ): Promise<
    | KnowledgeCompileJobResult
    | ReviewProcessorJobResult
    | KnowledgeEmbeddingRebuildJobResult
    | void
  > {
    switch (job.name) {
      case QueueJob.KNOWLEDGE_COMPILE_SPACE: {
        const data = job.data as IKnowledgeCompileSpaceJob;
        const startedAt = Date.now();
        const sources = await this.sourceExporter.exportSpaceSources({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
        });
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
        try {
          const result = await this.spaceAggregator.aggregate({
            runId: data.spaceRunId,
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            phase: data.phase ?? 'initial_aggregate',
          });
          await this.spaceCompilation.dispatchPending();
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
          this.logProviderFailure(error, {
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            compileTaskId: String(job.id ?? data.spaceRunId),
          });
          const terminal = !failure.retryable || isFinalJobAttempt(job);
          await this.spaceCompilation.failAggregation({
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
        const extractedData = job.data as IKnowledgeCompilePagesJob;
        const extractedSourcePageIds = uniqueValues(
          extractedData.sourcePageIds,
        );
        const extractedSourcePageId = extractedSourcePageIds[0] ?? 'invalid';
        const extractedCompileTaskId = String(
          job.id ??
            buildKnowledgeCompilePageJobId({
              workspaceId: extractedData.workspaceId,
              spaceId: extractedData.spaceId,
              sourcePageId: extractedSourcePageId,
            }),
        );
        const extractedDeadline = createBoundedAbortSignal(
          undefined,
          this.environmentService?.getKnowledgePageDeadlineMs?.() ?? 900_000,
        );
        try {
          const outcome = await this.pageCompilation.compileTextPage(
            {
              data: extractedData,
              compileTaskId: extractedCompileTaskId,
              finalAttempt: isFinalJobAttempt(job),
            },
            extractedDeadline.signal,
          );
          if (outcome.outcome === 'failed') {
            this.logProviderFailure(outcome.cause, {
              workspaceId: extractedData.workspaceId,
              spaceId: extractedData.spaceId,
              sourcePageId: extractedSourcePageId,
              compileTaskId: extractedCompileTaskId,
            });
          }
          return unwrapPageCompilationOutcome(outcome);
        } finally {
          extractedDeadline.dispose();
        }

        /* istanbul ignore next -- removed with the legacy queue in Task 8 */
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
        const pageDeadline = createBoundedAbortSignal(
          undefined,
          this.environmentService?.getKnowledgePageDeadlineMs?.() ?? 900_000,
        );
        const operationBudget = new KnowledgeOperationBudget({
          signal: pageDeadline.signal,
        });
        try {
          if (data.spaceRunId) {
            await this.spaceCompilation.markPageRunning({
              runId: data.spaceRunId,
              sourcePageId,
            });
          }
          await this.compilationRepo.startAttempt({
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
            abortSignal: pageDeadline.signal,
          });
          if (
            sources.length !== 1 ||
            sources[0].sourcePageId !== sourcePageId
          ) {
            throw new UnavailableKnowledgeSourceError();
          }
          const exportedSource = sources[0];
          let source = exportedSource;
          let readyImages: ReadyKnowledgeImage[] = [];
          if ((source.images?.length ?? 0) > 0) {
            const ready = await this.imageEnrichment.readReadySource(source);
            source = ready.source;
            readyImages = ready.readyImages;
            sources[0] = source;
          }
          const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
            sourceContentHash: exportedSource.contentHash,
            compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
            promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
            readyImages,
          });
          source = { ...source, effectiveKnowledgeHash };
          sources[0] = source;
          await this.compilationRepo.updateSourceSnapshot({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            sourceVersion: exportedSource.sourceVersion,
            sourceContentHash: exportedSource.contentHash,
            effectiveKnowledgeHash,
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
            await this.compilationRepo.skipAttempt({
              workspaceId: data.workspaceId,
              sourcePageId,
              compileTaskId,
              reasonCode: 'source_changed',
              reasonMessage: errorMessage,
            });
            await this.spaceCompilation.completePage({
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
          if (!source.text.trim() && exportedSource.images?.length) {
            const errorMessage =
              'Text phase completed; the page is awaiting image knowledge.';
            await this.compilationRepo.skipAttempt({
              workspaceId: data.workspaceId,
              sourcePageId,
              compileTaskId,
              reasonCode: 'awaiting_images',
              reasonMessage: errorMessage,
            });
            if (data.spaceRunId) {
              await this.spaceCompilation.completePage({
                runId: data.spaceRunId,
                sourcePageId,
                status: 'succeeded',
              });
            } else {
              await this.spaceCompilation.queueStandalonePageImages(
                exportedSource,
              );
            }
            return noOpPageResult(data, startedAt);
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
              await this.compilationRepo.skipAttempt({
                workspaceId: data.workspaceId,
                sourcePageId,
                compileTaskId,
                reasonCode: 'source_changed',
                reasonMessage: sourceChangedMessage,
              });
              if (data.spaceRunId) {
                await this.spaceCompilation.completePage({
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
                      this.spaceCompilation.isRunActiveForPublication(
                        {
                          runId: data.spaceRunId!,
                          workspaceId: data.workspaceId,
                          spaceId: data.spaceId,
                          knowledgeGeneration: data.knowledgeGeneration,
                          allowedPhases: ['text', 'images'],
                          sourcePageId,
                          sourceVersion: data.sourceVersion,
                          sourceContentHash: data.sourceContentHash,
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
            await this.compilationRepo.skipAttempt({
              workspaceId: data.workspaceId,
              sourcePageId,
              compileTaskId,
              reasonCode: 'empty_source',
              reasonMessage: errorMessage,
            });
            if (data.spaceRunId) {
              await this.spaceCompilation.completePage({
                runId: data.spaceRunId,
                sourcePageId,
                status: 'skipped',
                errorCode: 'empty_source',
                errorMessage,
              });
            }
            if (!data.spaceRunId && exportedSource.images?.length) {
              await this.spaceCompilation.queueStandalonePageImages(
                exportedSource,
              );
            }
            return noOpPageResult(data, startedAt);
          }
          const catalogEntries = data.spaceRunId
            ? await this.spaceCompilation.catalogForPage({
                runId: data.spaceRunId,
                workspaceId: data.workspaceId,
                spaceId: data.spaceId,
              })
            : (
                await this.artifactCatalog.snapshot({
                  workspaceId: data.workspaceId,
                  spaceId: data.spaceId,
                })
              ).entries;
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
            ...(data.spaceRunId
              ? {
                  publicationGuard: (trx: KyselyTransaction) =>
                    this.spaceCompilation.isRunActiveForPublication(
                      {
                        runId: data.spaceRunId!,
                        workspaceId: data.workspaceId,
                        spaceId: data.spaceId,
                        knowledgeGeneration: data.knowledgeGeneration,
                        allowedPhases: ['text', 'images'],
                        sourcePageId,
                        sourceVersion: exportedSource.sourceVersion,
                        sourceContentHash: exportedSource.contentHash,
                      },
                      trx,
                    ),
                }
              : {}),
            operationBudget,
          };
          const compileResult = await this.compiler.compileSpace(compileInput);
          await this.compilationRepo.updateStage({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            stage: 'validation',
          });
          const latestSources = await this.sourceExporter.exportPageSources({
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            sourcePageIds,
            abortSignal: pageDeadline.signal,
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
                    this.spaceCompilation.isRunActiveForPublication(
                      {
                        runId: data.spaceRunId!,
                        workspaceId: data.workspaceId,
                        spaceId: data.spaceId,
                        knowledgeGeneration: data.knowledgeGeneration,
                        allowedPhases: ['text', 'images'],
                        sourcePageId,
                        sourceVersion: data.sourceVersion,
                        sourceContentHash: data.sourceContentHash,
                      },
                      trx,
                    ),
                }
              : {}),
            onStage: async (stage) => {
              await this.compilationRepo.updateStage({
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
          await this.compilationRepo.succeedAttempt({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            sourceVersion: exportedSource.sourceVersion,
            sourceContentHash: exportedSource.contentHash,
            effectiveKnowledgeHash,
          });
          if (data.spaceRunId) {
            await this.spaceCompilation.completePage({
              runId: data.spaceRunId,
              sourcePageId,
              status: 'succeeded',
            });
          } else if (
            exportedSource.images?.length &&
            readyImages.length < exportedSource.images.length
          ) {
            await this.spaceCompilation.queueStandalonePageImages(
              exportedSource,
            );
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
          const failure = pageDeadline.signal.aborted
            ? pageTimeoutFailure()
            : classifyCompilationFailure(error);
          this.logProviderFailure(error, {
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
            sourcePageId,
            compileTaskId,
          });
          await this.compilationRepo.failAttempt({
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
            await this.spaceCompilation.completePage({
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
        } finally {
          pageDeadline.dispose();
        }
      }
      case QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES: {
        const pageDeadline = createBoundedAbortSignal(
          undefined,
          this.environmentService?.getKnowledgePageDeadlineMs?.() ?? 900_000,
        );
        const operationBudget = new KnowledgeOperationBudget({
          signal: pageDeadline.signal,
        });
        try {
          const data = job.data as IKnowledgeMergePageImagesJob;
          const outcome = await this.pageCompilation.mergePageImages(
            {
              data,
              compileTaskId: String(job.id ?? 'knowledge-image-merge'),
              finalAttempt: isFinalJobAttempt(job),
            },
            operationBudget.signal,
          );
          return unwrapPageCompilationOutcome(outcome);
        } finally {
          pageDeadline.dispose();
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

  async onFailed(job: Job): Promise<void> {
    if (
      job.name !== QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES ||
      !isFinalJobAttempt(job)
    ) {
      return;
    }
    const data = job.data as IKnowledgeMergePageImagesJob;
    if (!data.spaceRunId) return;
    await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
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

  private async handlePageImageMerge(
    job: Job,
    operationBudget: KnowledgeOperationBudget,
  ): Promise<KnowledgeCompileJobResult> {
    const data = job.data as IKnowledgeMergePageImagesJob;
    const startedAt = Date.now();
    const compileTaskId = String(job.id ?? 'knowledge-image-merge');
    if (data.spaceRunId) {
      const accepted = await this.spaceCompilation.beginPageMerge({
        runId: data.spaceRunId,
        sourcePageId: data.sourcePageId,
        sourceVersion: data.sourceVersion,
        sourceContentHash: data.sourceContentHash,
        knowledgeGeneration: data.knowledgeGeneration,
        effectiveKnowledgeHash: data.effectiveKnowledgeHash,
      });
      if (!accepted) return noOpMergeResult(data, startedAt);
    } else if (!(await this.spaceCompilation.isPageImageJobCurrent(data))) {
      return noOpMergeResult(data, startedAt);
    }

    const sources = await this.sourceExporter.exportPageSources({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageIds: [data.sourcePageId],
      abortSignal: operationBudget.signal,
    });
    const exportedSource = sources[0];
    if (!isSameImageMergeSnapshot(data, exportedSource)) {
      if (data.spaceRunId) {
        await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
      }
      return noOpMergeResult(data, startedAt);
    }

    await this.compilationRepo.startAttempt({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageId: data.sourcePageId,
      sourceVersion: data.sourceVersion,
      sourceContentHash: data.sourceContentHash,
      effectiveKnowledgeHash: data.effectiveKnowledgeHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      compilerRunId: data.spaceRunId ?? compileTaskId,
      compileTaskId,
    });

    try {
      const ready = await this.imageEnrichment.readReadySource(exportedSource);
      const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
        sourceContentHash: exportedSource.contentHash,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        readyImages: ready.readyImages,
      });
      if (
        ready.readyImages.length === 0 ||
        effectiveKnowledgeHash !== data.effectiveKnowledgeHash
      ) {
        await this.compilationRepo.skipAttempt({
          workspaceId: data.workspaceId,
          sourcePageId: data.sourcePageId,
          compileTaskId,
          reasonCode: 'image_snapshot_changed',
          reasonMessage: 'Page image knowledge changed before merge.',
        });
        if (data.spaceRunId) {
          await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
        }
        return noOpMergeResult(data, startedAt);
      }
      const source = {
        ...ready.source,
        effectiveKnowledgeHash,
      };
      const catalog = data.spaceRunId
        ? await this.spaceCompilation.catalogForPage({
            runId: data.spaceRunId,
            workspaceId: data.workspaceId,
            spaceId: data.spaceId,
          })
        : (
            await this.artifactCatalog.snapshot({
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
            })
          ).entries;
      const compileInput = {
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        compileTaskId,
        compileMode: 'pages' as const,
        catalog,
        sources: [source],
        operationBudget,
      };
      const compileResult = await this.compiler.compileSpace(compileInput);
      const latest = await this.sourceExporter.exportPageSources({
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        sourcePageIds: [data.sourcePageId],
        abortSignal: operationBudget.signal,
      });
      if (!isSameImageMergeSnapshot(data, latest[0])) {
        throw new SourceChangedDuringCompilationError();
      }
      const importResult = await this.importService.importCompileResult({
        input: compileInput,
        artifacts: compileResult.artifacts,
        ...(data.spaceRunId
          ? {
              publicationGuard: (trx: KyselyTransaction) =>
                this.spaceCompilation.isRunActiveForPublication(
                  {
                    runId: data.spaceRunId!,
                    workspaceId: data.workspaceId,
                    spaceId: data.spaceId,
                    knowledgeGeneration: data.knowledgeGeneration,
                    allowedPhases: ['images'],
                    sourcePageId: data.sourcePageId,
                    sourceVersion: data.sourceVersion,
                    sourceContentHash: data.sourceContentHash,
                  },
                  trx,
                ),
              publicationComplete: async (trx: KyselyTransaction) => {
                await this.compilationRepo.succeedAttempt(
                  {
                    workspaceId: data.workspaceId,
                    sourcePageId: data.sourcePageId,
                    compileTaskId,
                    sourceVersion: data.sourceVersion,
                    sourceContentHash: data.sourceContentHash,
                    effectiveKnowledgeHash,
                  },
                  trx,
                );
                const completed =
                  await this.spaceCompilation.completePageMergePublication(
                    {
                      runId: data.spaceRunId!,
                      sourcePageId: data.sourcePageId,
                      sourceVersion: data.sourceVersion,
                      sourceContentHash: data.sourceContentHash,
                      knowledgeGeneration: data.knowledgeGeneration,
                      mergedEffectiveKnowledgeHash: effectiveKnowledgeHash,
                    },
                    trx,
                  );
                if (!completed) throw new SourceChangedDuringCompilationError();
              },
            }
          : {}),
      });
      if (importResult.skippedReason === 'run_superseded') {
        await this.compilationRepo.skipAttempt({
          workspaceId: data.workspaceId,
          sourcePageId: data.sourcePageId,
          compileTaskId,
          reasonCode: 'run_superseded',
          reasonMessage: 'Knowledge Space run was superseded.',
        });
        return noOpMergeResult(data, startedAt);
      }
      if (!data.spaceRunId) {
        await this.compilationRepo.succeedAttempt({
          workspaceId: data.workspaceId,
          sourcePageId: data.sourcePageId,
          compileTaskId,
          sourceVersion: data.sourceVersion,
          sourceContentHash: data.sourceContentHash,
          effectiveKnowledgeHash,
        });
      }
      await this.accessIndexer.reindexSourcePages({
        workspaceId: data.workspaceId,
        sourcePageIds: [data.sourcePageId],
      });
      if (data.spaceRunId) await this.spaceCompilation.dispatchPending();
      return {
        type: 'compile-pages',
        status: 'succeeded',
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        compilerRunId: compileResult.compilerRunId,
        sourceCount: 1,
        importedArtifactCount: importResult.importedArtifactCount,
        quarantinedArtifactCount: importResult.quarantinedArtifactCount,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      if (error instanceof SourceChangedDuringCompilationError) {
        await this.compilationRepo.skipAttempt({
          workspaceId: data.workspaceId,
          sourcePageId: data.sourcePageId,
          compileTaskId,
          reasonCode: 'source_changed',
          reasonMessage: error.message,
        });
        if (data.spaceRunId) {
          await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
        }
        return noOpMergeResult(data, startedAt);
      }
      const failure = operationBudget.signal?.aborted
        ? pageTimeoutFailure()
        : classifyCompilationFailure(error);
      await this.compilationRepo.failAttempt({
        workspaceId: data.workspaceId,
        sourcePageId: data.sourcePageId,
        compileTaskId,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (data.spaceRunId && (!failure.retryable || isFinalJobAttempt(job))) {
        await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
      }
      if (!failure.retryable) throw new UnrecoverableError(failure.message);
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
      await this.compilationRepo.queueAttempt({
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
      await this.textQueue.add(
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
    return this.spaceCompilation.isRunActive({
      runId: data.spaceRunId,
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
    });
  }

  private async isPageCompilationAllowed(
    data: IKnowledgeCompilePagesJob,
  ): Promise<boolean> {
    if (data.spaceRunId) return this.isSpaceRunActive(data);
    if (data.trigger !== 'retry_compile' && data.trigger !== 'page_update') {
      return true;
    }
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
    await this.compilationRepo.skipAttempt({
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

  private logProviderFailure(
    error: unknown,
    context: {
      workspaceId: string;
      spaceId: string;
      sourcePageId?: string;
      compileTaskId: string;
    },
  ): void {
    if (!(error instanceof KnowledgeCompilerLlmError) || !error.diagnostic) {
      return;
    }
    const {
      stage,
      wrapperName,
      upstreamName,
      upstreamCode,
      statusCode,
      providerCode,
      providerType,
      requestId,
      retryReason,
      sdkAttempts,
      providerRetryable,
    } = error.diagnostic;
    this.logger.error({
      event: 'knowledge_compiler_provider_failure',
      ...context,
      errorCode: error.code,
      retryable: error.retryable,
      ...(stage ? { stage } : {}),
      ...(wrapperName ? { wrapperName } : {}),
      ...(upstreamName ? { upstreamName } : {}),
      ...(upstreamCode ? { upstreamCode } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(providerCode ? { providerCode } : {}),
      ...(providerType ? { providerType } : {}),
      ...(requestId ? { requestId } : {}),
      ...(retryReason ? { retryReason } : {}),
      ...(sdkAttempts !== undefined ? { sdkAttempts } : {}),
      ...(providerRetryable !== undefined ? { providerRetryable } : {}),
    });
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

function isSameImageMergeSnapshot(
  expected: IKnowledgeMergePageImagesJob,
  actual: KnowledgeSourceSnapshot | undefined,
): boolean {
  if (
    !actual ||
    actual.sourcePageId !== expected.sourcePageId ||
    actual.sourceVersion !== expected.sourceVersion ||
    actual.contentHash !== expected.sourceContentHash
  ) {
    return false;
  }
  const expectedImages = expected.images ?? [];
  const actualImages = actual?.images ?? [];
  return (
    expectedImages.length === actualImages.length &&
    expectedImages.every(
      (image, index) =>
        image.attachmentId === actualImages[index]?.attachmentId &&
        image.attachmentVersion === actualImages[index]?.attachmentVersion,
    )
  );
}

function mergeRunIdentity(data: IKnowledgeMergePageImagesJob) {
  return {
    runId: data.spaceRunId!,
    sourcePageId: data.sourcePageId,
    sourceVersion: data.sourceVersion,
    sourceContentHash: data.sourceContentHash,
    knowledgeGeneration: data.knowledgeGeneration,
  };
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
  if (error instanceof KnowledgeComplexityLimitError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return pageTimeoutFailure();
  }
  return {
    code: 'compile_failed',
    message: 'Knowledge compilation failed.',
    retryable: true,
  };
}

function pageTimeoutFailure(): {
  code: string;
  message: string;
  retryable: boolean;
  stage?: 'image_enrichment';
} {
  return {
    code: 'page_timeout',
    message: 'Knowledge page execution deadline exceeded.',
    retryable: false,
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

function noOpMergeResult(
  data: IKnowledgeMergePageImagesJob,
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

function unwrapPageCompilationOutcome(
  outcome: PageCompilationOutcome,
): KnowledgeCompileJobResult {
  if (outcome.outcome !== 'failed') return outcome.result;
  if (!outcome.retryable) throw new UnrecoverableError(outcome.message);
  throw outcome.cause;
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
