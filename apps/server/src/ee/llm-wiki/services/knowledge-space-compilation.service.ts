import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import {
  CurrentReadyKnowledgeImageExtraction,
  KnowledgeImageExtractionRepo,
} from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
  KNOWLEDGE_IMAGE_UNDERSTANDING_PROVIDER,
  KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import {
  buildEffectiveKnowledgeHash,
  ReadyKnowledgeImage,
} from './knowledge-effective-hash';
import { knowledgeImageJobOptions } from './knowledge-worker-settings';
import { KnowledgeSourceRetirementService } from './knowledge-source-retirement.service';
import { KnowledgeImageUnderstandingProvider } from './knowledge-image-understanding-provider.service';

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
    private readonly imageExtractionRepo: KnowledgeImageExtractionRepo,
    private readonly sourceExporter: KnowledgeSourceExporterService,
    @Inject(KNOWLEDGE_IMAGE_UNDERSTANDING_PROVIDER)
    private readonly imageProvider: KnowledgeImageUnderstandingProvider,
    executionRepo?: KnowledgeSpaceExecutionRepo,
    retirementService?: KnowledgeSourceRetirementService,
  ) {
    this.executionRepo = executionRepo;
    this.retirementService = retirementService;
  }

  private readonly executionRepo?: KnowledgeSpaceExecutionRepo;
  private readonly retirementService?: KnowledgeSourceRetirementService;

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

  async scheduleIncrementalCompileForPages(input: {
    workspaceId: string;
    sourcePageIds: string[];
    trigger: 'page_created' | 'page_updated';
  }) {
    return this.runRepo.scheduleIncrementalCompileForPages({
      ...input,
      quietPeriodMs: KNOWLEDGE_PAGE_COMPILE_QUIET_PERIOD_MS,
    });
  }

  async requestImmediateDelayedPageCompilation(input: {
    workspaceId: string;
    scheduleId: string;
    confirmationPageName: string;
  }) {
    const result =
      await this.runRepo.markDelayedPageForImmediateCompilation(input);
    if (result) {
      await this.dispatchPending();
    }
    return result;
  }

  async removeDelayedPageCompilation(input: {
    workspaceId: string;
    scheduleId: string;
    confirmationPageName: string;
  }) {
    return this.runRepo.removeDelayedPageCompilation(input);
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
        pageCompilationRequired:
          run.expectedPageCount >
          run.succeededPageCount + run.failedPageCount + run.skippedPageCount,
      };
    }
    const targetSourcePageIds = parseRunTargetSourcePageIds(
      run.targetSourcePageIds,
    );
    const initialized = await this.executionRepo.initializeRun(lease, {
      targetSourcePageIds,
    });
    if (!initialized) return undefined;
    return {
      ...initialized,
      aggregateRequired: initialized.run.aggregateRequired,
      pageCompilationRequired:
        initialized.run.expectedPageCount >
        initialized.run.succeededPageCount +
          initialized.run.failedPageCount +
          initialized.run.skippedPageCount,
    };
  }

  async bindLeasedRunPage(
    lease: SpaceExecutionLease,
    input: { sourcePageId: string },
  ) {
    if (!this.executionRepo) {
      throw new Error(
        'KnowledgeSpaceExecutionRepo is required for Space jobs.',
      );
    }
    const run = await this.executionRepo.findLeasedRun(lease);
    if (!run) return undefined;
    const scope = { workspaceId: run.workspaceId, spaceId: run.spaceId };
    const sources = await this.sourceExporter.exportPageSources({
      ...scope,
      sourcePageIds: [input.sourcePageId],
    });
    const source = sources.find(
      (candidate) => candidate.sourcePageId === input.sourcePageId,
    );
    if (!source) {
      const terminalized = await this.executionRepo.terminalizeUnboundTextPage(
        lease,
        {
          sourcePageId: input.sourcePageId,
          errorCode: 'source_unavailable',
          errorMessage: 'Knowledge source disappeared before snapshot binding.',
        },
      );
      if (terminalized && this.retirementService) {
        await this.retirementService.retireOutOfScopeSources({
          workspaceId: run.workspaceId,
          sourcePageIds: [input.sourcePageId],
        });
      }
      return terminalized ? { outcome: 'terminalized' as const } : undefined;
    }

    const expectedImages = source.images ?? [];
    const sourceImages = expectedImages.slice(0, 50);
    const overflowImageCount = Math.max(
      0,
      expectedImages.length - sourceImages.length,
    );
    const [candidate] = await this.compilationRepo.findSpaceReuseCandidates({
      ...scope,
      sourcePageIds: [source.sourcePageId],
    });
    const forcePageCompilation =
      run.mode === 'force_rebuild' ||
      run.trigger === 'page_retry' ||
      run.trigger === 'follow_up';
    // contentHash includes normalized image attachment identity/version/size.
    // Model and Prompt identity intentionally do not participate in automatic
    // reuse; force rebuild is the explicit quality-upgrade mechanism.
    const reusable =
      !forcePageCompilation &&
      overflowImageCount === 0 &&
      Boolean(candidate?.activeSourceId) &&
      Boolean(candidate?.activeSummaryId) &&
      Boolean(candidate?.activeSummaryChunkId) &&
      candidate?.lastSuccessfulSourceHash === source.contentHash &&
      candidate?.contributionSourceHash === source.contentHash;

    if (reusable) {
      const bound = await this.executionRepo.bindTextPage(lease, {
        sourcePageId: source.sourcePageId,
        expectedSourceVersion: source.sourceVersion,
        expectedSourceContentHash: source.contentHash,
        expectedImageCount: expectedImages.length,
        succeededImageCount: expectedImages.length,
        status: 'succeeded',
        imageStatus: expectedImages.length === 0 ? 'not_required' : 'succeeded',
        mergeStatus: expectedImages.length === 0 ? 'not_required' : 'succeeded',
        targetEffectiveKnowledgeHash:
          candidate?.lastSuccessfulEffectiveHash ?? source.contentHash,
        reused: true,
        images: [],
      });
      return bound ? { outcome: 'reused' as const, page: bound } : undefined;
    }

    const visionModel = await this.imageProvider.getCacheIdentity();
    const readyExtractions =
      await this.imageExtractionRepo.findCurrentReadyForSnapshotImages({
        ...scope,
        images: sourceImages.map((image) => ({
          sourcePageId: source.sourcePageId,
          attachmentId: image.attachmentId,
          attachmentVersion: image.attachmentVersion,
        })),
        model: visionModel,
        promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
      });
    const readyExtractionByAttachmentId = currentReadyExtractionMap(
      [source],
      readyExtractions,
      visionModel,
    );
    const readyImages = sourceImages.flatMap((image): ReadyKnowledgeImage[] => {
      const extraction = readyExtractionByAttachmentId.get(image.attachmentId);
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
    });
    const effectiveKnowledgeHash = buildEffectiveKnowledgeHash({
      sourceContentHash: source.contentHash,
      compilerVersion: run.compilerVersion,
      promptVersion: run.promptVersion,
      readyImages,
    });
    const allPlannedImagesReady = readyImages.length === sourceImages.length;
    const bound = await this.executionRepo.bindTextPage(lease, {
      sourcePageId: source.sourcePageId,
      expectedSourceVersion: source.sourceVersion,
      expectedSourceContentHash: source.contentHash,
      expectedImageCount: expectedImages.length,
      succeededImageCount: readyImages.length,
      skippedImageCount: overflowImageCount,
      status: 'pending',
      imageStatus:
        expectedImages.length === 0
          ? 'not_required'
          : allPlannedImagesReady
            ? overflowImageCount > 0
              ? 'partial'
              : 'succeeded'
            : 'pending',
      mergeStatus:
        expectedImages.length === 0
          ? 'not_required'
          : allPlannedImagesReady
            ? 'pending'
            : 'waiting_images',
      targetEffectiveKnowledgeHash: effectiveKnowledgeHash,
      qualityStatus: overflowImageCount > 0 ? 'partial_image' : 'normal',
      images: sourceImages.map((image, imageOrdinal) => {
        const ready = readyExtractionByAttachmentId.get(image.attachmentId);
        return {
          sourcePageId: source.sourcePageId,
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
    });
    return bound ? { outcome: 'bound' as const, page: bound } : undefined;
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
      await this.promoteDuePageSchedules();
      await this.dispatchPendingSpaceSlices();
      await this.dispatchPendingRunImages();
    } finally {
      this.dispatching = false;
    }
  }

  private async promoteDuePageSchedules(): Promise<void> {
    const batchSize = 500;
    // Bound a single polling pass while still absorbing ordinary bulk edits
    // without waiting for many five-second intervals.
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await this.runRepo.promoteDuePageCompileSchedules({
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        limit: batchSize,
      });
      if (result.selectedPageCount === 0) return;
      this.logger.log({
        event: 'knowledge_delayed_pages_promoted',
        selectedPageCount: result.selectedPageCount,
        promotedPageCount: result.promotedPageCount,
        runRequestCount: result.runRequestCount,
      });
      if (result.selectedPageCount < batchSize) return;
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
