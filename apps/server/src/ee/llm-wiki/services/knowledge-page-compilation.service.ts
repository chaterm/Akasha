import { Inject, Injectable } from '@nestjs/common';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
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
import { KnowledgeAccessIndexerService } from './knowledge-access-indexer.service';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';
import { KnowledgeImageEnrichmentService } from './knowledge-image-enrichment.service';
import {
  buildEffectiveKnowledgeHash,
  ReadyKnowledgeImage,
} from './knowledge-effective-hash';
import {
  IKnowledgeCompilePagesJob,
  IKnowledgeMergePageImagesJob,
} from '../../../integrations/queue/constants/queue.interface';
import { KnowledgeCompileJobResult } from '../types/knowledge-queue.types';
import { KnowledgeArtifactCatalogEntry } from '../types/compiler-artifact.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import {
  KnowledgeComplexityLimitError,
  KnowledgeOperationBudget,
} from './knowledge-operation-budget';
import { uniqueValues } from './knowledge-queue.utils';

export type PageCompilationOutcome =
  | { outcome: 'succeeded' | 'noop'; result: KnowledgeCompileJobResult }
  | {
      outcome: 'failed';
      retryable: boolean;
      code: string;
      message: string;
      cause: unknown;
    };

export interface TextPageCompilationInput {
  data: IKnowledgeCompilePagesJob;
  compileTaskId: string;
  finalAttempt: boolean;
  startedAt?: number;
  execution?: TextPageExecutionContext;
}

