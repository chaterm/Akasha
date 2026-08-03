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
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
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
      targetSourcePageIds?: string[];
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

  async cancelRun(input: {
    workspaceId: string;
    runId: string;
    reason?: string;
  }) {
    const result = await this.runRepo.cancelRun(input);
    if (result.disposition === 'not_found') {
      throw new NotFoundException('Knowledge compilation Run not found.');
    }
    if (result.disposition === 'already_terminal') {
      return {
        disposition: result.disposition,
        runId: result.run.id,
        spaceId: result.run.spaceId,
        status: result.run.status,
        phase: result.run.phase,
        removedJobCount: 0,
        fencedActiveJobCount: 0,
        cleanupErrorCount: 0,
      };
    }

    // The PostgreSQL transaction has committed and invalidated every writer at
    // this point. Redis cleanup is an exact-ID traffic optimization only.
    const cleanup = await this.removeCancelledJobs(result.jobIds);
    return {
      disposition: result.disposition,
      runId: result.run.id,
      spaceId: result.run.spaceId,
      status: result.run.status,
      phase: result.run.phase,
      previousStatus: result.previousStatus,
      previousPhase: result.previousPhase,
      ...cleanup,
    };
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
    if (run.initializedAt) {
      return {
        initialized: false,
        run,
        aggregateRequired: run.aggregateRequired,
        pageCompilationRequired: run.expectedPageCount > run.skippedPageCount,
      };
    }
    const scope = { workspaceId: run.workspaceId, spaceId: run.spaceId };
    // A page-scoped Run compiles only its target pages; a full-Space Run
    // exports every page in the Space.
    const targetSourcePageIds = parseRunTargetSourcePageIds(
      run.targetSourcePageIds,
    );
    const sources = targetSourcePageIds
      ? await this.sourceExporter.exportPageSources({
          ...scope,
          sourcePageIds: targetSourcePageIds,
        })
      : await this.sourceExporter.exportSpaceSources(scope);
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
    // Removed-source detection compares the Space's known pages against the
    // exported set. It is only valid for a full-Space export; a page-scoped
    // Run exports a subset, so every non-target page would be misread as
    // removed and wrongly retired. Page-scoped Runs never retire sources.
    const removedSourcePageIds = targetSourcePageIds
      ? []
      : [
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
        overflowImageCount === 0 &&
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
    const aggregateRequired = !aggregateReusable;

    const initialized = await this.executionRepo.initializeRun(lease, {
      aggregateRequired,
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
      aggregateRequired,
      pageCompilationRequired,
    };
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
    await this.dispatchPending();
    return completed;
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.dispatchPendingSpaceSlices();
      await this.dispatchPendingRunImages();
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

  private async removeCancelledJobs(jobIds: string[]): Promise<{
    removedJobCount: number;
    fencedActiveJobCount: number;
    cleanupErrorCount: number;
  }> {
    let removedJobCount = 0;
    let fencedActiveJobCount = 0;
    let cleanupErrorCount = 0;
    for (const jobId of [...new Set(jobIds)]) {
      let found = false;
      for (const queue of [this.spaceQueue, this.imageQueue]) {
        try {
          const job = await queue.getJob(jobId);
          if (!job) continue;
          found = true;
          const state: string = await job.getState();
          if (state === 'active') {
            // BullMQ cannot remove a locked active Job. The committed Run
            // status/token fence makes its remaining publication a no-op.
            fencedActiveJobCount += 1;
          } else {
            await job.remove();
            removedJobCount += 1;
          }
          break;
        } catch {
          cleanupErrorCount += 1;
          this.logger.warn({
            event: 'knowledge_cancel_job_cleanup_failed',
            jobId,
          });
          break;
        }
      }
      // A missing retained Job is already clean. It is deliberately not an
      // error because Redis retention or a prior idempotent call may remove it.
      if (!found) continue;
    }
    return {
      removedJobCount,
      fencedActiveJobCount,
      cleanupErrorCount,
    };
  }
}

/**
 * Reads a Run's persisted page scope. Returns a non-empty string[] for a
 * page-scoped Run, or null for a full-Space Run.
 */
function parseRunTargetSourcePageIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === 'string');
  return ids.length > 0 ? ids : null;
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
