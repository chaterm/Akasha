import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import {
  CurrentReadyKnowledgeImageExtraction,
  KnowledgeImageExtractionRepo,
} from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import {
  buildKnowledgeAggregateSpaceJobId,
  buildKnowledgeCompilePageJobId,
  buildKnowledgeCompilePageImagesJobId,
  buildKnowledgeMergePageImagesJobId,
  buildKnowledgeRetryPageJobId,
  KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
} from './knowledge-queue.utils';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeArtifactCatalogEntry } from '../types/compiler-artifact.types';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  buildEffectiveKnowledgeHash,
  ReadyKnowledgeImage,
} from './knowledge-effective-hash';
import { knowledgeImageJobOptions } from './knowledge-worker-settings';

@Injectable()
export class KnowledgeSpaceCompilationService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeSpaceCompilationService.name);
  private dispatching = false;

  constructor(
    @InjectQueue(QueueName.KNOWLEDGE_SPACE_QUEUE)
    private readonly spaceQueue: Queue,
    @InjectQueue(QueueName.KNOWLEDGE_IMAGE_QUEUE)
    private readonly imageQueue: Queue,
    private readonly runRepo: KnowledgeSpaceCompilationRepo,
    private readonly compilationRepo: KnowledgeCompilationRepo,
    private readonly catalogService: KnowledgeArtifactCatalogService,
    private readonly sourceRepo: KnowledgeSourceRepo,
    private readonly imageExtractionRepo: KnowledgeImageExtractionRepo,
    private readonly capsuleRepo: KnowledgeCapsuleRepo,
    private readonly contributionRepo: KnowledgeArtifactContributionRepo,
    private readonly environmentService: EnvironmentService,
    private readonly sourceExporter: KnowledgeSourceExporterService,
    executionRepo?: KnowledgeSpaceExecutionRepo,
  ) {
    this.executionRepo = executionRepo;
  }

  private readonly executionRepo?: KnowledgeSpaceExecutionRepo;

  async onModuleInit(): Promise<void> {
    await this.dispatchPending();
  }

  @Interval('knowledge-space-compile-outbox', 5_000)
  async recoverPendingDispatches(): Promise<void> {
    await this.dispatchPending();
  }

  async requestRuns(
    requests: Array<{
      workspaceId: string;
      spaceId: string;
      trigger: string;
      confirmationSpaceName?: string;
      removedSourcePageIds?: string[];
      scanRemovedSources?: boolean;
    }>,
  ) {
    const results = await this.runRepo.requestRuns({
      requests,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    });
    for (const result of results) {
      if (result.disposition !== 'rejected') continue;
      if (result.reason === 'space_name_mismatch') {
        throw new ConflictException(
          'Space name confirmation no longer matches.',
        );
      }
      throw new NotFoundException('Space not found.');
    }
    await this.dispatchPending();
    return results;
  }

  async requestIncrementalCompileForPages(input: {
    workspaceId: string;
    sourcePageIds: string[];
    removed?: boolean;
  }) {
    const results = await this.runRepo.requestIncrementalCompileForPages({
      workspaceId: input.workspaceId,
      sourcePageIds: input.sourcePageIds,
      trigger: 'page_update',
      removed: input.removed ?? false,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    });
    await this.dispatchPending();
    return results;
  }

  async initializeLeasedRun(lease: SpaceExecutionLease) {
    if (!this.executionRepo) {
      throw new Error(
        'KnowledgeSpaceExecutionRepo is required for Space jobs.',
      );
    }
    const run = await this.executionRepo.findLeasedRun(lease);
    if (!run) return undefined;
    const scope = { workspaceId: run.workspaceId, spaceId: run.spaceId };
    const sources = await this.sourceExporter.exportSpaceSources(scope);
    const sourcePageIds = sources.map((source) => source.sourcePageId);
    const snapshotImages = sources.flatMap((source) =>
      (source.images ?? []).map((image) => ({
        sourcePageId: source.sourcePageId,
        attachmentId: image.attachmentId,
        attachmentVersion: image.attachmentVersion,
      })),
    );
    const [
      catalog,
      aggregateFingerprint,
      reuseCandidates,
      activeSourcePageIds,
      contributionSourcePageIds,
      readyExtractions,
      latestAggregateRun,
      hasActiveOverview,
    ] = await Promise.all([
      this.catalogService.snapshot(scope),
      this.catalogService.aggregateFingerprint(scope),
      this.compilationRepo.findSpaceReuseCandidates({
        ...scope,
        sourcePageIds,
      }),
      this.sourceRepo.findActiveSourcePageIdsBySpace(scope),
      this.contributionRepo.findSpaceSourcePageIds(scope),
      this.imageExtractionRepo.findCurrentReadyForSnapshotImages({
        ...scope,
        images: snapshotImages,
        model: this.environmentService.getAiVisionModel().trim(),
        promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
      }),
      this.runRepo.findLatestCompletedRunForAggregateReuse({
        ...scope,
        currentRunId: run.id,
      }),
      this.capsuleRepo.hasActiveSpaceOverview(scope),
    ]);
    const currentSourcePageIds = new Set(sourcePageIds);
    const removedSourcePageIds = [
      ...new Set([...activeSourcePageIds, ...contributionSourcePageIds]),
    ].filter((sourcePageId) => !currentSourcePageIds.has(sourcePageId));
    const remainingSourcesAffectedByRemoval = new Set(
      removedSourcePageIds.length > 0
        ? await this.contributionRepo.findRemainingSourcePageIdsForRemovedSources(
            { ...scope, removedSourcePageIds },
          )
        : [],
    );
    const candidateByPageId = new Map(
      reuseCandidates.map((candidate) => [candidate.sourcePageId, candidate]),
    );
    const readyExtractionByAttachmentId = currentReadyExtractionMap(
      sources,
      readyExtractions,
      this.environmentService.getAiVisionModel().trim(),
    );
    const planned = sources.map((source) => {
      const expectedImages = source.images ?? [];
      const sourceImages = expectedImages.slice(0, 50);
      const overflowImageCount = Math.max(
        0,
        expectedImages.length - sourceImages.length,
      );
      const readyImages = sourceImages.flatMap(
        (image): ReadyKnowledgeImage[] => {
          const extraction = readyExtractionByAttachmentId.get(
            image.attachmentId,
          );
          return extraction
            ? [
                {
                  attachmentId: image.attachmentId,
                  attachmentVersion: image.attachmentVersion,
                  cacheFingerprint: extraction.cacheFingerprint,
                  contentHash: extraction.contentHash,
                  ocrText: extraction.ocrText ?? '',
                  caption: extraction.caption ?? '',
                },
              ]
            : [];
        },
      );
      const allImagesReady = readyImages.length === sourceImages.length;
      const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
        sourceContentHash: source.contentHash,
        compilerVersion: run.compilerVersion,
        promptVersion: run.promptVersion,
        readyImages,
      });
      const candidate = candidateByPageId.get(source.sourcePageId);
      const reusable =
        !remainingSourcesAffectedByRemoval.has(source.sourcePageId) &&
        allImagesReady &&
        Boolean(candidate?.activeSourceId) &&
        Boolean(candidate?.activeSummaryId) &&
        Boolean(candidate?.activeSummaryChunkId) &&
        candidate?.lastSuccessfulSourceVersion === source.sourceVersion &&
        candidate?.lastSuccessfulSourceHash === source.contentHash &&
        candidate?.contributionSourceVersion === source.sourceVersion &&
        candidate?.contributionSourceHash === source.contentHash &&
        candidate?.contributionCompilerVersion === run.compilerVersion &&
        candidate?.contributionPromptVersion === run.promptVersion &&
        candidate?.lastSuccessfulEffectiveHash === effectiveKnowledgeHash;
      return {
        source,
        sourceImages,
        expectedImageCount: expectedImages.length,
        overflowImageCount,
        readyImages,
        reusable,
        effectiveKnowledgeHash,
      };
    });
    const pageCompilationRequired = planned.some((item) => !item.reusable);
    const aggregateReusable =
      !pageCompilationRequired &&
      removedSourcePageIds.length === 0 &&
      Boolean(hasActiveOverview) &&
      Boolean(latestAggregateRun) &&
      latestAggregateRun!.compilerVersion === run.compilerVersion &&
      latestAggregateRun!.promptVersion === run.promptVersion &&
      latestAggregateRun!.knowledgeGeneration ===
        latestAggregateRun!.currentKnowledgeGeneration &&
      latestAggregateRun!.catalogHash === aggregateFingerprint.hash;

    const initialized = await this.executionRepo.initializeRun(lease, {
      catalogSnapshot: catalog.entries as unknown as JsonValue,
      catalogHash: aggregateFingerprint.hash,
      removedSourcePageIds,
      pages: planned.map((item) => ({
        sourcePageId: item.source.sourcePageId,
        expectedSourceVersion: item.source.sourceVersion,
        expectedSourceContentHash: item.source.contentHash,
        expectedImageCount: item.expectedImageCount,
        succeededImageCount: item.reusable
          ? item.expectedImageCount
          : item.readyImages.length,
        skippedImageCount: item.reusable ? 0 : item.overflowImageCount,
        status: item.reusable ? ('skipped' as const) : ('pending' as const),
        imageStatus:
          item.expectedImageCount === 0
            ? ('not_required' as const)
            : item.reusable
              ? ('succeeded' as const)
              : item.readyImages.length === item.sourceImages.length
                ? item.overflowImageCount > 0
                  ? ('partial' as const)
                  : ('succeeded' as const)
                : ('pending' as const),
        mergeStatus:
          item.expectedImageCount === 0
            ? ('not_required' as const)
            : item.reusable
              ? ('succeeded' as const)
              : item.readyImages.length === item.sourceImages.length
                ? ('pending' as const)
                : ('waiting_images' as const),
        errorCode: item.reusable ? 'unchanged' : null,
        errorMessage: item.reusable
          ? 'Existing compiled knowledge is current.'
          : null,
        targetEffectiveKnowledgeHash: item.effectiveKnowledgeHash,
      })),
      images: planned.flatMap((item) =>
        item.reusable
          ? []
          : item.sourceImages.map((image, imageOrdinal) => {
              const ready = readyExtractionByAttachmentId.get(
                image.attachmentId,
              );
              return {
                sourcePageId: item.source.sourcePageId,
                attachmentId: image.attachmentId,
                imageOrdinal,
                fileName: image.fileName,
                mimeType: image.mimeType,
                fileSize: image.fileSize,
                altText: image.altText,
                expectedAttachmentVersion: image.attachmentVersion,
                status: ready ? ('succeeded' as const) : ('pending' as const),
                extractionId: ready?.id ?? null,
              };
            }),
      ),
    });
    if (!initialized) return undefined;
    return {
      ...initialized,
      aggregateRequired: !aggregateReusable,
      pageCompilationRequired,
    };
  }

  async startSpaceRun(input: {
    workspaceId: string;
    spaceId: string;
    trigger: string;
    mode?: 'incremental' | 'force_rebuild';
    confirmationSpaceName?: string;
    requestedAt?: Date;
    sources: KnowledgeSourceSnapshot[];
  }) {
    const scope = {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    };
    const sourcePageIds = input.sources.map((source) => source.sourcePageId);
    const snapshotImages = input.sources.flatMap((source) =>
      (source.images ?? []).map((image) => ({
        sourcePageId: source.sourcePageId,
        attachmentId: image.attachmentId,
        attachmentVersion: image.attachmentVersion,
      })),
    );
    const [
      catalog,
      aggregateFingerprint,
      reuseCandidates,
      activeSourcePageIds,
      contributionSourcePageIds,
      readyExtractions,
      latestAggregateRun,
      hasActiveOverview,
    ] = await Promise.all([
      this.catalogService.snapshot(scope),
      this.catalogService.aggregateFingerprint(scope),
      this.compilationRepo.findSpaceReuseCandidates({
        ...scope,
        sourcePageIds,
      }),
      this.sourceRepo.findActiveSourcePageIdsBySpace(scope),
      this.contributionRepo.findSpaceSourcePageIds(scope),
      this.imageExtractionRepo.findCurrentReadyForSnapshotImages({
        ...scope,
        images: snapshotImages,
        model: this.environmentService.getAiVisionModel().trim(),
        promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
      }),
      this.runRepo.findLatestRunForAggregateReuse(scope),
      this.capsuleRepo.hasActiveSpaceOverview(scope),
    ]);
    const currentSourcePageIds = new Set(sourcePageIds);
    const knownSourcePageIds = new Set([
      ...activeSourcePageIds,
      ...contributionSourcePageIds,
    ]);
    const removedSourcePageIds = [...knownSourcePageIds].filter(
      (sourcePageId) => !currentSourcePageIds.has(sourcePageId),
    );
    const remainingSourcesAffectedByRemoval = new Set(
      removedSourcePageIds.length > 0
        ? await this.contributionRepo.findRemainingSourcePageIdsForRemovedSources(
            {
              ...scope,
              removedSourcePageIds,
            },
          )
        : [],
    );
    const candidateByPageId = new Map(
      reuseCandidates.map((candidate) => [candidate.sourcePageId, candidate]),
    );
    const readyExtractionByAttachmentId = currentReadyExtractionMap(
      input.sources,
      readyExtractions,
      this.environmentService.getAiVisionModel().trim(),
    );
    const plannedSources = input.sources.map((source) => {
      const sourceImages = source.images ?? [];
      const readyImages = sourceImages.flatMap(
        (image): ReadyKnowledgeImage[] => {
          const extraction = readyExtractionByAttachmentId.get(
            image.attachmentId,
          );
          if (!extraction) return [];
          return [
            {
              attachmentId: image.attachmentId,
              attachmentVersion: image.attachmentVersion,
              cacheFingerprint: extraction.cacheFingerprint,
              contentHash: extraction.contentHash,
              ocrText: extraction.ocrText ?? '',
              caption: extraction.caption ?? '',
            },
          ];
        },
      );
      const allImagesReady = readyImages.length === sourceImages.length;
      const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
        sourceContentHash: source.contentHash,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        readyImages,
      });
      const candidate = candidateByPageId.get(source.sourcePageId);
      const reusable =
        !remainingSourcesAffectedByRemoval.has(source.sourcePageId) &&
        allImagesReady &&
        Boolean(candidate?.activeSourceId) &&
        Boolean(candidate?.activeSummaryId) &&
        Boolean(candidate?.activeSummaryChunkId) &&
        candidate?.lastSuccessfulSourceVersion === source.sourceVersion &&
        candidate?.lastSuccessfulSourceHash === source.contentHash &&
        candidate?.contributionSourceVersion === source.sourceVersion &&
        candidate?.contributionSourceHash === source.contentHash &&
        candidate?.contributionCompilerVersion ===
          DEFAULT_KNOWLEDGE_COMPILER_VERSION &&
        candidate?.contributionPromptVersion ===
          DEFAULT_KNOWLEDGE_PROMPT_VERSION &&
        candidate?.lastSuccessfulEffectiveHash === effectiveKnowledgeHash;
      const hasImages = sourceImages.length > 0;
      return {
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
        status: reusable ? ('skipped' as const) : ('pending' as const),
        errorCode: reusable ? 'unchanged' : null,
        errorMessage: reusable
          ? 'Existing compiled knowledge is current.'
          : null,
        expectedImageCount: sourceImages.length,
        succeededImageCount: readyImages.length,
        failedImageCount: 0,
        imageStatus: hasImages
          ? reusable
            ? ('succeeded' as const)
            : ('pending' as const)
          : ('not_required' as const),
        mergeStatus: hasImages
          ? reusable
            ? ('succeeded' as const)
            : ('waiting_images' as const)
          : ('not_required' as const),
        targetEffectiveKnowledgeHash: effectiveKnowledgeHash,
      };
    });
    const pageCompilationRequired = plannedSources.some(
      (source) => source.status === 'pending',
    );
    const aggregateReusable =
      !pageCompilationRequired &&
      removedSourcePageIds.length === 0 &&
      Boolean(hasActiveOverview) &&
      (latestAggregateRun?.status === 'succeeded' ||
        latestAggregateRun?.status === 'partial') &&
      latestAggregateRun?.phase === 'complete' &&
      latestAggregateRun.compilerVersion ===
        DEFAULT_KNOWLEDGE_COMPILER_VERSION &&
      latestAggregateRun.promptVersion === DEFAULT_KNOWLEDGE_PROMPT_VERSION &&
      latestAggregateRun.knowledgeGeneration ===
        latestAggregateRun.currentKnowledgeGeneration &&
      latestAggregateRun.catalogHash === aggregateFingerprint.hash;
    const aggregateRequired = !aggregateReusable;
    const createResult = await this.runRepo.createRun({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      trigger: input.trigger,
      mode: input.mode,
      confirmationSpaceName: input.confirmationSpaceName,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      catalogSnapshot: catalog.entries as unknown as JsonValue,
      catalogHash: aggregateFingerprint.hash,
      requestedAt: input.requestedAt,
      aggregateRequired,
      sources: plannedSources,
      ...(removedSourcePageIds.length > 0
        ? {
            retireRemovedSources: async (trx: KyselyTransaction) => {
              const retirementInput = {
                ...scope,
                sourcePageIds: removedSourcePageIds,
              };
              await this.sourceRepo.markSpaceSourcesStale(retirementInput, trx);
              const retired =
                await this.contributionRepo.deleteSpaceSourceContributions(
                  retirementInput,
                  trx,
                );
              if (retired.orphanedArtifactIds.length > 0) {
                await this.capsuleRepo.markArtifactsStaleByIds(
                  {
                    ...scope,
                    artifactIds: retired.orphanedArtifactIds,
                  },
                  trx,
                );
              }
            },
          }
        : {}),
    });
    if (createResult.created === false) {
      if (createResult.reason === 'space_name_mismatch') {
        throw new ConflictException(
          'Space name confirmation no longer matches.',
        );
      }
      if (createResult.reason === 'space_not_found') {
        throw new NotFoundException('Space not found.');
      }
      return null;
    }
    const { run, supersededJobIds } = createResult;
    await this.removeSupersededJobs(supersededJobIds);
    await this.dispatchPending();
    return run;
  }

  async hasActiveRun(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<boolean> {
    return this.runRepo.hasActiveRun(input);
  }

  async isRunActive(input: {
    runId: string;
    workspaceId: string;
    spaceId: string;
  }): Promise<boolean> {
    return this.runRepo.isRunActive(input);
  }

  async isRunActiveForPublication(
    input: Parameters<
      KnowledgeSpaceCompilationRepo['isRunActiveForPublication']
    >[0],
    trx: KyselyTransaction,
  ): Promise<boolean> {
    return this.runRepo.isRunActiveForPublication(input, trx);
  }

  async queuePageRetry(source: KnowledgeSourceSnapshot): Promise<string> {
    const jobId = buildKnowledgeRetryPageJobId({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceContentHash: source.contentHash,
    });
    await this.compilationRepo.queueAttempt({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceVersion: source.sourceVersion,
      sourceContentHash: source.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      compilerRunId: jobId,
      compileTaskId: jobId,
    });
    await this.spaceQueue.add(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
        sourcePageIds: [source.sourcePageId],
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
        trigger: 'retry_compile',
      },
      {
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
        },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return jobId;
  }

  async markPageRunning(input: {
    runId: string;
    sourcePageId: string;
  }): Promise<void> {
    await this.runRepo.markPageRunning(input);
  }

  async beginPageImages(input: {
    runId?: string;
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
    sourceVersion: string;
    sourceContentHash: string;
    knowledgeGeneration: number;
    images: KnowledgeSourceSnapshot['images'];
  }): Promise<boolean> {
    if (!input.runId) return this.isPageImageJobCurrent(input);
    return this.runRepo.beginPageImages({
      runId: input.runId,
      sourcePageId: input.sourcePageId,
      sourceVersion: input.sourceVersion,
      sourceContentHash: input.sourceContentHash,
      knowledgeGeneration: input.knowledgeGeneration,
    });
  }

  async isPageImageJobCurrent(input: {
    runId?: string;
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
    sourceVersion: string;
    sourceContentHash: string;
    knowledgeGeneration: number;
    images: KnowledgeSourceSnapshot['images'];
  }): Promise<boolean> {
    const generation = await this.runRepo.getSpaceKnowledgeGeneration(input);
    if (generation !== input.knowledgeGeneration) return false;
    if (
      input.runId &&
      !(await this.runRepo.isRunActiveForImageWork({
        runId: input.runId,
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        sourcePageId: input.sourcePageId,
        sourceVersion: input.sourceVersion,
        sourceContentHash: input.sourceContentHash,
        knowledgeGeneration: input.knowledgeGeneration,
      }))
    ) {
      return false;
    }
    const sources = await this.sourceExporter.exportPageSources({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      sourcePageIds: [input.sourcePageId],
    });
    return isSameImageSnapshot(input, sources[0]);
  }

  async recordPageImageAttempt(
    input: Parameters<
      KnowledgeSpaceCompilationRepo['recordPageImageAttempt']
    >[0],
  ): Promise<boolean> {
    return this.runRepo.recordPageImageAttempt(input);
  }

  async completePageImages(
    input: Parameters<KnowledgeSpaceCompilationRepo['completePageImages']>[0],
  ): Promise<boolean> {
    const completed = await this.runRepo.completePageImages(input);
    if (completed) await this.dispatchPending();
    return completed;
  }

  async claimRunImage(
    input: Parameters<KnowledgeSpaceCompilationRepo['claimRunImage']>[0],
  ) {
    return this.runRepo.claimRunImage(input);
  }

  async completeRunImage(
    input: Parameters<KnowledgeSpaceCompilationRepo['completeRunImage']>[0],
  ) {
    const completed = await this.runRepo.completeRunImage(input);
    if (completed) await this.dispatchPending();
    return completed;
  }

  async beginPageMerge(
    input: Parameters<KnowledgeSpaceCompilationRepo['beginPageMerge']>[0],
  ): Promise<boolean> {
    return this.runRepo.beginPageMerge(input);
  }

  async completePageMergePublication(
    input: Parameters<
      KnowledgeSpaceCompilationRepo['completePageMergePublication']
    >[0],
    trx: KyselyTransaction,
  ): Promise<boolean> {
    return this.runRepo.completePageMergePublication(input, trx);
  }

  async failPageMerge(
    input: Parameters<KnowledgeSpaceCompilationRepo['failPageMerge']>[0],
  ): Promise<boolean> {
    const failed = await this.runRepo.failPageMerge(input);
    if (failed) await this.dispatchPending();
    return failed;
  }

  async queueStandalonePageImages(
    source: KnowledgeSourceSnapshot,
  ): Promise<string | undefined> {
    if (!source.images?.length) return undefined;
    const knowledgeGeneration =
      await this.runRepo.getSpaceKnowledgeGeneration(source);
    if (knowledgeGeneration === undefined) return undefined;
    const jobId = buildKnowledgeCompilePageImagesJobId({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceContentHash: source.contentHash,
      knowledgeGeneration,
    });
    await this.imageQueue.add(
      QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES,
      {
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
        knowledgeGeneration,
        images: source.images,
      },
      knowledgeImageJobOptions(jobId),
    );
    return jobId;
  }

  async queueStandalonePageMerge(
    source: KnowledgeSourceSnapshot,
  ): Promise<string | undefined> {
    const knowledgeGeneration =
      await this.runRepo.getSpaceKnowledgeGeneration(source);
    if (knowledgeGeneration === undefined) return undefined;
    const merge = await this.resolveMergeInput(source);
    if (merge.readyImages.length === 0) return undefined;
    const jobId = buildKnowledgeMergePageImagesJobId({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      sourcePageId: source.sourcePageId,
      sourceContentHash: source.contentHash,
      effectiveKnowledgeHash: merge.effectiveKnowledgeHash,
      knowledgeGeneration,
    });
    await this.spaceQueue.add(
      QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES,
      {
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        sourceContentHash: source.contentHash,
        effectiveKnowledgeHash: merge.effectiveKnowledgeHash,
        knowledgeGeneration,
        images: source.images ?? [],
      },
      mergeJobOptions(jobId),
    );
    return jobId;
  }

  async catalogForPage(input: {
    runId: string;
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeArtifactCatalogEntry[]> {
    const run = await this.runRepo.findRun(input.runId);
    if (
      !run ||
      run.workspaceId !== input.workspaceId ||
      run.spaceId !== input.spaceId
    ) {
      throw new KnowledgeCompilerLlmError(
        'configuration_error',
        'Knowledge Space run catalog is unavailable.',
        false,
      );
    }
    if (!Array.isArray(run.catalogSnapshot)) return [];
    return (run.catalogSnapshot as unknown[]).filter(isCatalogEntry);
  }

  async completePage(input: {
    runId: string;
    sourcePageId: string;
    status: 'succeeded' | 'failed' | 'skipped';
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    const result = await this.runRepo.completePage(input);
    if (result?.aggregationReady) {
      await this.dispatchPending();
    }
  }

  async failAggregation(input: {
    runId: string;
    errorCode: string;
    errorMessage: string;
    terminal: boolean;
  }): Promise<void> {
    await this.runRepo.failAggregation(input);
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.dispatchPendingSpaceSlices();
      await this.dispatchPendingRunImages();
      return;

      // The legacy page/aggregate outbox remains reachable only in tests and
      // until Task 8 removes the old queue consumers. Production always injects
      // the shared Space queue and must never fan out a new Run by page.
      const pages = this.spaceQueue
        ? ([] as Awaited<
            ReturnType<
              KnowledgeSpaceCompilationRepo['findPendingPageDispatches']
            >
          >)
        : await this.runRepo.findPendingPageDispatches();
      for (const page of pages) {
        const jobId = buildKnowledgeCompilePageJobId({
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          sourcePageId: page.sourcePageId,
          runKey: page.runId,
        });
        try {
          await this.compilationRepo.queueAttempt({
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            sourcePageId: page.sourcePageId,
            sourceVersion: page.expectedSourceVersion,
            sourceContentHash: page.expectedSourceContentHash,
            compilerVersion: page.compilerVersion,
            promptVersion: page.promptVersion,
            compilerRunId: page.runId,
            compileTaskId: jobId,
          });
          await this.spaceQueue.add(
            QueueJob.KNOWLEDGE_COMPILE_PAGES,
            {
              workspaceId: page.workspaceId,
              spaceId: page.spaceId,
              sourcePageIds: [page.sourcePageId],
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              spaceRunId: page.runId,
              knowledgeGeneration: page.knowledgeGeneration,
              trigger: page.trigger,
            },
            {
              jobId,
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
              },
            },
          );
          const accepted = await this.runRepo.markPageQueued({
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            jobId,
          });
          if (!accepted) {
            await this.removeRejectedOutboxJob(jobId);
            await this.compilationRepo.skipAttempt({
              workspaceId: page.workspaceId,
              sourcePageId: page.sourcePageId,
              compileTaskId: jobId,
              reasonCode: 'run_superseded',
              reasonMessage:
                'Knowledge Space run was superseded before dispatch.',
            });
          }
        } catch (error) {
          this.logger.warn(
            `Knowledge page outbox dispatch will retry for run ${page.runId}.`,
          );
        }
      }

      const runs = this.spaceQueue
        ? ([] as Awaited<
            ReturnType<
              KnowledgeSpaceCompilationRepo['findAggregatePendingRuns']
            >
          >)
        : await this.runRepo.findAggregatePendingRuns();
      for (const run of runs) {
        const phase =
          run.phase === 'final_aggregate'
            ? ('final_aggregate' as const)
            : ('initial_aggregate' as const);
        const jobId = buildKnowledgeAggregateSpaceJobId({
          runId: run.id,
          phase,
        });
        try {
          await this.spaceQueue.add(
            QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
            {
              workspaceId: run.workspaceId,
              spaceId: run.spaceId,
              spaceRunId: run.id,
              knowledgeGeneration: run.knowledgeGeneration,
              phase,
            },
            {
              jobId,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1_000 },
            },
          );
          const accepted = await this.runRepo.markAggregationQueued({
            runId: run.id,
            phase,
            jobId,
          });
          if (!accepted) {
            await this.removeRejectedOutboxJob(jobId);
          }
        } catch (error) {
          this.logger.warn(
            `Knowledge aggregate outbox dispatch will retry for run ${run.id}.`,
          );
        }
      }

      const imagePages = this.spaceQueue
        ? ([] as Awaited<
            ReturnType<
              KnowledgeSpaceCompilationRepo['findPendingImageDispatches']
            >
          >)
        : await this.runRepo.findPendingImageDispatches();
      for (const page of imagePages) {
        try {
          const sources = await this.sourceExporter.exportPageSources({
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            sourcePageIds: [page.sourcePageId],
          });
          const source = sources[0];
          if (
            !source ||
            source.sourceVersion !== page.expectedSourceVersion ||
            source.contentHash !== page.expectedSourceContentHash ||
            !source.images?.length
          ) {
            await this.runRepo.completePageImages({
              runId: page.runId,
              sourcePageId: page.sourcePageId,
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              knowledgeGeneration: page.knowledgeGeneration,
              status: 'partial',
              expected: source?.images?.length ?? 0,
              succeeded: 0,
              failed: 0,
              skipped: source?.images?.length ?? 0,
            });
            continue;
          }
          const jobId = buildKnowledgeCompilePageImagesJobId({
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            sourceContentHash: page.expectedSourceContentHash,
            knowledgeGeneration: page.knowledgeGeneration,
          });
          await this.imageQueue.add(
            QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES,
            {
              workspaceId: page.workspaceId,
              spaceId: page.spaceId,
              sourcePageId: page.sourcePageId,
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              spaceRunId: page.runId,
              knowledgeGeneration: page.knowledgeGeneration,
              images: source.images,
            },
            knowledgeImageJobOptions(jobId),
          );
          const accepted = await this.runRepo.markPageImageQueued({
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            sourceVersion: page.expectedSourceVersion,
            sourceContentHash: page.expectedSourceContentHash,
            knowledgeGeneration: page.knowledgeGeneration,
            jobId,
          });
          if (!accepted) await this.removeRejectedImageOutboxJob(jobId);
        } catch {
          this.logger.warn(
            `Knowledge image outbox dispatch will retry for run ${page.runId}.`,
          );
        }
      }

      const mergePages = this.spaceQueue
        ? ([] as Awaited<
            ReturnType<
              KnowledgeSpaceCompilationRepo['findPendingMergeDispatches']
            >
          >)
        : await this.runRepo.findPendingMergeDispatches();
      for (const page of mergePages) {
        try {
          const sources = await this.sourceExporter.exportPageSources({
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            sourcePageIds: [page.sourcePageId],
          });
          const source = sources[0];
          if (
            !source ||
            source.sourceVersion !== page.expectedSourceVersion ||
            source.contentHash !== page.expectedSourceContentHash ||
            !source.images?.length
          ) {
            await this.runRepo.failPageMerge({
              runId: page.runId,
              sourcePageId: page.sourcePageId,
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              knowledgeGeneration: page.knowledgeGeneration,
            });
            continue;
          }
          const merge = await this.resolveMergeInput(source);
          if (merge.readyImages.length === 0) {
            await this.runRepo.failPageMerge({
              runId: page.runId,
              sourcePageId: page.sourcePageId,
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              knowledgeGeneration: page.knowledgeGeneration,
            });
            continue;
          }
          const jobId = buildKnowledgeMergePageImagesJobId({
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            sourceContentHash: page.expectedSourceContentHash,
            effectiveKnowledgeHash: merge.effectiveKnowledgeHash,
            knowledgeGeneration: page.knowledgeGeneration,
          });
          await this.spaceQueue.add(
            QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES,
            {
              workspaceId: page.workspaceId,
              spaceId: page.spaceId,
              sourcePageId: page.sourcePageId,
              sourceVersion: page.expectedSourceVersion,
              sourceContentHash: page.expectedSourceContentHash,
              effectiveKnowledgeHash: merge.effectiveKnowledgeHash,
              spaceRunId: page.runId,
              knowledgeGeneration: page.knowledgeGeneration,
              images: source.images,
            },
            mergeJobOptions(jobId),
          );
          const accepted = await this.runRepo.markPageMergeQueued({
            runId: page.runId,
            sourcePageId: page.sourcePageId,
            sourceVersion: page.expectedSourceVersion,
            sourceContentHash: page.expectedSourceContentHash,
            knowledgeGeneration: page.knowledgeGeneration,
            effectiveKnowledgeHash: merge.effectiveKnowledgeHash,
            jobId,
          });
          if (!accepted) await this.removeRejectedOutboxJob(jobId);
        } catch {
          this.logger.warn(
            `Knowledge image merge outbox dispatch will retry for run ${page.runId}.`,
          );
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatchPendingSpaceSlices(): Promise<void> {
    const candidates = await this.runRepo.findSpaceSliceReservationCandidates();
    for (const candidate of candidates) {
      await this.runRepo.reserveNextSpaceSlice({ runId: candidate.id });
    }
    const slices = await this.runRepo.findUndispatchedSpaceSlices();
    for (const slice of slices) {
      const jobName =
        slice.jobPhase === 'text'
          ? QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT
          : QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES;
      try {
        await this.spaceQueue!.add(
          jobName,
          {
            workspaceId: slice.workspaceId,
            spaceId: slice.spaceId,
            spaceRunId: slice.runId,
            knowledgeGeneration: slice.knowledgeGeneration,
            phase: slice.jobPhase,
            spaceJobSequence: slice.spaceJobSequence,
          },
          {
            jobId: slice.spaceJobId,
            priority: slice.jobPhase === 'image_merge' ? 1 : 5,
          },
        );
        await this.runRepo.markSpaceSliceDispatched(slice);
      } catch {
        this.logger.warn(
          `Knowledge Space outbox dispatch will retry reservation ${slice.spaceJobId}.`,
        );
      }
    }
  }

  private async dispatchPendingRunImages(): Promise<void> {
    await this.runRepo.reserveRunImagesFairly({
      maxOutstandingPerRun: 5,
      runLimit: 100,
    });
    const images = await this.runRepo.findUndispatchedRunImages();
    for (const image of images) {
      try {
        await this.imageQueue.add(
          QueueJob.KNOWLEDGE_COMPILE_IMAGE,
          {
            workspaceId: image.workspaceId,
            spaceId: image.spaceId,
            spaceRunId: image.runId,
            runImageId: image.runImageId,
            knowledgeGeneration: image.knowledgeGeneration,
          },
          knowledgeImageJobOptions(image.jobId!),
        );
        await this.runRepo.markRunImageDispatched({
          ...image,
          jobId: image.jobId!,
        });
      } catch {
        this.logger.warn(
          `Knowledge image outbox dispatch will retry RunImage ${image.runImageId}.`,
        );
      }
    }
  }

  private async removeSupersededJobs(jobIds: string[]): Promise<void> {
    for (const jobId of [...new Set(jobIds)]) {
      try {
        for (const queue of [this.spaceQueue, this.imageQueue]) {
          const job = await queue.getJob(jobId);
          if (!job) continue;
          const state = await job.getState();
          if (isRemovableSupersededJobState(state)) {
            await job.remove();
          }
        }
      } catch (error) {
        this.logger.warn(
          `Unable to cancel superseded knowledge job ${jobId}; worker fencing will prevent publication.`,
        );
      }
    }
  }

  private async removeRejectedOutboxJob(jobId: string): Promise<void> {
    try {
      const job = await this.spaceQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      if (isRemovableSupersededJobState(state)) {
        await job.remove();
      }
    } catch (error) {
      this.logger.warn(
        `Unable to cancel rejected knowledge outbox job ${jobId}; worker fencing will prevent publication.`,
      );
    }
  }

  private async removeRejectedImageOutboxJob(jobId: string): Promise<void> {
    try {
      const job = await this.imageQueue.getJob(jobId);
      if (!job) return;
      const state = await job.getState();
      if (isRemovableSupersededJobState(state)) await job.remove();
    } catch {
      this.logger.warn(
        `Unable to cancel rejected knowledge image job ${jobId}; worker fencing will prevent publication.`,
      );
    }
  }

  private async resolveMergeInput(source: KnowledgeSourceSnapshot): Promise<{
    effectiveKnowledgeHash: string;
    readyImages: ReadyKnowledgeImage[];
  }> {
    const rows =
      await this.imageExtractionRepo.findCurrentReadyForSnapshotImages({
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
        images: (source.images ?? []).map((image) => ({
          sourcePageId: source.sourcePageId,
          attachmentId: image.attachmentId,
          attachmentVersion: image.attachmentVersion,
        })),
        model: this.environmentService.getAiVisionModel().trim(),
        promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
      });
    const byAttachmentId = currentReadyExtractionMap(
      [source],
      rows,
      this.environmentService.getAiVisionModel().trim(),
    );
    const readyImages = (source.images ?? []).flatMap(
      (image): ReadyKnowledgeImage[] => {
        const row = byAttachmentId.get(image.attachmentId);
        if (!row) return [];
        return [
          {
            attachmentId: image.attachmentId,
            attachmentVersion: image.attachmentVersion,
            cacheFingerprint: row.cacheFingerprint,
            contentHash: row.contentHash,
            ocrText: row.ocrText ?? '',
            caption: row.caption ?? '',
          },
        ];
      },
    );
    return {
      readyImages,
      effectiveKnowledgeHash: buildEffectiveKnowledgeHash({
        sourceContentHash: source.contentHash,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        readyImages,
      }),
    };
  }
}

function mergeJobOptions(jobId: string) {
  return {
    jobId,
    delay: 1_000,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 1_000 },
  };
}

function isSameImageSnapshot(
  expected: {
    sourcePageId: string;
    sourceVersion: string;
    sourceContentHash: string;
    images: KnowledgeSourceSnapshot['images'];
  },
  actual?: KnowledgeSourceSnapshot,
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

function isRemovableSupersededJobState(state: string): boolean {
  return state === 'waiting' || state === 'delayed' || state === 'paused';
}

function isCatalogEntry(
  value: unknown,
): value is KnowledgeArtifactCatalogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.artifactId === 'string' &&
    typeof entry.artifactKind === 'string' &&
    typeof entry.canonicalKey === 'string' &&
    typeof entry.title === 'string' &&
    (entry.summary === undefined || typeof entry.summary === 'string')
  );
}

function currentReadyExtractionMap(
  sources: KnowledgeSourceSnapshot[],
  rows: CurrentReadyKnowledgeImageExtraction[],
  expectedModel?: string,
): Map<string, CurrentReadyKnowledgeImageExtraction> {
  if (!expectedModel) return new Map();
  const expected = new Map(
    sources.flatMap((source) =>
      (source.images ?? []).map(
        (image) =>
          [
            image.attachmentId,
            {
              workspaceId: source.workspaceId,
              spaceId: source.spaceId,
              sourcePageId: source.sourcePageId,
              attachmentVersion: image.attachmentVersion,
            },
          ] as const,
      ),
    ),
  );
  const ready = new Map<string, CurrentReadyKnowledgeImageExtraction>();
  for (const row of rows) {
    const image = expected.get(row.attachmentId);
    if (
      !image ||
      ready.has(row.attachmentId) ||
      row.workspaceId !== image.workspaceId ||
      row.attachmentWorkspaceId !== image.workspaceId ||
      row.attachmentSpaceId !== image.spaceId ||
      row.attachmentPageId !== image.sourcePageId ||
      row.attachmentVersion?.toISOString() !== image.attachmentVersion ||
      row.currentAttachmentVersion.toISOString() !== image.attachmentVersion ||
      row.status !== 'ready' ||
      row.model !== expectedModel ||
      row.promptVersion !== DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION ||
      !row.cacheFingerprint.trim() ||
      !row.contentHash.trim() ||
      !(row.ocrText?.trim() || row.caption?.trim())
    ) {
      continue;
    }
    ready.set(row.attachmentId, row);
  }
  return ready;
}
