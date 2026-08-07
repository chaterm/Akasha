import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { KnowledgeImageEnrichmentService } from './knowledge-image-enrichment.service';
import {
  buildEffectiveKnowledgeHash,
  ReadyKnowledgeImage,
} from './knowledge-effective-hash';
import {
  KnowledgeImageMergePageData,
  KnowledgePageCompilationResult,
  KnowledgeTextPageData,
} from '../types/knowledge-page-compilation.types';
import { KnowledgeArtifactCatalogEntry } from '../types/compiler-artifact.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import {
  KnowledgeComplexityLimitError,
  KnowledgeOperationBudget,
} from './knowledge-operation-budget';
import { uniqueValues } from './knowledge-queue.utils';
import { KnowledgeEmbeddingError } from './knowledge-embedding-provider.service';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';

export type PageCompilationOutcome =
  | { outcome: 'succeeded' | 'noop'; result: KnowledgePageCompilationResult }
  | {
      outcome: 'failed';
      retryable: boolean;
      code: string;
      message: string;
      cause: unknown;
    };

export interface TextPageCompilationInput {
  data: KnowledgeTextPageData;
  compileTaskId: string;
  finalAttempt: boolean;
  startedAt?: number;
  execution: TextPageExecutionContext;
}

export interface TextPageExecutionContext {
  isActive(): Promise<boolean>;
  markRunning?(): Promise<void>;
  completePage(input: {
    status: 'succeeded' | 'failed' | 'skipped';
    qualityStatus?: 'normal' | 'degraded' | 'partial_image';
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<unknown>;
  catalog(): Promise<KnowledgeArtifactCatalogEntry[]>;
  publicationGuard(trx: KyselyTransaction): Promise<boolean>;
  bypassCache?(): Promise<boolean>;
}

export interface ImagePageMergeInput {
  data: KnowledgeImageMergePageData;
  compileTaskId: string;
  finalAttempt: boolean;
  startedAt?: number;
  execution: ImagePageExecutionContext;
}

export interface ImagePageExecutionContext {
  isActive(): Promise<boolean>;
  completePage(input: {
    status: 'failed' | 'skipped';
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<unknown>;
  catalog(): Promise<KnowledgeArtifactCatalogEntry[]>;
  publicationGuard(trx: KyselyTransaction): Promise<boolean>;
  publicationComplete(
    trx: KyselyTransaction,
    effectiveKnowledgeHash: string,
  ): Promise<boolean>;
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
  private readonly logger = new Logger(KnowledgePageCompilationService.name);

  constructor(
    private readonly sourceExporter: KnowledgeSourceExporterService,
    @Inject(KNOWLEDGE_COMPILER_ADAPTER)
    private readonly compiler: KnowledgeCompilerAdapter,
    private readonly importService: KnowledgeImportService,
    private readonly accessIndexer: KnowledgeAccessIndexerService,
    private readonly compilationRepo: KnowledgeCompilationRepo,
    private readonly imageEnrichment: KnowledgeImageEnrichmentService,
    @Optional()
    private readonly runRepo?: KnowledgeSpaceCompilationRepo,
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
    if (!(await input.execution.isActive())) {
      await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
      return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
    }

    const operationBudget = new KnowledgeOperationBudget({
      signal: abortSignal,
    });
    try {
      if (input.execution.markRunning) {
        await input.execution.markRunning();
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
        await this.completeTextPage(input, {
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
        await this.completeTextPage(input, { status: 'succeeded' });
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
          await this.completeTextPage(input, {
            status: 'skipped',
            errorCode: 'source_changed',
            errorMessage:
              'Knowledge source changed before empty-source retirement.',
          });
          return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
        }
        if (!(await input.execution.isActive())) {
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
          publicationGuard: input.execution.publicationGuard,
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
        await this.completeTextPage(input, {
          status: 'skipped',
          errorCode: 'empty_source',
          errorMessage: 'Knowledge source page is empty.',
        });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }

      const bypassCache = (await input.execution.bypassCache?.()) ?? false;
      const compilationRepo = this
        .compilationRepo as KnowledgeCompilationRepo & {
        hasLastSuccessfulPublication?: KnowledgeCompilationRepo['hasLastSuccessfulPublication'];
        markResultQuality?: KnowledgeCompilationRepo['markResultQuality'];
      };
      const hasLastSuccess =
        (await compilationRepo.hasLastSuccessfulPublication?.({
          workspaceId: data.workspaceId,
          spaceId: data.spaceId,
          sourcePageId,
        })) ?? false;
      // Prepared-import reuse is deliberately disabled. Its historical key did
      // not include the DB Top-K candidate set, so it could replay generation
      // produced from stale Catalog identities. Analysis has a complete cache
      // identity; generation is recomputed until a candidate-aware prepared
      // import key exists.
      const catalogEntries = await input.execution.catalog();
      if (!(await input.execution.isActive())) {
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
        bypassCache,
        hasLastSuccess,
        ...(catalogEntries ? { catalog: catalogEntries } : {}),
        sources,
        publicationGuard: input.execution.publicationGuard,
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
      if (!(await input.execution.isActive())) {
        await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }
      const importResult = await this.importService.importCompileResult({
        input: compileInput,
        artifacts: compileResult.artifacts,
        publicationGuard: input.execution.publicationGuard,
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
      const resultQuality = compileResult.resultQuality ?? 'normal';
      await compilationRepo.markResultQuality?.({
        workspaceId: data.workspaceId,
        sourcePageId,
        compileTaskId,
        quality: resultQuality,
      });
      await this.completeTextPage(input, {
        status: 'succeeded',
        qualityStatus: resultQuality,
      });
      if (
        resultQuality === 'degraded' &&
        (compileResult.generationAttemptCount ?? 3) < 3
      ) {
        await this.runRepo?.requestRuns({
          requests: [
            {
              workspaceId: data.workspaceId,
              spaceId: data.spaceId,
              trigger: 'page_retry',
              targetSourcePageIds: [sourcePageId],
            },
          ],
          compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
          promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        });
      }
      return {
        outcome: 'succeeded',
        result: {
          type: 'text',
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
      if (!(await input.execution.isActive())) {
        await this.skipCancelledAttempt({ data, sourcePageId, compileTaskId });
        return { outcome: 'noop', result: noOpPageResult(data, startedAt) };
      }
      const failure = abortSignal.aborted
        ? pageTimeoutFailure()
        : classifyCompilationFailure(error);
      this.logCompilerDiagnostic(error, {
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        sourcePageId,
        compileTaskId,
        failureCode: failure.code,
        retryable: failure.retryable,
      });
      await this.compilationRepo.failAttempt({
        workspaceId: data.workspaceId,
        sourcePageId,
        compileTaskId,
        ...(failure.stage ? { stage: failure.stage } : {}),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (!failure.retryable || input.finalAttempt) {
        await this.completeTextPage(input, {
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
    if (!(await input.execution.isActive())) {
      return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
    }

    const sources = await this.sourceExporter.exportPageSources({
      workspaceId: data.workspaceId,
      spaceId: data.spaceId,
      sourcePageIds: [data.sourcePageId],
      abortSignal,
    });
    const exportedSource = sources[0];
    if (!isSameImageMergeSnapshot(data, exportedSource, true)) {
      await this.completeImageMergePage(input, {
        status: 'failed',
        errorCode: 'source_changed',
        errorMessage: 'Page source or frozen image snapshot changed.',
      });
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
      const frozenSource = { ...exportedSource, images: data.images };
      const ready = await this.imageEnrichment.readReadySource(frozenSource);
      const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
        sourceContentHash: exportedSource.contentHash,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        readyImages: ready.readyImages,
      });
      if (ready.readyImages.length === 0) {
        await this.compilationRepo.skipAttempt({
          workspaceId: data.workspaceId,
          sourcePageId: data.sourcePageId,
          compileTaskId,
          reasonCode: 'image_snapshot_changed',
          reasonMessage: 'Page image knowledge changed before merge.',
        });
        await this.completeImageMergePage(input, {
          status: 'skipped',
          errorCode: 'image_snapshot_changed',
          errorMessage: 'Page image knowledge changed before merge.',
        });
        return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
      }
      const source = { ...ready.source, effectiveKnowledgeHash };
      const catalog = await input.execution.catalog();
      const compileInput = {
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        compileTaskId,
        compileMode: 'pages' as const,
        ...(catalog ? { catalog } : {}),
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
      if (!isSameImageMergeSnapshot(data, latest[0], true)) {
        throw new SourceChangedDuringCompilationError();
      }
      const importResult = await this.importService.importCompileResult({
        input: compileInput,
        artifacts: compileResult.artifacts,
        publicationGuard: input.execution.publicationGuard,
        onStage: async (stage) => {
          await this.compilationRepo.updateStage({
            workspaceId: data.workspaceId,
            sourcePageId: data.sourcePageId,
            compileTaskId,
            stage,
          });
        },
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
          const completed = await input.execution.publicationComplete(
            trx,
            effectiveKnowledgeHash,
          );
          if (!completed) throw new SourceChangedDuringCompilationError();
        },
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
      await this.accessIndexer.reindexSourcePages({
        workspaceId: data.workspaceId,
        sourcePageIds: [data.sourcePageId],
      });
      return {
        outcome: 'succeeded',
        result: {
          type: 'image_merge',
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
        await this.completeImageMergePage(input, {
          status: 'failed',
          errorCode: 'source_changed',
          errorMessage: error.message,
        });
        return { outcome: 'noop', result: noOpMergeResult(data, startedAt) };
      }
      const failure = abortSignal.aborted
        ? pageTimeoutFailure()
        : classifyCompilationFailure(error);
      this.logCompilerDiagnostic(error, {
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        sourcePageId: data.sourcePageId,
        compileTaskId,
        failureCode: failure.code,
        retryable: failure.retryable,
      });
      await this.compilationRepo.failAttempt({
        workspaceId: data.workspaceId,
        sourcePageId: data.sourcePageId,
        compileTaskId,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      if (!failure.retryable || input.finalAttempt) {
        await this.completeImageMergePage(input, {
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

  private async completeImageMergePage(
    input: ImagePageMergeInput,
    outcome: {
      status: 'failed' | 'skipped';
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await input.execution.completePage(outcome);
  }

  private async completeTextPage(
    input: TextPageCompilationInput,
    outcome: {
      status: 'succeeded' | 'failed' | 'skipped';
      qualityStatus?: 'normal' | 'degraded' | 'partial_image';
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await input.execution.completePage(outcome);
  }

  private async skipCancelledAttempt(input: {
    data: KnowledgeTextPageData;
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

  private logCompilerDiagnostic(
    error: unknown,
    context: {
      workspaceId: string;
      spaceId: string;
      sourcePageId: string;
      compileTaskId: string;
      failureCode: string;
      retryable: boolean;
    },
  ): void {
    if (!(error instanceof KnowledgeCompilerLlmError)) return;
    if (!error.diagnostic && !error.diagnosticClass) return;
    this.logger.warn({
      message: 'Knowledge compiler provider failure diagnostic',
      ...context,
      diagnosticClass: error.diagnosticClass,
      providerDiagnostic: error.diagnostic,
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
  expected: KnowledgeImageMergePageData,
  actual: KnowledgeSourceSnapshot | undefined,
  allowAdditionalImages = false,
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
    (allowAdditionalImages
      ? actualImages.length >= expectedImages.length
      : expectedImages.length === actualImages.length) &&
    expectedImages.every(
      (image, index) =>
        image.attachmentId === actualImages[index]?.attachmentId &&
        image.attachmentVersion === actualImages[index]?.attachmentVersion,
    )
  );
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
    error instanceof KnowledgeEmbeddingError ||
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
  data: KnowledgeTextPageData,
  startedAt: number,
): KnowledgePageCompilationResult {
  return {
    type: 'text',
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
  data: KnowledgeImageMergePageData,
  startedAt: number,
): KnowledgePageCompilationResult {
  return {
    ...noOpPageResult(
      {
        workspaceId: data.workspaceId,
        spaceId: data.spaceId,
        sourcePageIds: [data.sourcePageId],
        spaceRunId: data.spaceRunId,
        knowledgeGeneration: data.knowledgeGeneration,
      },
      startedAt,
    ),
    type: 'image_merge',
  };
}
