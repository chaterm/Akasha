import { Queue } from 'bullmq';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeImageExtractionRepo } from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { buildEffectiveKnowledgeHash } from './knowledge-effective-hash';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

describe('KnowledgeSpaceCompilationService', () => {
  it('dispatches a DB-reserved Space slice and never fans out page jobs', async () => {
    const fixture = createService({
      reservationCandidates: [{ id: 'run-space' }],
      undispatchedSpaceSlices: [spaceSlice()],
    });

    await fixture.service.dispatchPending();

    expect(fixture.repo.reserveNextSpaceSlice).toHaveBeenCalledWith({
      runId: 'run-space',
    });
    expect(fixture.spaceQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT,
      expect.objectContaining({
        spaceRunId: 'run-space',
        phase: 'text',
        spaceJobSequence: 1,
      }),
      {
        jobId: 'knowledge-space-text__run-space__text__1',
        priority: 5,
      },
    );
    expect(fixture.repo.markSpaceSliceDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ spaceJobId: spaceSlice().spaceJobId }),
    );
  });

  it('gives image merge slices priority over newly queued text slices', async () => {
    const fixture = createService({
      undispatchedSpaceSlices: [
        {
          ...spaceSlice(),
          runId: 'run-image-merge',
          jobPhase: 'image_merge',
          spaceJobSequence: 3,
          spaceJobId:
            'knowledge-space-image-merge__run-image-merge__image_merge__3',
        },
      ],
    });

    await fixture.service.dispatchPending();

    expect(fixture.spaceQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES,
      expect.objectContaining({ phase: 'image_merge' }),
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('requests a queued run without exporter, catalog, image, or LLM planning', async () => {
    const fixture = createService();
    fixture.repo.requestRuns.mockResolvedValue([
      {
        disposition: 'created',
        run: { id: 'queued-run', status: 'queued', initializedAt: null },
      },
    ]);

    await expect(
      fixture.service.requestRuns([
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          trigger: 'manual_compile',
          scanRemovedSources: true,
        },
      ]),
    ).resolves.toEqual([expect.objectContaining({ disposition: 'created' })]);

    expect(fixture.repo.requestRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [expect.objectContaining({ spaceId: 'space-1' })],
      }),
    );
    expect(fixture.catalog.snapshot).not.toHaveBeenCalled();
    expect(fixture.sourceExporter.exportSpaceSources).not.toHaveBeenCalled();
    expect(fixture.imageQueue.add).not.toHaveBeenCalled();
  });

  it('routes page updates through the shared durable Run arbitration', async () => {
    const fixture = createService();
    fixture.repo.requestIncrementalCompileForPages.mockResolvedValue([
      { disposition: 'coalesced', run: { id: 'run-1' } },
    ]);

    await expect(
      fixture.service.requestIncrementalCompileForPages({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual([{ disposition: 'coalesced', run: { id: 'run-1' } }]);
    expect(fixture.repo.requestIncrementalCompileForPages).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
        removed: false,
      }),
    );
  });

  it('makes a confirmed delayed page due and immediately runs the dispatcher', async () => {
    const fixture = createService();
    fixture.repo.markDelayedPageForImmediateCompilation.mockResolvedValue({
      scheduleId: 'schedule-1',
      sourcePageId: 'page-1',
      spaceId: 'space-1',
      pageName: 'Page 1',
    });

    await expect(
      fixture.service.requestImmediateDelayedPageCompilation({
        workspaceId: 'workspace-1',
        scheduleId: 'schedule-1',
        confirmationPageName: 'Page 1',
      }),
    ).resolves.toEqual(expect.objectContaining({ scheduleId: 'schedule-1' }));

    expect(
      fixture.repo.markDelayedPageForImmediateCompilation,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      scheduleId: 'schedule-1',
      confirmationPageName: 'Page 1',
    });
    expect(fixture.repo.promoteDuePageCompileSchedules).toHaveBeenCalled();
  });

  it('does not dispatch when delayed-page confirmation fails', async () => {
    const fixture = createService();
    fixture.repo.markDelayedPageForImmediateCompilation.mockResolvedValue(null);

    await fixture.service.requestImmediateDelayedPageCompilation({
      workspaceId: 'workspace-1',
      scheduleId: 'schedule-1',
      confirmationPageName: 'wrong',
    });

    expect(fixture.repo.promoteDuePageCompileSchedules).not.toHaveBeenCalled();
  });

  it('initializes against the prior completed Run instead of its own queued placeholder', async () => {
    const source = sourceSnapshot();
    const fixture = createService({
      exportedSources: [source],
      reuseCandidates: [reuseCandidate(source)],
      latestAggregateRun: {
        id: 'prior-complete-run',
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        knowledgeGeneration: 4,
        currentKnowledgeGeneration: 4,
        catalogHash: 'sha256:catalog',
      },
      hasActiveOverview: true,
    });

    const result = await fixture.service.initializeLeasedRun(lease());

    expect(
      fixture.repo.findLatestCompletedRunForAggregateReuse,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      currentRunId: 'current-run',
    });
    expect(fixture.executionRepo.initializeRun).toHaveBeenCalledWith(
      lease(),
      expect.objectContaining({
        pages: [expect.objectContaining({ status: 'skipped' })],
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        aggregateRequired: false,
        pageCompilationRequired: false,
      }),
    );
  });

  it('resumes an initialized Run without repeating whole-Space planning', async () => {
    const fixture = createService();
    fixture.executionRepo.findLeasedRun.mockResolvedValue({
      id: 'current-run',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      initializedAt: new Date('2026-08-03T00:00:00.000Z'),
      aggregateRequired: false,
    });

    await expect(fixture.service.initializeLeasedRun(lease())).resolves.toEqual(
      expect.objectContaining({
        initialized: false,
        aggregateRequired: false,
        pageCompilationRequired: false,
      }),
    );

    expect(fixture.sourceExporter.exportSpaceSources).not.toHaveBeenCalled();
    expect(fixture.catalog.snapshot).not.toHaveBeenCalled();
    expect(fixture.catalog.aggregateFingerprint).not.toHaveBeenCalled();
    expect(fixture.executionRepo.initializeRun).not.toHaveBeenCalled();
  });

  it('compiles only target pages and never retires other sources for a page-scoped Run', async () => {
    const source = sourceSnapshot();
    const fixture = createService({
      exportedSources: [source],
      targetSourcePageIds: ['page-1'],
      // The Space still has other active pages; a page-scoped Run must not
      // treat them as removed just because it did not export them.
      activeSourcePageIds: ['page-1', 'other-page-a', 'other-page-b'],
    });

    const result = await fixture.service.initializeLeasedRun(lease());

    // Uses the page-scoped exporter, never the whole-Space exporter.
    expect(fixture.sourceExporter.exportPageSources).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      }),
    );
    expect(fixture.sourceExporter.exportSpaceSources).not.toHaveBeenCalled();
    // The other active pages are NOT retired as removed sources.
    const plan = fixture.executionRepo.initializeRun.mock.calls[0][1];
    expect(plan.removedSourcePageIds).toEqual([]);
    expect(plan.pages).toEqual([
      expect.objectContaining({ sourcePageId: 'page-1', status: 'pending' }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({ pageCompilationRequired: true }),
    );
  });

  it('recompiles an explicitly retried page instead of reusing its prior publication', async () => {
    const source = sourceSnapshot();
    const fixture = createService({
      exportedSources: [source],
      reuseCandidates: [reuseCandidate(source)],
      targetSourcePageIds: ['page-1'],
      trigger: 'page_retry',
    });

    const result = await fixture.service.initializeLeasedRun(lease());

    const plan = fixture.executionRepo.initializeRun.mock.calls[0][1];
    expect(plan.pages).toEqual([
      expect.objectContaining({ sourcePageId: 'page-1', status: 'pending' }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({ pageCompilationRequired: true }),
    );
  });

  it('never treats an image-overflow page as fully reusable and freezes only the first 50 images', async () => {
    const source = sourceSnapshotWithImages(60);
    const readyExtractions = source.images.slice(0, 50).map(readyExtraction);
    const readyImages = readyExtractions.map((row) => ({
      attachmentId: row.attachmentId,
      attachmentVersion: row.attachmentVersion!.toISOString(),
      cacheFingerprint: row.cacheFingerprint,
      contentHash: row.contentHash,
      ocrText: row.ocrText ?? '',
      caption: row.caption ?? '',
    }));
    const candidate = {
      ...reuseCandidate(source),
      lastSuccessfulEffectiveHash: buildEffectiveKnowledgeHash({
        sourceContentHash: source.contentHash,
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        readyImages,
      }),
    };
    const fixture = createService({
      exportedSources: [source],
      reuseCandidates: [candidate],
      readyExtractions,
    });

    const result = await fixture.service.initializeLeasedRun(lease());

    expect(fixture.executionRepo.initializeRun).toHaveBeenCalledWith(
      lease(),
      expect.objectContaining({
        pages: [
          expect.objectContaining({
            status: 'pending',
            expectedImageCount: 60,
            succeededImageCount: 50,
            skippedImageCount: 10,
            imageStatus: 'partial',
            mergeStatus: 'pending',
          }),
        ],
        images: expect.arrayContaining([
          expect.objectContaining({ imageOrdinal: 0, status: 'succeeded' }),
          expect.objectContaining({ imageOrdinal: 49, status: 'succeeded' }),
        ]),
      }),
    );
    const plan = fixture.executionRepo.initializeRun.mock.calls[0][1];
    expect(plan.images).toHaveLength(50);
    expect(plan.images.map((image) => image.imageOrdinal)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
    expect(result).toEqual(
      expect.objectContaining({ pageCompilationRequired: true }),
    );
  });
});

function createService(
  overrides: {
    reservationCandidates?: unknown[];
    undispatchedSpaceSlices?: unknown[];
    exportedSources?: ReturnType<typeof sourceSnapshot>[];
    reuseCandidates?: unknown[];
    readyExtractions?: unknown[];
    latestAggregateRun?: unknown;
    hasActiveOverview?: boolean;
    targetSourcePageIds?: string[] | null;
    activeSourcePageIds?: string[];
    trigger?: string;
  } = {},
) {
  const repo = {
    requestRuns: jest.fn().mockResolvedValue([]),
    requestIncrementalCompileForPages: jest.fn().mockResolvedValue([]),
    markDelayedPageForImmediateCompilation: jest.fn(),
    promoteDuePageCompileSchedules: jest.fn().mockResolvedValue({
      selectedPageCount: 0,
      promotedPageCount: 0,
      runRequestCount: 0,
    }),
    findLatestCompletedRunForAggregateReuse: jest
      .fn()
      .mockResolvedValue(overrides.latestAggregateRun),
    findSpaceSliceReservationCandidates: jest
      .fn()
      .mockResolvedValue(overrides.reservationCandidates ?? []),
    reserveNextSpaceSlice: jest.fn().mockResolvedValue(undefined),
    findUndispatchedSpaceSlices: jest
      .fn()
      .mockResolvedValue(overrides.undispatchedSpaceSlices ?? []),
    markSpaceSliceDispatched: jest.fn().mockResolvedValue(true),
    reserveRunImagesFairly: jest.fn().mockResolvedValue([]),
    findUndispatchedRunImages: jest.fn().mockResolvedValue([]),
    markRunImageDispatched: jest.fn().mockResolvedValue(true),
  };
  const spaceQueue = { add: jest.fn(), getJob: jest.fn() };
  const imageQueue = { add: jest.fn(), getJob: jest.fn() };
  const compilationRepo = {
    findSpaceReuseCandidates: jest
      .fn()
      .mockResolvedValue(overrides.reuseCandidates ?? []),
  };
  const catalog = {
    snapshot: jest.fn().mockResolvedValue({ entries: [] }),
    aggregateFingerprint: jest.fn().mockResolvedValue({
      hash: 'sha256:catalog',
      artifactCount: 1,
      truncated: false,
    }),
  };
  const sourceRepo = {
    findActiveSourcePageIdsBySpace: jest
      .fn()
      .mockResolvedValue(overrides.activeSourcePageIds ?? []),
  };
  const imageExtractionRepo = {
    findCurrentReadyForSnapshotImages: jest
      .fn()
      .mockResolvedValue(overrides.readyExtractions ?? []),
  };
  const capsuleRepo = {
    hasActiveSpaceOverview: jest
      .fn()
      .mockResolvedValue(overrides.hasActiveOverview ?? false),
  };
  const contributionRepo = {
    findSpaceSourcePageIds: jest.fn().mockResolvedValue([]),
    findRemainingSourcePageIdsForRemovedSources: jest
      .fn()
      .mockResolvedValue([]),
  };
  const sourceExporter = {
    exportSpaceSources: jest
      .fn()
      .mockResolvedValue(overrides.exportedSources ?? []),
    exportPageSources: jest
      .fn()
      .mockResolvedValue(overrides.exportedSources ?? []),
  };
  const executionRepo = {
    findLeasedRun: jest.fn().mockResolvedValue({
      id: 'current-run',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      targetSourcePageIds: overrides.targetSourcePageIds ?? null,
      trigger: overrides.trigger ?? 'page_update',
    }),
    initializeRun: jest.fn().mockResolvedValue({
      initialized: true,
      run: { id: 'current-run' },
    }),
  };
  const environmentService = {
    getAiVisionModel: jest.fn().mockReturnValue('vision-model'),
  };
  const service = new KnowledgeSpaceCompilationService(
    spaceQueue as unknown as Queue,
    imageQueue as unknown as Queue,
    repo as unknown as KnowledgeSpaceCompilationRepo,
    compilationRepo as unknown as KnowledgeCompilationRepo,
    catalog as unknown as KnowledgeArtifactCatalogService,
    sourceRepo as unknown as KnowledgeSourceRepo,
    imageExtractionRepo as unknown as KnowledgeImageExtractionRepo,
    capsuleRepo as unknown as KnowledgeCapsuleRepo,
    contributionRepo as unknown as KnowledgeArtifactContributionRepo,
    environmentService as unknown as EnvironmentService,
    sourceExporter as unknown as KnowledgeSourceExporterService,
    executionRepo as unknown as KnowledgeSpaceExecutionRepo,
  );
  return {
    service,
    repo,
    spaceQueue,
    imageQueue,
    catalog,
    sourceExporter,
    executionRepo,
    sourceRepo,
    contributionRepo,
  };
}

function lease(): SpaceExecutionLease {
  return {
    runId: 'current-run',
    knowledgeGeneration: 4,
    jobPhase: 'text',
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__current-run__text__1',
    executionToken: 'execution-token',
  };
}

function spaceSlice() {
  return {
    runId: 'run-space',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    knowledgeGeneration: 4,
    jobPhase: 'text',
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__run-space__text__1',
  };
}

function sourceSnapshot() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'sha256:page-1',
    title: 'Page one',
    text: 'Body',
    images: [],
    references: [],
  };
}