export interface TextPageExecutionContext {
  isActive(): Promise<boolean>;
  markRunning?(): Promise<void>;
  completePage(input: {
    status: 'succeeded' | 'failed' | 'skipped';
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<unknown>;
  catalog(): Promise<KnowledgeArtifactCatalogEntry[]>;
  publicationGuard(trx: KyselyTransaction): Promise<boolean>;
}

export interface ImagePageMergeInput {
  data: IKnowledgeMergePageImagesJob;
  compileTaskId: string;
  finalAttempt: boolean;
  startedAt?: number;
}

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
export class KnowledgePageCompilationService {
  constructor(
    private readonly sourceExporter: KnowledgeSourceExporterService,
    @Inject(KNOWLEDGE_COMPILER_ADAPTER)
    private readonly compiler: KnowledgeCompilerAdapter,
    private readonly importService: KnowledgeImportService,
    private readonly accessIndexer: KnowledgeAccessIndexerService,
    private readonly compilationRepo: KnowledgeCompilationRepo,
    private readonly artifactCatalog: KnowledgeArtifactCatalogService,
    private readonly spaceCompilation: KnowledgeSpaceCompilationService,
    private readonly imageEnrichment: KnowledgeImageEnrichmentService,
  ) {}

  async compileTextPage(
    input: TextPageCompilationInput,
    abortSignal: AbortSignal,
  ): Promise<PageCompilationOutcome> {
    const { data, compileTaskId } = input;
    const startedAt = input.startedAt ?? Date.now();
    const sourcePageIds = uniqueValues(data.sourcePageIds);
    if (sourcePageIds.length !== 1) {
      return failureOutcome(
        false,
        'invalid_page_count',
        'Knowledge page compile requires exactly one source page.',
        new Error('Knowledge page compile requires exactly one source page.'),
      );
    }
    const sourcePageId = sourcePageIds[0];
    if (!(await this.isPageCompilationAllowed(data, input.execution))) {
      await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
      return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
    }

    const operationBudget = new KnowledgeOperationBudget({
      signal: abortSignal,
    });
    try {
      if (input.execution?.markRunning) {
        await input.execution.markRunning();
      } else if (data.spaceRunId) {
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
        abortSignal,
      });
      if (sources.length !== 1 || sources[0].sourcePageId !== sourcePageId) {
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
        await this.completeTextPage(input, sourcePageId, {
          status: 'skipped',
          errorCode: 'source_changed',
          errorMessage,
        });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }

      if (!source.text.trim() && exportedSource.images?.length) {
        await this.compilationRepo.skipAttempt({
          workspaceId: data.workspaceId,
          sourcePageId,
          compileTaskId,
          reasonCode: 'awaiting_images',
          reasonMessage:
            'Text phase completed; the page is awaiting image knowledge.',
        });
        if (data.spaceRunId || input.execution) {
          await this.completeTextPage(input, sourcePageId, {
            status: 'succeeded',
          });
        } else {
          await this.spaceCompilation.queueStandalonePageImages(exportedSource);
        }
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }

      if (!source.text.trim()) {
        const latestSources = await this.sourceExporter.exportPageSources({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          sourcePageIds,
        });
        if (!isSameSourceSnapshot(exportedSource, latestSources[0])) {
          await this.compilationRepo.skipAttempt({
            workspaceId: data.workspaceId,
            sourcePageId,
            compileTaskId,
            reasonCode: 'source_changed',
            reasonMessage:
              'Knowledge source changed before empty-source retirement.',
          });
          if (data.spaceRunId || input.execution) {
            await this.completeTextPage(input, sourcePageId, {
              status: 'skipped',
              errorCode: 'source_changed',
              errorMessage:
                'Knowledge source changed before empty-source retirement.',
            });
          }
          return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
        }
        if (!(await this.isPageCompilationAllowed(data, input.execution))) {
          await this.skipCancelledAttempt({
            data,
            sourcePageId,
            compileTaskId,
          });
          return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
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
          ...(data.spaceRunId || input.execution
            ? {
                publicationGuard: this.textPublicationGuard(
                  input,
                  sourcePageId,
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
          return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
        }
        await this.compilationRepo.skipAttempt({
          workspaceId: data.workspaceId,
          sourcePageId,
          compileTaskId,
          reasonCode: 'empty_source',
          reasonMessage: 'Knowledge source page is empty.',
        });
        if (data.spaceRunId || input.execution) {
          await this.completeTextPage(input, sourcePageId, {
            status: 'skipped',
            errorCode: 'empty_source',
            errorMessage: 'Knowledge source page is empty.',
          });
        } else if (exportedSource.images?.length) {
          await this.spaceCompilation.queueStandalonePageImages(exportedSource);
        }
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }

      const catalogEntries = input.execution
        ? await input.execution.catalog()
        : data.spaceRunId
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
      if (!(await this.isPageCompilationAllowed(data, input.execution))) {
        await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
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
        ...(data.spaceRunId || input.execution
          ? { publicationGuard: this.textPublicationGuard(input, sourcePageId) }
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
        abortSignal,
      });
      if (!isSameSourceSnapshot(exportedSource, latestSources[0])) {
        throw new SourceChangedDuringCompilationError();
      }
      if (!(await this.isPageCompilationAllowed(data, input.execution))) {
        await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }
      const importResult = await this.importService.importCompileResult({
        input: compileInput,
        artifacts: compileResult.artifacts,
        ...(data.spaceRunId || input.execution
          ? { publicationGuard: this.textPublicationGuard(input, sourcePageId) }
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
        await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
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
      if (data.spaceRunId || input.execution) {
        await this.completeTextPage(input, sourcePageId, {
          status: 'succeeded',
        });
      } else if (
        exportedSource.images?.length &&
        readyImages.length < exportedSource.images.length
      ) {
        await this.spaceCompilation.queueStandalonePageImages(exportedSource);
      }
      return {
        outcome: 'succeeded',
        result: {
          type: 'compile-pages',
          status: 'succeeded',
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerRunId: compileResult.compilerRunId,
          sourceCount: sources.length,
          importedArtifactCount: importResult.importedArtifactCount,
          quarantinedArtifactCount: importResult.quarantinedArtifactCount,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      };
    } catch (error) {
      if (
        (data.spaceRunId || input.execution) &&
        !(await this.isPageCompilationAllowed(data, input.execution))
      ) {
        await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }
      const failure = abortSignal.aborted
        ? pageTimeoutFailure()
        : classifyCompilationFailure(error);
      await this.compilationRepo.failAttempt({
        workspaceId: data.workspaceId,
        sourcePageId,
        compileTaskId,
        ...(failure.stage ? { stage: failure.stage } : {}),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (
        (data.spaceRunId || input.execution) &&
        (!failure.retryable || input.finalAttempt)
      ) {
        await this.completeTextPage(input, sourcePageId, {
          status: 'failed',
          errorCode: failure.code,
          errorMessage: failure.message,
        });
      }
      return failureOutcome(
        failure.retryable,
        failure.code,
        failure.message,
        error,
      );
    }
  }

  async mergePageImages(
    input: ImagePageMergeInput,
    abortSignal: AbortSignal,
  ): Promise<PageCompilationOutcome> {
    const { data, compileTaskId } = input;
    const startedAt = input.startedAt ?? Date.now();
    const operationBudget = new KnowledgeOperationBudget({
      signal: abortSignal,
    });
    if (data.spaceRunId) {
      const accepted = await this.spaceCompilation.beginPageMerge({
        runId: data.spaceRunId,
        sourcePageId: data.sourcePageId,
        sourceVersion: data.sourceVersion,
        sourceContentHash: data.sourceContentHash,
        knowledgeGeneration: data.knowledgeGeneration,
        effectiveKnowledgeHash: data.effectiveKnowledgeHash,
      });
      if (!accepted) {
        return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
      }
    } else if (!(await this.spaceCompilation.isPageImageJobCurrent(data))) {
      return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
    }

    const sources = await this.sourceExporter.exportPageSources({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageIds: [data.sourcePageId],
      abortSignal,
    });
    const exportedSource = sources[0];
    if (!isSameImageMergeSnapshot(data, exportedSource)) {
      if (data.spaceRunId) {
        await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
      }
      return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
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
        return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
      }
      const source = { ...ready.source, effectiveKnowledgeHash };
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
        abortSignal,
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
        return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
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
        outcome: 'succeeded',
        result: {
          type: 'compile-pages',
          status: 'succeeded',
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          compilerRunId: compileResult.compilerRunId,
          sourceCount: 1,
          importedArtifactCount: importResult.importedArtifactCount,
          quarantinedArtifactCount: importResult.quarantinedArtifactCount,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
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
        return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
      }
      const failure = abortSignal.aborted
        ? pageTimeoutFailure()
        : classifyCompilationFailure(error);
      await this.compilationRepo.failAttempt({
        workspaceId: data.workspaceId,
        sourcePageId: data.sourcePageId,
        compileTaskId,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (data.spaceRunId && (!failure.retryable || input.finalAttempt)) {
        await this.spaceCompilation.failPageMerge(mergeRunIdentity(data));
      }
      return failureOutcome(
        failure.retryable,
        failure.code,
        failure.message,
        error,
      );
    }
  }

  private textPublicationGuard(
    input: TextPageCompilationInput,
    sourcePageId: string,
  ) {
    if (input.execution) return input.execution.publicationGuard;
    const { data } = input;
    return (trx: KyselyTransaction) =>
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
      );
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
    execution?: TextPageExecutionContext,
  ): Promise<boolean> {
    if (execution) return execution.isActive();
    if (data.spaceRunId) return this.isSpaceRunActive(data);
    if (data.trigger !== 'retry_compile' && data.trigger !== 'page_update') {
      return true;
    }
    return !(await this.spaceCompilation.hasActiveRun({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
    }));
  }

  private async completeTextPage(
    input: TextPageCompilationInput,
    sourcePageId: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'skipped';
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    if (input.execution) {
      await input.execution.completePage(outcome);
      return;
    }
    await this.spaceCompilation.completePage({
      runId: input.data.spaceRunId!,
      sourcePageId,
      ...outcome,
    });
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
}

function isSameSourceSnapshot(
  expected: Pick<
    KnowledgeSourceSnapshot,
    'sourcePageId' | 'sourceVersion' | 'contentHash'
  >,
  actual: KnowledgeSourceSnapshot | undefined,
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
  const actualImages = actual.images ?? [];
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

function classifyCompilationFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  stage?: 'image_enrichment';
} {
  if (error instanceof SourceChangedDuringCompilationError) {
    return {
      code: 'source_changed',
      message: error.message,
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
  if (
    error instanceof KnowledgeCompilerLlmError ||
    error instanceof KnowledgeCompilationValidationError ||
    error instanceof KnowledgeComplexityLimitError
  ) {
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

function failureOutcome(
  retryable: boolean,
  code: string,
  message: string,
  cause: unknown,
): PageCompilationOutcome {
  return { outcome: 'failed', retryable, code, message, cause };
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
    ...noOpPageResult(
      {
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        sourcePageIds: [data.sourcePageId],
        spaceRunId: data.spaceRunId,
      },
      startedAt,
    ),
  };
}