function sourceSnapshotWithImages(count: number) {
  return {
    ...sourceSnapshot(),
    images: Array.from({ length: count }, (_, index) => ({
      attachmentId: `attachment-${index + 1}`,
      fileName: `image-${index + 1}.png`,
      mimeType: 'image/png' as const,
      fileSize: 100,
      attachmentVersion: new Date(index + 1).toISOString(),
      altText: `Image ${index + 1}`,
    })),
  };
}

function readyExtraction(
  image: ReturnType<typeof sourceSnapshotWithImages>['images'][number],
) {
  const attachmentVersion = new Date(image.attachmentVersion);
  return {
    id: `extraction-${image.attachmentId}`,
    workspaceId: 'workspace-1',
    attachmentId: image.attachmentId,
    attachmentWorkspaceId: 'workspace-1',
    attachmentSpaceId: 'space-1',
    attachmentPageId: 'page-1',
    attachmentVersion,
    currentAttachmentVersion: attachmentVersion,
    status: 'ready',
    model: 'vision-model',
    promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
    cacheFingerprint: `cache-${image.attachmentId}`,
    contentHash: `sha256:${image.attachmentId}`,
    ocrText: `Text ${image.attachmentId}`,
    caption: '',
  };
}

function reuseCandidate(source: ReturnType<typeof sourceSnapshot>) {
  return {
    sourcePageId: source.sourcePageId,
    activeSourceId: 'source-1',
    activeSummaryId: 'summary-1',
    activeSummaryChunkId: 'summary-chunk-1',
    lastSuccessfulSourceVersion: source.sourceVersion,
    lastSuccessfulSourceHash: source.contentHash,
    contributionSourceVersion: source.sourceVersion,
    contributionSourceHash: source.contentHash,
    contributionCompilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
    contributionPromptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    lastSuccessfulEffectiveHash: buildEffectiveKnowledgeHash({
      sourceContentHash: source.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      readyImages: [],
    }),
  };
}
